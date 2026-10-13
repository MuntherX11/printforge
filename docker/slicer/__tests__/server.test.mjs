import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, resolveInputPath, parseSliceRequest, parseMixedRequest, HttpError, MAX_INPUTS } from '../server.mjs';
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
  await fsp.writeFile(path.join(uploadsDir, 'parts', 'cap v2.stl'), 'solid cap\nendsolid cap\n');
  await fsp.writeFile(path.join(uploadsDir, 'parts', 'dress.3mf'), 'PK not really a project');
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

// ---- mixed plates: { inputs: [...] } ----
const mixedBody = (inputs, extra = {}) => ({
  inputs,
  machine: { raw: userMachine() }, process: { raw: userProcess() },
  filaments: [{ raw: userFilament(), density: '1.25' }],
  ...extra,
});
const fishInput = (copies = 1) => ({ inputPath: 'parts/fish.stl', kind: 'stl', copies });
const projectInput = (copies = 1) => ({ inputPath: 'parts/dress.3mf', kind: '3mf', copies });

test('parseSliceRequest: the mixed shape is validated before any work is done', () => {
  const uploads = os.tmpdir();
  const ok = mixedBody([{ inputPath: 'a/x.stl', kind: 'stl', copies: 3 }, { inputPath: 'b/y.3mf', kind: '3mf', copies: 500 }]);
  const job = parseSliceRequest(ok, uploads);
  assert.equal(job.mixed, true);
  assert.deepEqual(job.inputs, [
    { kind: 'stl', copies: 3, inputPath: path.join(path.resolve(uploads), 'a', 'x.stl') },
    { kind: '3mf', copies: 500, inputPath: path.join(path.resolve(uploads), 'b', 'y.3mf') },
  ]);
  assert.equal(job.filaments.length, 1);
  assert.equal(parseSliceRequest({ ...ok, inputs: Array.from({ length: MAX_INPUTS }, () => ok.inputs[0]) }, uploads).inputs.length, MAX_INPUTS);
  const one = ok.inputs[0];
  const cases = [
    [{ ...ok, inputs: [] }, /between 1 and 24/],
    [{ ...ok, inputs: Array.from({ length: MAX_INPUTS + 1 }, () => one) }, /between 1 and 24/],
    [{ ...ok, inputs: 'x.stl' }, /between 1 and 24/],
    [{ ...ok, inputs: [null] }, /inputs\[0\] must be an object/],
    [{ ...ok, inputs: [one, { ...one, kind: 'obj' }] }, /inputs\[1\]\.kind/],
    [{ ...ok, inputs: [{ ...one, copies: 0 }] }, /inputs\[0\]: copies/],
    [{ ...ok, inputs: [{ ...one, copies: 501 }] }, /inputs\[0\]: copies/],
    [{ ...ok, inputs: [{ ...one, copies: 2.5 }] }, /inputs\[0\]: copies/],
    [{ ...ok, inputs: [one, { ...one, inputPath: '../secret.stl' }] }, /inputs\[1\]: inputPath/],
    [{ ...ok, inputs: [{ ...one, inputPath: '/etc/passwd' }] }, /inputs\[0\]: inputPath/],
    [{ ...ok, inputs: [{ kind: 'stl', copies: 1 }] }, /inputs\[0\]: inputPath is required/],
    [{ ...ok, filaments: [] }, /exactly one filament/],
    [{ ...ok, filaments: [ok.filaments[0], ok.filaments[0]] }, /exactly one filament/],
    [{ ...ok, filaments: [{ raw: userFilament(), density: 1.25 }] }, /density/],
    [{ ...ok, machine: undefined }, /machine and process/],
    [{ ...ok, process: undefined }, /machine and process/],
    [{ ...ok, machine: { raw: { inherits: 'x' } } }, /name/],
    [{ ...ok, kind: 'stl' }, /"kind" belongs inside inputs/],
    [{ ...ok, inputPath: 'x.stl' }, /"inputPath" belongs inside inputs/],
    [{ ...ok, copies: 2 }, /"copies" belongs inside inputs/],
  ];
  for (const [body, re] of cases) {
    assert.throws(() => parseMixedRequest(body, uploads), (err) => err instanceof HttpError && err.status === 400 && re.test(err.message), String(re));
  }
});

