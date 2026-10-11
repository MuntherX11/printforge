import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, resolveInputPath, parseSliceRequest, HttpError } from '../server.mjs';
import { PROFILES_DIR, userMachine, userProcess, userFilament } from './helpers.mjs';

// ---- resolveInputPath (pure) ----
test('resolveInputPath confines to the uploads dir', () => {
  const uploads = path.join(os.tmpdir(), 'pf-uploads');
  assert.equal(resolveInputPath(uploads, 'parts/fish.stl'), path.join(path.resolve(uploads), 'parts', 'fish.stl'));
  for (const bad of ['../etc/passwd', 'a/../../x', '/etc/passwd', 'C:\\Windows\\x', 'a\\b', '', 'a//b', './a', 'a/./b', 'a\0b', 42, undefined]) {
    assert.throws(() => resolveInputPath(uploads, bad), (err) => err instanceof HttpError && err.status === 400, String(bad));
  }
});

test('parseSliceRequest validates shape before any work is done', () => {
  const uploads = os.tmpdir();
  const ok = { kind: 'stl', copies: 2, inputPath: 'x.stl', machine: { raw: userMachine() }, process: { raw: userProcess() }, filaments: [{ raw: userFilament(), density: '1.25' }] };
  assert.equal(parseSliceRequest(ok, uploads).copies, 2);
  const cases = [
    [{ ...ok, kind: 'obj' }, /kind/],
    [{ ...ok, copies: 0 }, /copies/],
    [{ ...ok, filaments: [] }, /filaments/],
    [{ ...ok, filaments: [{ raw: userFilament(), density: 1.25 }] }, /density/],
    [{ ...ok, machine: undefined }, /machine and process/],
    [{ ...ok, machine: { raw: { inherits: 'x' } } }, /name/],
  ];
  for (const [body, re] of cases) assert.throws(() => parseSliceRequest(body, uploads), re);
  assert.equal(parseSliceRequest({ ...ok, kind: '3mf', machine: undefined, process: undefined }, uploads).machine, null);
});

// ---- HTTP behaviour with an injected runner ----
let uploadsDir; let scratchDir; let server; let baseUrl;
let runner = async () => ({ exitCode: 0, timedOut: false });

function argValue(args, flag) { return args[args.indexOf(flag) + 1]; }

/** A runner that writes `plates` plate files into --outputdir. */
const writingRunner = (plates = 1) => async ({ args }) => {
  const out = argValue(args, '--outputdir');
  assert.ok(fs.existsSync(argValue(args, '--load-settings').split(';')[0]), 'machine.json written');
  for (let i = 1; i <= plates; i += 1) {
    await fsp.writeFile(path.join(out, `plate_${i}.gcode`), `; plate ${i}\nG28\n`);
  }
  await fsp.writeFile(argValue(args, '--logfile'), 'line1\nline2\n');
  return { exitCode: 0, timedOut: false };
};

