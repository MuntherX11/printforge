// PrintForge slicer sidecar: a tiny HTTP wrapper around headless orca-slicer.
//
//   GET  /health                      -> { ok, orcaVersion, busy }
//   GET  /profiles/:kind/:name        -> bundled system preset JSON (404 if unknown)
//   POST /profiles/check              -> { ok, unresolved: [names], details }
//   POST /slice                       -> plate_1.gcode bytes (X-Plate-Files) | { error, exitCode, logTail }
//
// One job at a time; the scratch dir of a job is always removed afterwards.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildArgs, ArgsError, validateCopies } from './args.mjs';
import { flattenPreset, makeLookup, PresetError, PRESET_KINDS } from './flatten.mjs';
import { loadSystemIndex } from './system-index.mjs';

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_FILAMENTS = 16;
const LOG_TAIL_LINES = 60;

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/**
 * Confine a request path to the uploads directory. Only relative paths made
 * of plain segments are accepted: no absolute paths, no `..`, no backslashes.
 * @returns {string} the absolute path under `uploadsDir`
 */
export function resolveInputPath(uploadsDir, inputPath) {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    throw new HttpError(400, 'inputPath is required');
  }
  if (inputPath.includes('\0') || inputPath.includes('\\')) {
    throw new HttpError(400, 'inputPath contains forbidden characters');
  }
  if (path.posix.isAbsolute(inputPath) || path.win32.isAbsolute(inputPath)) {
    throw new HttpError(400, 'inputPath must be relative to the uploads directory');
  }
  const segments = inputPath.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new HttpError(400, 'inputPath must not contain empty, "." or ".." segments');
  }
  const root = path.resolve(uploadsDir);
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new HttpError(400, 'inputPath escapes the uploads directory');
  }
  if (resolved === root) throw new HttpError(400, 'inputPath must name a file');
  return resolved;
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

function isObject(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }

function presetFromBody(value, what) {
  if (!isObject(value)) throw new HttpError(400, `${what} must be an object`);
  // `raw` is the contract; `json` is accepted as an alias (the API's SlicerProfile column).
  const raw = value.raw ?? value.json;
  if (!isObject(raw)) throw new HttpError(400, `${what}.raw must be a preset object`);
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    if (typeof value.name === 'string' && value.name.length > 0) raw.name = value.name;
    else throw new HttpError(400, `${what}.raw.name is required`);
  }
  return { ...value, raw };
}

/** Validate and normalise a /slice request body. */
export function parseSliceRequest(body, uploadsDir) {
  if (!isObject(body)) throw new HttpError(400, 'body must be a JSON object');
  const { kind, copies } = body;
  if (kind !== 'stl' && kind !== '3mf') throw new HttpError(400, 'kind must be "stl" or "3mf"');
  try { validateCopies(copies); } catch (err) { throw new HttpError(400, err.message); }
  const inputPath = resolveInputPath(uploadsDir, body.inputPath);
  if (!Array.isArray(body.filaments) || body.filaments.length === 0) {
    throw new HttpError(400, 'filaments must be a non-empty array');
  }
  if (body.filaments.length > MAX_FILAMENTS) {
    throw new HttpError(400, `at most ${MAX_FILAMENTS} filaments are supported`);
  }
  const filaments = body.filaments.map((f, i) => {
    const { raw, density } = presetFromBody(f, `filaments[${i}]`);
    if (density !== undefined && typeof density !== 'string') {
      throw new HttpError(400, `filaments[${i}].density must be a string`);
    }
    return { raw, density };
  });
  const machine = body.machine === undefined ? null : presetFromBody(body.machine, 'machine').raw;
  const process_ = body.process === undefined ? null : presetFromBody(body.process, 'process').raw;
  if (kind === 'stl' && (!machine || !process_)) {
    throw new HttpError(400, 'stl slicing needs machine and process presets');
  }
  const siblings = Array.isArray(body.siblings)
    ? body.siblings.map((s, i) => presetFromBody(s, `siblings[${i}]`).raw)
    : [];
  return { kind, copies, inputPath, machine, process: process_, filaments, siblings };
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
      const args = buildArgs({
        kind: job.kind, inputPath: job.inputPath, copies: job.copies, profilePaths, outputDir, logFile,
      });
      log(`slice ${job.kind} x${job.copies} ${path.basename(job.inputPath)}`);
      const started = Date.now();
      const result = await runOrca({ orcaBin, args, timeoutMs, logFile, env: { TMPDIR: jobDir } });
      const elapsed = Date.now() - started;
      if (result.timedOut) {
        throw new HttpError(504, `orca-slicer exceeded ${timeoutMs} ms`, {
          exitCode: null, logTail: logTailOf(logFile),
        });
      }
      if (result.exitCode !== 0) {
        throw new HttpError(500, `orca-slicer exited with code ${result.exitCode}`, {
          exitCode: result.exitCode, logTail: logTailOf(logFile) || (result.stderr ?? '').trim(),
        });
      }
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
      return { gcode, plateFiles: plates.length };
    } finally {
      await fsp.rm(jobDir, { recursive: true, force: true });
    }
  }

  async function handleSlice(req, res) {
    if (busy) throw new HttpError(409, 'a slice job is already running');
    busy = true;
    try {
      const body = await readJsonBody(req);
      const job = parseSliceRequest(body, uploadsDir);
      const stat = await fsp.stat(job.inputPath).catch(() => null);
      if (!stat?.isFile()) throw new HttpError(400, 'inputPath does not exist');
      const { gcode, plateFiles } = await runJob(job);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': gcode.length,
        'X-Plate-Files': String(plateFiles),
      });
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