/** Model files and clone counts of a mixed slice command line. */
function loadedFiles(args) {
  const files = args.slice(0, args.indexOf('--load-settings'));
  const counts = argValue(args, '--clone-objects').split(',').map(Number);
  assert.equal(counts.length, files.length, 'one clone count per loaded file');
  return files.map((file, i) => ({ file, copies: counts[i] }));
}

/**
 * A stand-in for orca: `--export-stls` writes `exported` names into the export
 * dir; a slice writes plate_1.gcode with the labels Orca 2.4.2 gives, placing
 * at most `fit` copies of every file.
 */
const mixedRunner = ({ exported = ['obj_1_body.stl'], fit = Infinity, calls = [] } = {}) => async (opts) => {
  const { args } = opts;
  calls.push(opts);
  await fsp.writeFile(argValue(args, '--logfile'), 'log line\n');
  if (args.includes('--export-stls')) {
    assert.match(args[0], /dress\.3mf$/);
    for (const name of exported) await fsp.writeFile(path.join(argValue(args, '--export-stls'), name), `solid ${name}\nendsolid\n`);
    return { exitCode: 0, timedOut: false };
  }
  const lines = ['EXCLUDE_OBJECT_DEFINE NAME=Wipe_Tower_id_1000_copy_0 CENTER=1,1 POLYGON=[[0,0],[1,1]]'];
  let id = 0;
  for (const { file, copies } of loadedFiles(args)) {
    assert.ok(fs.existsSync(file), `${file} is in scratch`);
    const mangled = file.replace(/\\/g, '/').replace(/[ :]/g, '_');
    for (let n = 1; n <= Math.min(copies, fit); n += 1) {
      lines.push(`EXCLUDE_OBJECT_DEFINE NAME=${mangled}${copies === 1 ? '' : `_${n}`}_id_${id}_copy_0 CENTER=1,1 POLYGON=[[0,0],[1,1]]`);
      id += 1;
    }
  }
  await fsp.writeFile(path.join(argValue(args, '--outputdir'), 'plate_1.gcode'), `${lines.join('\n')}\nG28\n`);
  return { exitCode: 0, timedOut: false };
};

test('POST /slice mixed: stl inputs are loaded as in<k>_0.stl with one clone count each', async () => {
  const calls = [];
  runner = mixedRunner({ calls });
  const r = await post('/slice', mixedBody([fishInput(3), { inputPath: 'parts/cap v2.stl', kind: 'stl', copies: 1 }, fishInput(2)]));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(r.headers.get('x-plate-files'), '1');
  assert.deepEqual(JSON.parse(r.headers.get('x-input-units')), [3, 1, 2]);
  assert.match(await r.text(), /in1_0\.stl_id_3_copy_0/);
  assert.equal(calls.length, 1, 'no export run without a 3mf input');
  const files = loadedFiles(calls[0].args);
  assert.deepEqual(files.map((f) => path.basename(f.file)), ['in0_0.stl', 'in1_0.stl', 'in2_0.stl']);
  assert.deepEqual(files.map((f) => f.copies), [3, 1, 2]);
  assert.ok(files.every((f) => path.dirname(f.file).startsWith(scratchDir)), 'models are loaded from scratch, not uploads');
  assert.equal(argValue(calls[0].args, '--arrange'), '1');
  assert.equal(calls[0].timeoutMs, 1000);
  assert.ok(fs.existsSync(path.join(uploadsDir, 'parts', 'fish.stl')), 'the upload is copied, not moved');
  assert.deepEqual(scratchEntries(), []);
});