before(async () => {
  uploadsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pf-uploads-'));
  scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pf-scratch-'));
  await fsp.mkdir(path.join(uploadsDir, 'parts'));
  await fsp.writeFile(path.join(uploadsDir, 'parts', 'fish.stl'), 'solid fish\nendsolid fish\n');
  const app = createApp({
    uploadsDir, scratchDir, profilesDir: PROFILES_DIR, orcaBin: '/opt/orca/AppRun', timeoutMs: 1000,
    orcaVersion: 'test', log: () => {}, runOrca: (opts) => runner(opts),
  });
  server = http.createServer((req, res) => { app(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await fsp.rm(uploadsDir, { recursive: true, force: true });
  await fsp.rm(scratchDir, { recursive: true, force: true });
});

const sliceBody = (extra = {}) => ({
  kind: 'stl', copies: 3, inputPath: 'parts/fish.stl',
  machine: { raw: userMachine() }, process: { raw: userProcess() },
  filaments: [{ raw: userFilament(), density: '1.25' }],
  ...extra,
});
const post = (p, body) => fetch(baseUrl + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const scratchEntries = () => fs.readdirSync(scratchDir);

test('GET /health', async () => {
  const r = await fetch(`${baseUrl}/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, orcaVersion: 'test', busy: false });
});

test('GET /profiles/:kind/:name serves bundled presets, 404 otherwise', async () => {
  const r = await fetch(`${baseUrl}/profiles/filament/${encodeURIComponent('eSUN PLA+ @base')}`);
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).filament_density, ['1.25']);
  assert.equal((await fetch(`${baseUrl}/profiles/filament/nope`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/profiles/bogus/nope`)).status, 404);
});

test('POST /profiles/check reports unresolved chains by name', async () => {
  const r = await post('/profiles/check', { presets: [
    { kind: 'filament', name: 'eSUN PLA+ Multi', json: userFilament() }, // WP3 shape: name + json
    { kind: 'process', raw: { name: 'lonely', inherits: 'missing parent' } },
    { kind: 'machine', raw: { name: 'child', inherits: 'mid' } },
    { kind: 'machine', raw: { name: 'mid', inherits: 'Creality Hi 0.4 nozzle' } },
  ] });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, false);
  assert.deepEqual(body.unresolved, ['lonely']);
  assert.equal(body.details[0].missing, 'missing parent');
});

test('POST /slice returns plate_1.gcode with X-Plate-Files and cleans scratch', async () => {
  runner = writingRunner(2);
  const r = await post('/slice', sliceBody());
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(r.headers.get('x-plate-files'), '2');
  assert.equal(await r.text(), '; plate 1\nG28\n');
  assert.deepEqual(scratchEntries(), []);
});

test('POST /slice passes flattened profiles and the confined input path to the runner', async () => {
  let seen;
  runner = async (opts) => { seen = opts; return writingRunner(1)(opts); };
  await post('/slice', sliceBody({ copies: 7 }));
  assert.equal(seen.args[0], path.join(uploadsDir, 'parts', 'fish.stl'));
  assert.equal(argValue(seen.args, '--clone-objects'), '7');
  assert.equal(seen.orcaBin, '/opt/orca/AppRun');
  assert.equal(seen.timeoutMs, 1000);
});

test('POST /slice: path traversal and missing files are 400', async () => {
  runner = writingRunner(1);
  for (const inputPath of ['../secret.stl', '/etc/passwd', 'parts/nope.stl']) {
    const r = await post('/slice', sliceBody({ inputPath }));
    assert.equal(r.status, 400, inputPath);
  }
  assert.deepEqual(scratchEntries(), []);
});

test('POST /slice: an unresolvable chain is 400 and names the parent', async () => {
  runner = writingRunner(1);
  const r = await post('/slice', sliceBody({ process: { raw: { name: 'p', inherits: 'ghost' } } }));
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.parent, 'ghost');
  assert.deepEqual(scratchEntries(), []);
});

test('POST /slice: orca failure is 500 with exitCode and logTail; scratch removed', async () => {
  runner = async ({ args }) => {
    await fsp.writeFile(argValue(args, '--logfile'), Array.from({ length: 80 }, (_, i) => `l${i}`).join('\n'));
    return { exitCode: 3, timedOut: false };
  };
  const r = await post('/slice', sliceBody());
  assert.equal(r.status, 500);
  const body = await r.json();
  assert.equal(body.exitCode, 3);
  assert.equal(body.logTail.split('\n').length, 60);
  assert.equal(body.logTail.split('\n')[0], 'l20');
  assert.deepEqual(scratchEntries(), []);
});

test('POST /slice: timeout is 504 and scratch removed', async () => {
  runner = async ({ args }) => {
    await fsp.writeFile(argValue(args, '--logfile'), 'still going\n');
    return { exitCode: null, timedOut: true };
  };
  const r = await post('/slice', sliceBody());
  assert.equal(r.status, 504);
  const body = await r.json();
  assert.equal(body.exitCode, null);
  assert.equal(body.logTail, 'still going');
  assert.deepEqual(scratchEntries(), []);
});

test('POST /slice: no plate produced is 500', async () => {
  runner = async () => ({ exitCode: 0, timedOut: false });
  const r = await post('/slice', sliceBody());
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /no plate/);
});

test('POST /slice: a second job while busy is 409, lock released afterwards', async () => {
  let release;
  runner = (opts) => new Promise((resolve) => { release = () => writingRunner(1)(opts).then(resolve); });
  const first = post('/slice', sliceBody());
  while (!release) await new Promise((r) => setTimeout(r, 5));
  const second = await post('/slice', sliceBody());
  assert.equal(second.status, 409);
  assert.equal((await (await fetch(`${baseUrl}/health`)).json()).busy, true);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await (await fetch(`${baseUrl}/health`)).json()).busy, false);
  runner = writingRunner(1);
  assert.equal((await post('/slice', sliceBody())).status, 200);
  assert.deepEqual(scratchEntries(), []);
});
