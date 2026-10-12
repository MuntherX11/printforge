import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import { createApp, parseListLimit, buildProfiles } from '../server.mjs';
import { loadSystemIndex } from '../system-index.mjs';
import { PROFILES_DIR, userMachine } from './helpers.mjs';

const index = loadSystemIndex(PROFILES_DIR);

test('list: only instantiable presets of the kind, sorted, with their vendor', () => {
  assert.deepEqual(index.list('filament'), [{ name: 'eSUN PLA+ @System', vendor: 'OrcaFilamentLibrary' }]);
  assert.deepEqual(index.list('machine'), [{ name: 'Creality Hi 0.4 nozzle', vendor: 'Creality' }]);
  assert.deepEqual(index.list('process'), [{ name: '0.20mm Standard @Creality Hi', vendor: 'Creality' }]);
  assert.deepEqual(index.list('bogus'), []);
});

test('list: abstract presets never show, even when the query names them', () => {
  assert.deepEqual(index.list('filament', { q: 'fdm_' }), []);
  assert.deepEqual(index.list('filament', { q: '@base' }), []);
  assert.deepEqual(index.list('machine', { q: 'common' }), []);
});

test('list: q is a case-insensitive substring; limit caps the result', () => {
  assert.deepEqual(index.list('filament', { q: 'esun pla+' }).map((p) => p.name), ['eSUN PLA+ @System']);
  assert.deepEqual(index.list('filament', { q: '  SYSTEM ' }).map((p) => p.name), ['eSUN PLA+ @System']);
  assert.deepEqual(index.list('filament', { q: 'petg' }), []);
  assert.deepEqual(index.list('filament', { limit: 0 }), []);
});

test('parseListLimit: default 50, max 200, junk falls back to the default', () => {
  assert.equal(parseListLimit(null), 50);
  assert.equal(parseListLimit('10'), 10);
  assert.equal(parseListLimit('200'), 200);
  assert.equal(parseListLimit('9999'), 200);
  for (const junk of ['0', '-3', 'abc', '1.5', '']) assert.equal(parseListLimit(junk), 50, junk);
});

// What the API stores for a stock preset: a thin reference under a distinct name.
test('a thin stock reference flattens to the stock preset; the same name as its parent is a cycle', () => {
  const stock = (name) => ({ name: `${name} (stock)`, inherits: name, from: 'User' });
  const p = buildProfiles({
    machine: userMachine(), process: stock('0.20mm Standard @Creality Hi'),
    filaments: [{ raw: stock('eSUN PLA+ @System'), density: '1.24' }, { raw: stock('eSUN PLA+ @System') }],
    siblings: [stock('eSUN PLA+ @System'), stock('0.20mm Standard @Creality Hi')],
  }, index);
  assert.equal(p.process.name, '0.20mm Standard @Creality Hi (stock)');
  assert.equal(p.process.inherits, undefined);
  assert.deepEqual(p.process.compatible_printers, [p.machine.name]);
  assert.equal(p.filaments.length, 2);
  assert.equal(p.filaments[0].name, 'eSUN PLA+ @System (stock)');
  assert.deepEqual(p.filaments[0].filament_density, ['1.24']);
  assert.deepEqual(p.filaments[1].filament_density, ['1.25']);
  assert.throws(
    () => buildProfiles({ filaments: [{ raw: { name: 'eSUN PLA+ @System', inherits: 'eSUN PLA+ @System', from: 'User' } }] }, index),
    (err) => err.code === 'CYCLE',
  );
});

// ---- HTTP ----
let server; let baseUrl;
before(async () => {
  const app = createApp({
    uploadsDir: os.tmpdir(), scratchDir: os.tmpdir(), profilesDir: PROFILES_DIR, orcaBin: 'x', timeoutMs: 1000, log: () => {},
  });
  server = http.createServer((req, res) => { app(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); });

test('GET /profiles/:kind lists stock presets; q filters; an unknown kind is 404', async () => {
  const all = await fetch(`${baseUrl}/profiles/filament`);
  assert.equal(all.status, 200);
  assert.deepEqual(await all.json(), { presets: [{ name: 'eSUN PLA+ @System', vendor: 'OrcaFilamentLibrary' }] });
  const hit = await fetch(`${baseUrl}/profiles/process?q=${encodeURIComponent('standard @creality')}&limit=5`);
  assert.deepEqual((await hit.json()).presets.map((p) => p.name), ['0.20mm Standard @Creality Hi']);
  assert.deepEqual(await (await fetch(`${baseUrl}/profiles/machine?q=nothing-like-this`)).json(), { presets: [] });
  assert.equal((await fetch(`${baseUrl}/profiles/bogus?q=a`)).status, 404);
});

test('GET /profiles/:kind/:name still serves one preset', async () => {
  const r = await fetch(`${baseUrl}/profiles/filament/${encodeURIComponent('eSUN PLA+ @System')}`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).inherits, 'eSUN PLA+ @base');
});
