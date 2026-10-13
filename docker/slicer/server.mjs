// PrintForge slicer sidecar: a tiny HTTP wrapper around headless orca-slicer.
//
//   GET  /health                      -> { ok, orcaVersion, busy }
//   GET  /profiles/:kind?q=&limit=    -> { presets: [{ name, vendor }] } bundled presets a user can pick
//   GET  /profiles/:kind/:name        -> bundled system preset JSON (404 if unknown)
//   POST /profiles/check              -> { ok, unresolved: [names], details }
//   POST /slice                       -> plate_1.gcode bytes (X-Plate-Files) | { error, exitCode, logTail }
//        one model:   { inputPath, kind, copies, machine?, process?, filaments, siblings? }
//        mixed plate: { inputs: [{ inputPath, kind, copies }], machine, process, filaments: [one], siblings? }
//                     -> also X-Input-Units: [units actually placed per input] (JSON)
//
// A mixed plate loads every input as `in<k>_<j>.stl` from the job's scratch dir (a 3MF
// input is first unpacked with --export-stls, its own orca run inside the same timeout).
// One job at a time; the scratch dir of a job is always removed afterwards.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildArgs, buildMixedArgs, buildExportArgs, ArgsError, MAX_MIXED_FILES } from './args.mjs';
import { scratchName, countInputUnits, exportedStls } from './labels.mjs';
import { flattenPreset, makeLookup, PresetError, PRESET_KINDS } from './flatten.mjs';
import { loadSystemIndex } from './system-index.mjs';
import { HttpError, presetFromBody, parseSliceRequest } from './request.mjs';

export { HttpError, resolveInputPath, parseSliceRequest, parseMixedRequest, MAX_INPUTS } from './request.mjs';

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const LOG_TAIL_LINES = 60;
const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;

/** `limit` query value -> 1..200; 50 when absent or not a positive integer. */
export function parseListLimit(value) {
  if (value === null || value === undefined || !/^\d+$/.test(String(value))) return LIST_DEFAULT_LIMIT;
  const n = Number(value);
  if (n < 1) return LIST_DEFAULT_LIMIT;
  return Math.min(n, LIST_MAX_LIMIT);
}

export function logTailOf(logFile, lines = LOG_TAIL_LINES) {
  try {
    const text = fs.readFileSync(logFile, 'utf8');
    return text.split(/\r?\n/).filter((l) => l.length > 0).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** Run orca-slicer under xvfb; kills the whole process group on timeout. */
export function defaultRunOrca({ orcaBin, args, timeoutMs, logFile, env }) {
  return new Promise((resolve) => {
    const child = spawn('xvfb-run', ['-a', orcaBin, ...args], {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stderr = '';
    child.stderr.on('data', (d) => { if (stderr.length < 64 * 1024) stderr += d; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut, stderr: `${stderr}\n${err.message}`, logFile });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal, timedOut, stderr, logFile });
    });
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length });
  res.end(data);
}

/**
 * Build the request handler. Every dependency is injectable for tests.
 */
/**
 * Flatten a job's presets and pair them up the way the CLI checks them:
 *
 *   machine  ── name ──▶ process.compatible_printers = [machine.name]   (else exit -17)
 *   filament.compatible_printers = []                                    (any printer)
 *
 * A 3MF job carries its own machine and process, so only the filaments are returned.
 */
export function buildProfiles(job, index) {
  const flat = (kind, raw, siblings, options) =>
    flattenPreset(raw, makeLookup(siblings, index.forKind(kind)), options);
  const siblings = job.siblings ?? [];
  const out = { filaments: [] };
  if (job.machine) out.machine = flat('machine', job.machine, siblings, {});
  if (job.process) {
    out.process = flat('process', job.process, siblings,
      out.machine ? { compatiblePrinters: [out.machine.name] } : {});
  }
  const filamentSiblings = [...siblings, ...job.filaments.map((f) => f.raw)];
  for (const { raw, density } of job.filaments) {
    const options = { compatiblePrinters: [] };
    if (density !== undefined) options.density = density;
    out.filaments.push(flat('filament', raw, filamentSiblings.filter((s) => s !== raw), options));
  }
  return out;
}

