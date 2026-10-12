import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProfiles } from '../server.mjs';
import { flattenPreset, PresetError } from '../flatten.mjs';
import { loadSystemIndex } from '../system-index.mjs';
import { PROFILES_DIR, userMachine, userProcess, userFilament } from './helpers.mjs';

const index = loadSystemIndex(PROFILES_DIR);
const job = (over = {}) => ({
  machine: userMachine(), process: userProcess(),
  filaments: [{ raw: userFilament(), density: '1.25' }],
  siblings: [userMachine(), userProcess(), userFilament()],
  ...over,
});

// Regression: the first slice on the server failed with orca exit -17
// ("process not compatible with printer") because compatible_printers was
// stripped and the machine keeps the owner's preset name.
test('stl job: the process names the machine preset it is paired with', () => {
  const p = buildProfiles(job(), index);
  assert.equal(p.machine.name, 'Creality Hi');
  assert.deepEqual(p.process.compatible_printers, [p.machine.name]);
});

test('filaments are compatible with any printer and keep the request density', () => {
  const p = buildProfiles(job(), index);
  assert.deepEqual(p.filaments[0].compatible_printers, []);
  assert.deepEqual(p.filaments[0].filament_density, ['1.25']);
});

test('3mf job: only filaments are built, one per slot, in order', () => {
  const f = { raw: userFilament(), density: '1.24' };
  const p = buildProfiles(job({ machine: undefined, process: undefined, filaments: [f, f, f, f] }), index);
  assert.equal(p.machine, undefined);
  assert.equal(p.process, undefined);
  assert.equal(p.filaments.length, 4);
  assert.ok(p.filaments.every((x) => x.compatible_printers.length === 0 && x.inherits === undefined));
});

test('the exported compatible_printers never leaks through', () => {
  const raw = { ...userFilament(), compatible_printers: ['Creality Hi 0.4 nozzle'] };
  const p = buildProfiles(job({ filaments: [{ raw }] }), index);
  assert.deepEqual(p.filaments[0].compatible_printers, []);
});

test('compatiblePrinters must be a list of names', () => {
  assert.throws(
    () => flattenPreset({ name: 'x' }, () => null, { compatiblePrinters: [''] }),
    (err) => err instanceof PresetError && err.code === 'INVALID_VALUE' && err.key === 'compatible_printers',
  );
});