test('POST /slice mixed: a 3mf input is exported first and every STL it yields is cloned', async () => {
  const calls = [];
  runner = mixedRunner({ calls, exported: ['obj_10_cap.stl', 'obj_2_body.stl', 'ignored.txt'] });
  const r = await post('/slice', mixedBody([fishInput(4), projectInput(2), fishInput(1)]));
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.headers.get('x-input-units')), [4, 2, 1]);
  assert.equal(calls.length, 2);
  const [exportRun, sliceRun] = calls;
  assert.deepEqual(exportRun.args.slice(0, 2), [path.join(uploadsDir, 'parts', 'dress.3mf'), '--export-stls']);
  assert.equal(exportRun.args.length, 7, 'project, --export-stls dir, --debug 3, --logfile file');
  assert.ok(argValue(exportRun.args, '--export-stls').startsWith(scratchDir));
  assert.notEqual(argValue(exportRun.args, '--logfile'), argValue(sliceRun.args, '--logfile'));
  const files = loadedFiles(sliceRun.args);
  assert.deepEqual(files.map((f) => path.basename(f.file)), ['in0_0.stl', 'in1_0.stl', 'in1_1.stl', 'in2_0.stl']);
  assert.deepEqual(files.map((f) => f.copies), [4, 2, 2, 1]);
  assert.ok(sliceRun.args.every((a) => !a.endsWith('.3mf')), 'a 3mf is never a slice input');
  assert.deepEqual(scratchEntries(), []);
});

test('POST /slice mixed: X-Input-Units reports what was placed, not what was asked', async () => {
  runner = mixedRunner({ fit: 5 });
  const r = await post('/slice', mixedBody([fishInput(40), projectInput(3), fishInput(1)]));
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.headers.get('x-input-units')), [5, 3, 1]);
  runner = mixedRunner({ fit: 0 });
  const none = await post('/slice', mixedBody([fishInput(2), fishInput(2)]));
  assert.deepEqual(JSON.parse(none.headers.get('x-input-units')), [0, 0]);
});

test('POST /slice mixed: a project without objects is 400 "the project holds no objects"', async () => {
  const calls = [];
  runner = mixedRunner({ calls, exported: [] });
  const r = await post('/slice', mixedBody([fishInput(1), projectInput(1)]));
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error, 'the project holds no objects');
  assert.equal(body.input, 1);
  assert.equal(body.logTail, 'log line');
  assert.equal(calls.length, 1, 'no slice after a failed export');
  assert.deepEqual(scratchEntries(), []);
});

test('POST /slice mixed: a failing export is 500 with exitCode, logTail and the input index', async () => {
  runner = async ({ args }) => {
    await fsp.writeFile(argValue(args, '--logfile'), 'cannot read project\n');
    return { exitCode: -2, timedOut: false };
  };
  const r = await post('/slice', mixedBody([projectInput(1)]));
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: 'orca-slicer exited with code -2', exitCode: -2, logTail: 'cannot read project', input: 0 });
  assert.deepEqual(scratchEntries(), []);
});

