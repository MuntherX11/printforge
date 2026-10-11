import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenPreset, makeLookup, PresetError, STRIPPED_KEYS } from '../flatten.mjs';
import { loadSystemIndex } from '../system-index.mjs';
import { PROFILES_DIR, userMachine, userProcess, userFilament } from './helpers.mjs';

const index = loadSystemIndex(PROFILES_DIR);
const lookupFor = (kind, siblings = []) => makeLookup(siblings, index.forKind(kind));

test('vendor index lists both fixture vendors', () => {
  assert.deepEqual(index.vendors, ['Creality', 'OrcaFilamentLibrary']);
  assert.equal(index.lookup('process', '0.20mm Standard @Creality Hi').name, '0.20mm Standard @Creality Hi');
  assert.equal(index.lookup('filament', 'eSUN PLA+ @base').filament_density[0], '1.25');
  assert.equal(index.lookup('machine', 'does not exist'), null);
});

test('filament: user -> @System -> @base -> pla -> common; density from @base', () => {
  const flat = flattenPreset(userFilament(), lookupFor('filament'));
  assert.deepEqual(flat.filament_density, ['1.25']);
  assert.deepEqual(flat.nozzle_temperature, ['205']);              // user preset wins
  assert.deepEqual(flat.nozzle_temperature_initial_layer, ['215']);
  assert.deepEqual(flat.filament_vendor, ['eSUN']);                 // from @base
  assert.equal(flat.filament_type?.[0], 'PLA');                     // from fdm_filament_pla
  assert.equal(flat.name, 'eSUN PLA+ Multi');
  assert.equal(flat.from, 'system');
  assert.equal('inherits' in flat, false);
});

test('filament: density from the request replaces the bundled one', () => {
  const flat = flattenPreset(userFilament(), lookupFor('filament'), { density: '1.30' });
  assert.deepEqual(flat.filament_density, ['1.30']);
});

test('filament: a malformed density is rejected', () => {
  assert.throws(() => flattenPreset(userFilament(), lookupFor('filament'), { density: '1,30' }),
    (err) => err instanceof PresetError && err.code === 'INVALID_VALUE' && err.key === 'filament_density');
});

test('process: user copy -> system -> creality common -> common keeps the override', () => {
  const flat = flattenPreset(userProcess(), lookupFor('process'));
  assert.equal(flat.wipe_tower_no_sparse_layers, '1');   // user copy overrides system "0"
  assert.equal(flat.layer_height, '0.2');                 // from the system preset
  assert.equal(flat.name, '0.20mm Standard @Creality Hi - Copy');
  assert.equal('inherits' in flat, false);
  assert.equal('print_settings_id' in flat, false);
});

test('machine: user -> 0.4 nozzle -> creality common -> machine common', () => {
  const flat = flattenPreset(userMachine(), lookupFor('machine'));
  assert.deepEqual(flat.printable_area, ['0x0', '260x0', '260x260', '0x260']);
  assert.equal(flat.gcode_flavor, 'klipper');
  assert.equal(flat.print_host, '192.168.100.33:4408'); // user override is kept (not a printhost_ key)
  assert.equal(flat.printer_model, 'Creality Hi');
  assert.equal('inherits' in flat, false);
  assert.equal('thumbnails' in flat, false);
  assert.equal('printhost_authorization_type' in flat, false);
});

test('stripped keys never survive, including printhost_* and post_process', () => {
  const raw = {
    name: 'x', inherits: '', post_process: ['rm -rf /'], printhost_apikey: 'k', printhost_user: 'u',
    thumbnails: ['96x96'], thumbnails_format: 'PNG', filament_colour: ['#fff'], version: '1',
    compatible_printers: ['a'], compatible_prints: ['b'], compatible_printers_condition: 'c',
    compatible_prints_condition: 'd', print_settings_id: 'e', printer_settings_id: 'f',
    filament_settings_id: ['g'], is_custom_defined: '0', setting_id: 'h', filament_id: 'i',
    layer_height: '0.2',
  };
  const flat = flattenPreset(raw, lookupFor('process'));
  for (const key of STRIPPED_KEYS) assert.equal(key in flat, false, key);
  assert.equal('printhost_apikey' in flat, false);
  assert.equal('printhost_user' in flat, false);
  assert.equal(flat.layer_height, '0.2');
  assert.ok(STRIPPED_KEYS.includes('post_process'));
});

test('request siblings are searched before the system index', () => {
  const parent = { name: 'eSUN PLA+ @System', inherits: 'eSUN PLA+ @base', nozzle_temperature: ['999'] };
  const child = { name: 'child', inherits: 'eSUN PLA+ @System' };
  const flat = flattenPreset(child, lookupFor('filament', [parent]));
  assert.deepEqual(flat.nozzle_temperature, ['999']);
  assert.deepEqual(flat.filament_density, ['1.25']); // chain continues into the system index
});

test('a broken chain names the preset and the missing parent', () => {
  const raw = { name: 'orphan', inherits: 'Creality Hi 0.4 nozzle' };
  assert.throws(() => flattenPreset(raw, lookupFor('filament')), (err) => {
    assert.ok(err instanceof PresetError);
    assert.equal(err.code, 'UNRESOLVED_PARENT');
    assert.equal(err.preset, 'orphan');
    assert.equal(err.parent, 'Creality Hi 0.4 nozzle');
    assert.match(err.message, /"Creality Hi 0\.4 nozzle"/);
    return true;
  });
});

test('a broken chain deeper down names the intermediate preset', () => {
  const middle = { name: 'middle', inherits: 'gone' };
  const child = { name: 'child', inherits: 'middle' };
  assert.throws(() => flattenPreset(child, lookupFor('process', [middle])),
    (err) => err.code === 'UNRESOLVED_PARENT' && err.preset === 'middle' && err.parent === 'gone');
});

test('a non-string value is rejected and the key is named', () => {
  const raw = { name: 'bad', inherits: 'fdm_process_common', layer_height: 0.2 };
  assert.throws(() => flattenPreset(raw, lookupFor('process')),
    (err) => err instanceof PresetError && err.code === 'INVALID_VALUE' && err.key === 'layer_height');
  const nested = { name: 'bad2', layer_height: ['0.2', 3] };
  assert.throws(() => flattenPreset(nested, lookupFor('process')), (err) => err.key === 'layer_height');
  const obj = { name: 'bad3', machine_start_gcode: { cmd: 'x' } };
  assert.throws(() => flattenPreset(obj, lookupFor('machine')), (err) => err.key === 'machine_start_gcode');
});

test('a cycle is detected', () => {
  const a = { name: 'a', inherits: 'b' };
  const b = { name: 'b', inherits: 'a' };
  assert.throws(() => flattenPreset(a, lookupFor('process', [b])), (err) => err.code === 'CYCLE');
});