export function createApp(deps) {
  const {
    uploadsDir, scratchDir, orcaBin, timeoutMs,
    orcaVersion = 'unknown',
    runOrca = defaultRunOrca,
    index = loadSystemIndex(deps.profilesDir),
    log = (msg) => process.stderr.write(`${new Date().toISOString()} ${msg}\n`),
  } = deps;
  let busy = false;

  function flattenWith(kind, raw, siblings, density) {
    const lookup = makeLookup(siblings, index.forKind(kind));
    return flattenPreset(raw, lookup, density === undefined ? {} : { density });
  }

  async function handleProfileGet(res, kind, name) {
    if (!PRESET_KINDS.includes(kind)) throw new HttpError(404, 'unknown preset kind');
    const raw = index.lookup(kind, name);
    if (!raw) throw new HttpError(404, `no bundled ${kind} preset named "${name}"`);
    sendJson(res, 200, raw);
  }

  function handleProfileList(res, kind, query) {
    if (!PRESET_KINDS.includes(kind)) throw new HttpError(404, 'unknown preset kind');
    const presets = index.list(kind, { q: query.get('q') ?? '', limit: parseListLimit(query.get('limit')) });
    sendJson(res, 200, { presets });
  }

  async function handleProfilesCheck(req, res) {
    const body = await readJsonBody(req);
    if (!Array.isArray(body.presets)) throw new HttpError(400, 'presets must be an array');
    const presets = body.presets.map((p, i) => {
      const preset = presetFromBody(p, `presets[${i}]`);
      if (!PRESET_KINDS.includes(preset.kind)) throw new HttpError(400, `presets[${i}].kind is invalid`);
      return preset;
    });
    const details = [];
    for (const p of presets) {
      const siblings = presets.filter((s) => s.kind === p.kind && s !== p).map((s) => s.raw);
      try {
        flattenWith(p.kind, p.raw, siblings);
      } catch (err) {
        details.push({
          name: p.raw.name, kind: p.kind,
          code: err instanceof PresetError ? err.code : 'ERROR',
          missing: err instanceof PresetError ? err.parent : undefined,
          error: err.message,
        });
      }
    }
    sendJson(res, 200, { ok: details.length === 0, unresolved: details.map((d) => d.name), details });
  }

  async function runJob(job) {
    const jobDir = await fsp.mkdtemp(path.join(scratchDir, 'job-'));
    const logFile = path.join(jobDir, 'orca.log');
    try {
      const outputDir = path.join(jobDir, 'out');
      await fsp.mkdir(outputDir);
      const writePreset = async (file, preset) => {
        const target = path.join(jobDir, file);
        await fsp.writeFile(target, JSON.stringify(preset, null, 1));
        return target;
      };
      const profiles = buildProfiles(job, index);
      const profilePaths = { filaments: [] };
      if (profiles.machine) profilePaths.machine = await writePreset('machine.json', profiles.machine);
      if (profiles.process) profilePaths.process = await writePreset('process.json', profiles.process);
      for (let i = 0; i < profiles.filaments.length; i += 1) {
        profilePaths.filaments.push(await writePreset(`filament_${i}.json`, profiles.filaments[i]));
      }
      // Every orca run of a job draws on one budget: the first gets all of
      // `timeoutMs`, a later one what the earlier runs left.
      let spentMs = 0;
      const run = async (args, runLog, extra = {}) => {
        const left = timeoutMs - spentMs;
        const timeout = () => new HttpError(504, `orca-slicer exceeded ${timeoutMs} ms`, {
          exitCode: null, logTail: logTailOf(runLog), ...extra,
        });
        if (left <= 0) throw timeout();
        const began = Date.now();
        const result = await runOrca({ orcaBin, args, timeoutMs: left, logFile: runLog, env: { TMPDIR: jobDir } });
        spentMs += Date.now() - began;
        if (result.timedOut) throw timeout();
        if (result.exitCode !== 0) {
          throw new HttpError(500, `orca-slicer exited with code ${result.exitCode}`, {
            exitCode: result.exitCode, logTail: logTailOf(runLog) || (result.stderr ?? '').trim(), ...extra,
          });
        }
        return result;
      };
      let args;
      let objectCounts = [];
      if (job.mixed) {
        const files = await prepareMixedInputs(job, jobDir, run);
        objectCounts = job.inputs.map((_, k) => files.filter((f) => f.input === k).length);
        args = buildMixedArgs({ files, profilePaths, outputDir, logFile });
        log(`slice mixed: ${job.inputs.length} input(s), ${files.length} file(s), copies ${files.map((f) => f.copies).join(',')}`);
      } else {
        args = buildArgs({
          kind: job.kind, inputPath: job.inputPath, copies: job.copies, profilePaths, outputDir, logFile,
        });
        log(`slice ${job.kind} x${job.copies} ${path.basename(job.inputPath)}`);
      }
      const started = Date.now();
      const result = await run(args, logFile);
      const elapsed = Date.now() - started;
      const plates = (await fsp.readdir(outputDir))
        .filter((f) => /^plate_\d+\.gcode$/.test(f)).sort();
      if (plates.length === 0) {
        throw new HttpError(500, 'orca-slicer produced no plate_*.gcode', {
          exitCode: result.exitCode, logTail: logTailOf(logFile),
        });
      }
      const first = plates.includes('plate_1.gcode') ? 'plate_1.gcode' : plates[0];
      const gcode = await fsp.readFile(path.join(outputDir, first));
      log(`slice done in ${elapsed} ms: ${plates.length} plate file(s), ${gcode.length} bytes`);
      const inputUnits = job.mixed
        ? countInputUnits(gcode.toString('latin1'), job.inputs.length, objectCounts)
        : undefined;
      return { gcode, plateFiles: plates.length, inputUnits };
    } finally {
      await fsp.rm(jobDir, { recursive: true, force: true });
    }
  }

  /**
   * Place every model of a mixed job in the scratch dir as `in<k>_<j>.stl`.
   * An STL is copied; a 3MF is unpacked with --export-stls (one orca run each)
   * and every STL it yields is loaded with that input's copy count.
   * @returns {Promise<{path: string, copies: number}[]>} files in load order
   */
  async function prepareMixedInputs(job, jobDir, run) {
    const files = [];
    for (let k = 0; k < job.inputs.length; k += 1) {
      const input = job.inputs[k];
      let sources = [input.inputPath];
      if (input.kind === '3mf') {
        const exportDir = path.join(jobDir, `export_${k}`);
        const exportLog = path.join(jobDir, `export_${k}.log`);
        await fsp.mkdir(exportDir);
        log(`export stls of inputs[${k}] ${path.basename(input.inputPath)}`);
        await run(buildExportArgs({ inputPath: input.inputPath, exportDir, logFile: exportLog }), exportLog, { input: k });
        sources = exportedStls(await fsp.readdir(exportDir)).map((name) => path.join(exportDir, name));
        if (sources.length === 0) {
          throw new HttpError(400, 'the project holds no objects', { input: k, logTail: logTailOf(exportLog) });
        }
      }
      if (files.length + sources.length > MAX_MIXED_FILES) {
        throw new HttpError(400, `the plate would load more than ${MAX_MIXED_FILES} model files`, { input: k });
      }
      for (let j = 0; j < sources.length; j += 1) {
        const target = path.join(jobDir, scratchName(k, j));
        if (input.kind === '3mf') await fsp.rename(sources[j], target);
        else await fsp.copyFile(sources[j], target, fs.constants.COPYFILE_FICLONE);
        files.push({ path: target, copies: input.copies, input: k });
      }
    }
    return files;
  }

  async function handleSlice(req, res) {
    if (busy) throw new HttpError(409, 'a slice job is already running');
    busy = true;
    try {
      const body = await readJsonBody(req);
      const job = parseSliceRequest(body, uploadsDir);
      const isFile = async (p) => (await fsp.stat(p).catch(() => null))?.isFile() === true;
      if (job.mixed) {
        for (let k = 0; k < job.inputs.length; k += 1) {
          if (!(await isFile(job.inputs[k].inputPath))) {
            throw new HttpError(400, `inputs[${k}]: inputPath does not exist`, { input: k });
          }
        }
      } else if (!(await isFile(job.inputPath))) {
        throw new HttpError(400, 'inputPath does not exist');
      }
      const { gcode, plateFiles, inputUnits } = await runJob(job);
      const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': gcode.length,
        'X-Plate-Files': String(plateFiles),
      };
      if (inputUnits) headers['X-Input-Units'] = JSON.stringify(inputUnits);
      res.writeHead(200, headers);
      res.end(gcode);
    } finally {
      busy = false;
    }
  }

  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    try {
      if (req.method === 'GET' && parts.length === 1 && parts[0] === 'health') {
        sendJson(res, 200, { ok: true, orcaVersion, busy });
      } else if (req.method === 'GET' && parts.length === 2 && parts[0] === 'profiles') {
        handleProfileList(res, parts[1], url.searchParams);
      } else if (req.method === 'GET' && parts.length === 3 && parts[0] === 'profiles') {
        await handleProfileGet(res, parts[1], parts[2]);
      } else if (req.method === 'POST' && parts.length === 2 && parts[0] === 'profiles' && parts[1] === 'check') {
        await handleProfilesCheck(req, res);
      } else if (req.method === 'POST' && parts.length === 1 && parts[0] === 'slice') {
        await handleSlice(req, res);
      } else {
        throw new HttpError(404, 'not found');
      }
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message, exitCode: null, logTail: '', ...err.extra });
      } else if (err instanceof PresetError || err instanceof ArgsError) {
        sendJson(res, 400, { error: err.message, code: err.code, preset: err.preset, parent: err.parent, exitCode: null, logTail: '' });
      } else {
        log(`unhandled: ${err?.stack ?? err}`);
        sendJson(res, 500, { error: 'internal error', exitCode: null, logTail: '' });
      }
    }
  };
}

export function configFromEnv(env = process.env) {
  return {
    port: Number(env.PORT ?? 7788),
    timeoutMs: Number(env.SLICE_TIMEOUT_MS ?? 300000),
    uploadsDir: env.UPLOADS_DIR ?? '/uploads',
    scratchDir: env.SCRATCH_DIR ?? '/scratch',
    orcaBin: env.ORCA_BIN ?? '/opt/orca/squashfs-root/AppRun',
    profilesDir: env.ORCA_PROFILES_DIR ?? '/opt/orca/squashfs-root/resources/profiles',
    orcaVersion: env.ORCA_VERSION ?? 'unknown',
  };
}

function main() {
  const cfg = configFromEnv();
  fs.mkdirSync(cfg.scratchDir, { recursive: true });
  const app = createApp(cfg);
  const server = http.createServer((req, res) => { app(req, res); });
  server.listen(cfg.port, '0.0.0.0', () => {
    process.stderr.write(`slicer sidecar listening on :${cfg.port} (orca ${cfg.orcaVersion}, timeout ${cfg.timeoutMs} ms)\n`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