test('POST /slice mixed: export and slice share one timeout budget', async () => {
  const calls = [];
  const inner = mixedRunner({ calls });
  runner = async (opts) => {
    if (opts.args.includes('--export-stls')) await new Promise((r) => setTimeout(r, 120));
    return inner(opts);
  };
  const ok = await post('/slice', mixedBody([projectInput(1), projectInput(1)]));
  assert.equal(ok.status, 200);
  assert.equal(calls[0].timeoutMs, 1000);
  assert.ok(calls[1].timeoutMs <= 900 && calls[1].timeoutMs > 0, `second run gets what is left (${calls[1].timeoutMs})`);
  assert.ok(calls[2].timeoutMs < calls[1].timeoutMs, 'and the slice gets less again');

  // An export that eats the whole budget: the slice is never started.
  calls.length = 0;
  runner = async (opts) => {
    await new Promise((r) => setTimeout(r, 1050));
    return inner(opts);
  };
  const late = await post('/slice', mixedBody([projectInput(1)]));
  assert.equal(late.status, 504);
  assert.match((await late.json()).error, /exceeded 1000 ms/);
  assert.equal(calls.length, 1);

  runner = async ({ args }) => {
    await fsp.writeFile(argValue(args, '--logfile'), 'still exporting\n');
    return { exitCode: null, timedOut: true };
  };
  const killed = await post('/slice', mixedBody([fishInput(1), projectInput(1)]));
  assert.equal(killed.status, 504);
  assert.deepEqual(await killed.json(), { error: 'orca-slicer exceeded 1000 ms', exitCode: null, logTail: 'still exporting', input: 1 });
  assert.deepEqual(scratchEntries(), []);
});

test('POST /slice mixed: bad shapes, traversal and missing files are 400 before orca runs', async () => {
  let ran = 0;
  runner = async () => { ran += 1; return { exitCode: 0, timedOut: false }; };
  const bodies = [
    mixedBody([]),
    mixedBody([fishInput(0)]),
    mixedBody([fishInput(1), { inputPath: '../secret.stl', kind: 'stl', copies: 1 }]),
    mixedBody([fishInput(1), { inputPath: 'parts/nope.stl', kind: 'stl', copies: 1 }]),
    mixedBody([fishInput(1), { inputPath: 'parts', kind: 'stl', copies: 1 }]),
    mixedBody([fishInput(1)], { filaments: [] }),
    mixedBody([fishInput(1)], { machine: undefined }),
    mixedBody([fishInput(1)], { kind: 'stl', copies: 1, inputPath: 'parts/fish.stl' }),
  ];
  for (const body of bodies) {
    const r = await post('/slice', body);
    assert.equal(r.status, 400, JSON.stringify(body.inputs));
    assert.equal(typeof (await r.json()).error, 'string');
  }
  const missing = await (await post('/slice', mixedBody([fishInput(1), { inputPath: 'parts/nope.stl', kind: 'stl', copies: 1 }]))).json();
  assert.deepEqual(missing, { error: 'inputs[1]: inputPath does not exist', exitCode: null, logTail: '', input: 1 });
  assert.equal(ran, 0);
  assert.deepEqual(scratchEntries(), []);
});

test('POST /slice mixed: slice failure and "no plate" behave like the single shape', async () => {
  runner = async ({ args }) => {
    await fsp.writeFile(argValue(args, '--logfile'), 'boom\n');
    return { exitCode: 3, timedOut: false };
  };
  const failed = await post('/slice', mixedBody([fishInput(2)]));
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: 'orca-slicer exited with code 3', exitCode: 3, logTail: 'boom' });
  runner = async () => ({ exitCode: 0, timedOut: false });
  const empty = await post('/slice', mixedBody([fishInput(2)]));
  assert.equal(empty.status, 500);
  assert.match((await empty.json()).error, /no plate/);
  assert.deepEqual(scratchEntries(), []);
});

test('POST /slice: the single shape sends no X-Input-Units and still holds the lock alone', async () => {
  runner = writingRunner(1);
  const single = await post('/slice', sliceBody());
  assert.equal(single.status, 200);
  assert.equal(single.headers.get('x-input-units'), null);

  let release;
  const inner = mixedRunner();
  runner = (opts) => new Promise((resolve) => { release = () => inner(opts).then(resolve); });
  const first = post('/slice', mixedBody([fishInput(2)]));
  while (!release) await new Promise((r) => setTimeout(r, 5));
  assert.equal((await post('/slice', sliceBody())).status, 409);
  assert.equal((await post('/slice', mixedBody([fishInput(1)]))).status, 409);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await (await fetch(`${baseUrl}/health`)).json()).busy, false);
  assert.deepEqual(scratchEntries(), []);
});
