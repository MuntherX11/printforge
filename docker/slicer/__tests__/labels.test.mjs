import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scratchName, objectLabels, parseLabel, countInputUnits, exportedStls } from '../labels.mjs';

const define = (name) => `EXCLUDE_OBJECT_DEFINE NAME=${name} CENTER=149.8,145.4 POLYGON=[[119.8,143.5],[119.9,143.6]]`;
const gcodeOf = (names) => ['; HEADER_BLOCK_START', ...names.map(define), 'G28', 'EXCLUDE_OBJECT_START NAME=whatever', ''].join('\n');
// The shape Orca 2.4.2 writes on Windows for C:\scratch\job-ab12\in<k>_<j>.stl
const win = (file, suffix) => `C_/scratch/job-ab12/${file}${suffix}`;

test('scratchName is in<k>_<j>.stl and refuses bad indexes', () => {
  assert.equal(scratchName(0, 0), 'in0_0.stl');
  assert.equal(scratchName(11, 3), 'in11_3.stl');
  for (const [k, j] of [[-1, 0], [0, -1], [1.5, 0], ['1', 0], [0, undefined]]) {
    assert.throws(() => scratchName(k, j), RangeError);
  }
});

test('objectLabels reads every EXCLUDE_OBJECT_DEFINE name, with or without CRLF', () => {
  const names = [win('in0_0.stl', '_1_id_0_copy_0'), win('in0_0.stl', '_2_id_1_copy_0')];
  assert.deepEqual(objectLabels(gcodeOf(names)), names);
  assert.deepEqual(objectLabels(gcodeOf(names).replace(/\n/g, '\r\n')), names);
  assert.deepEqual(objectLabels('G28\nG1 X1\n'), []);
});

test('countInputUnits: several copies per input, in request order', () => {
  const gcode = gcodeOf([
    win('in0_0.stl', '_1_id_0_copy_0'), win('in0_0.stl', '_2_id_1_copy_0'), win('in0_0.stl', '_3_id_2_copy_0'),
    win('in1_0.stl', '_1_id_3_copy_0'), win('in1_0.stl', '_2_id_4_copy_0'),
  ]);
  assert.deepEqual(countInputUnits(gcode, 2), [3, 2]);
});

test('countInputUnits: a single copy carries no _n suffix', () => {
  assert.deepEqual(countInputUnits(gcodeOf([win('in0_0.stl', '_id_0_copy_0')]), 1), [1]);
  assert.deepEqual(countInputUnits(gcodeOf([win('in0_0.stl', '')]), 1), [1]);
  assert.deepEqual(
    countInputUnits(gcodeOf([win('in0_0.stl', '_1_id_0_copy_0'), win('in0_0.stl', '_2_id_1_copy_0'), win('in1_0.stl', '_id_2_copy_0')]), 2),
    [2, 1],
  );
});

test('countInputUnits: in1_ never matches in10_ / in11_ (and the other way round)', () => {
  const names = [
    win('in1_0.stl', '_id_0_copy_0'),
    win('in10_0.stl', '_1_id_1_copy_0'), win('in10_0.stl', '_2_id_2_copy_0'),
    win('in11_0.stl', '_1_id_3_copy_0'), win('in11_0.stl', '_2_id_4_copy_0'), win('in11_0.stl', '_3_id_5_copy_0'),
  ];
  const units = countInputUnits(gcodeOf(names), 12);
  assert.equal(units[1], 1);
  assert.equal(units[10], 2);
  assert.equal(units[11], 3);
  assert.equal(units.reduce((a, b) => a + b, 0), 6);
  assert.deepEqual(parseLabel('C_/x/main1_0.stl_1'), null, 'a longer word ending in "in1_0.stl" is not ours');
  assert.deepEqual(parseLabel('C_/x/in1_0.stla_1'), null);
});

test('countInputUnits: without object counts the first object of an input counts', () => {
  // Input 0 is a project of three objects, two units placed; input 1 has object 10 as well.
  const names = [];
  for (const j of [0, 1, 2]) for (const n of [1, 2]) names.push(win(`in0_${j}.stl`, `_${n}_id_${names.length}_copy_0`));
  names.push(win('in1_0.stl', '_id_6_copy_0'), win('in1_10.stl', '_id_7_copy_0'));
  assert.deepEqual(countInputUnits(gcodeOf(names), 2), [2, 1]);
  assert.deepEqual(parseLabel(win('in1_10.stl', '_id_7_copy_0')), { input: 1, object: 10 });
});

test('countInputUnits: wipe tower and foreign labels are ignored; nothing placed is 0', () => {
  const gcode = gcodeOf([
    'Wipe_Tower_id_1000_copy_0', 'wipe_tower', 'C_/models/fish.stl_1_id_0_copy_0',
    win('in0_0.stl', '_1_id_1_copy_0'),
    win('in7_0.stl', '_id_2_copy_0'), // beyond inputCount: not ours
  ]);
  assert.deepEqual(countInputUnits(gcode, 3), [1, 0, 0]);
  assert.deepEqual(countInputUnits('G28\n', 2), [0, 0]);
});

test('countInputUnits: POSIX paths and a scratch dir that looks like a scratch name', () => {
  // Linux container: /scratch/job-x/in2_0.stl, however the separators end up mangled.
  for (const prefix of ['/scratch/job-x/', '_scratch_job-x_', '']) {
    const gcode = gcodeOf([`${prefix}in2_0.stl_1_id_0_copy_0`, `${prefix}in2_0.stl_2_id_1_copy_0`]);
    assert.deepEqual(countInputUnits(gcode, 3), [0, 0, 2], prefix);
  }
  // The file name (last match) wins over a directory with a confusing name.
  assert.deepEqual(parseLabel('C_/in5_0.stl/job/in1_0.stl_2_id_0_copy_0'), { input: 1, object: 0 });
});

test('exportedStls keeps obj_<N>_*.stl in numeric object order', () => {
  assert.deepEqual(
    exportedStls(['obj_10_cap.stl', 'obj_2_Omani dress.stl', 'orca.log', 'obj_1_body.STL', 'notes.stl', 'obj_x_y.stl']),
    ['obj_1_body.STL', 'obj_2_Omani dress.stl', 'obj_10_cap.stl'],
  );
  assert.deepEqual(exportedStls([]), []);
});

test('countInputUnits: a unit is complete only when every object of its input is on the plate', () => {
  // Input 0 is a project of two objects: 12 of the first fit, 3 of the second. Input 1 is one STL.
  const names = [];
  for (let n = 1; n <= 12; n += 1) names.push(win('in0_0.stl', `_${n}_id_${names.length}_copy_0`));
  for (let n = 1; n <= 3; n += 1) names.push(win('in0_1.stl', `_${n}_id_${names.length}_copy_0`));
  names.push(win('in1_0.stl', '_id_99_copy_0'));
  assert.deepEqual(countInputUnits(gcodeOf(names), 2, [2, 1]), [3, 1]);
  // An object that is missing altogether means no complete unit.
  assert.deepEqual(countInputUnits(gcodeOf(names), 2, [3, 1]), [0, 1]);
});
