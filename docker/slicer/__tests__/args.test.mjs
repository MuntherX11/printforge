import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, buildMixedArgs, buildExportArgs, ArgsError, MAX_COPIES, MAX_MIXED_FILES } from '../args.mjs';

const base = {
  inputPath: '/uploads/parts/fish.stl',
  profilePaths: { machine: '/scratch/j/machine.json', process: '/scratch/j/process.json', filaments: ['/scratch/j/filament_0.json'] },
  outputDir: '/scratch/j/out',
  logFile: '/scratch/j/orca.log',
};

test('stl: load-settings, filaments, clone, arrange, slice, exclude-object, output, debug, logfile', () => {
  const args = buildArgs({ ...base, kind: 'stl', copies: 12 });
  assert.deepEqual(args, [
    '/uploads/parts/fish.stl',
    '--load-settings', '/scratch/j/machine.json;/scratch/j/process.json',
    '--load-filaments', '/scratch/j/filament_0.json',
    '--clone-objects', '12',
    '--arrange', '1',
    '--slice', '1',
    '--exclude-object=1',
    '--outputdir', '/scratch/j/out',
    '--debug', '3',
    '--logfile', '/scratch/j/orca.log',
  ]);
});

test('3mf: N filaments joined with ";", repetitions, no load-settings', () => {
  const filaments = ['/s/f0.json', '/s/f1.json', '/s/f2.json', '/s/f3.json'];
  const args = buildArgs({ ...base, kind: '3mf', copies: 4, inputPath: '/uploads/dress.3mf', profilePaths: { filaments } });
  assert.deepEqual(args, [
    '/uploads/dress.3mf',
    '--load-filaments', '/s/f0.json;/s/f1.json;/s/f2.json;/s/f3.json',
    '--repetitions', '4',
    '--slice', '1',
    '--exclude-object=1',
    '--outputdir', '/scratch/j/out',
    '--debug', '3',
    '--logfile', '/scratch/j/orca.log',
  ]);
  assert.equal(args.includes('--load-settings'), false);
});

test('3mf: --repetitions is omitted for a single copy', () => {
  const args = buildArgs({ ...base, kind: '3mf', copies: 1, profilePaths: { filaments: ['/s/f0.json'] } });
  assert.equal(args.includes('--repetitions'), false);
});

test('copies bounds: 1..500 integers only', () => {
  for (const bad of [0, -1, 501, 1.5, '12', NaN, undefined]) {
    assert.throws(() => buildArgs({ ...base, kind: 'stl', copies: bad }), ArgsError, String(bad));
  }
  assert.equal(buildArgs({ ...base, kind: 'stl', copies: MAX_COPIES })[6], '500');
  assert.equal(buildArgs({ ...base, kind: 'stl', copies: 1 })[6], '1');
});

test('stl needs machine and process; every kind needs a filament', () => {
  assert.throws(() => buildArgs({ ...base, kind: 'stl', copies: 1, profilePaths: { filaments: ['/s/f.json'] } }), ArgsError);
  assert.throws(() => buildArgs({ ...base, kind: '3mf', copies: 1, profilePaths: { filaments: [] } }), ArgsError);
  assert.throws(() => buildArgs({ ...base, kind: 'obj', copies: 1 }), ArgsError);
});

test('profile paths with ";" are refused (they would split the list)', () => {
  assert.throws(() => buildArgs({ ...base, kind: '3mf', copies: 1, profilePaths: { filaments: ['/s/a;b.json'] } }), ArgsError);
});

// ---- mixed plates ----
const mixedBase = { profilePaths: base.profilePaths, outputDir: base.outputDir, logFile: base.logFile };
const stl = (k, j, copies) => ({ path: `/scratch/j/in${k}_${j}.stl`, copies });

test('mixed: files first in load order, one clone count per file, arrange and slice', () => {
  const args = buildMixedArgs({ ...mixedBase, files: [stl(0, 0, 3), stl(1, 0, 2), stl(1, 1, 2), stl(2, 0, 1)] });
  assert.deepEqual(args, [
    '/scratch/j/in0_0.stl', '/scratch/j/in1_0.stl', '/scratch/j/in1_1.stl', '/scratch/j/in2_0.stl',
    '--load-settings', '/scratch/j/machine.json;/scratch/j/process.json',
    '--load-filaments', '/scratch/j/filament_0.json',
    '--clone-objects', '3,2,2,1',
    '--arrange', '1',
    '--slice', '1',
    '--exclude-object=1',
    '--outputdir', '/scratch/j/out',
    '--debug', '3',
    '--logfile', '/scratch/j/orca.log',
  ]);
});

test('mixed: one file is the same command line as a plain stl job', () => {
  assert.deepEqual(
    buildMixedArgs({ ...mixedBase, files: [{ path: base.inputPath, copies: 12 }] }),
    buildArgs({ ...base, kind: 'stl', copies: 12 }),
  );
});

test('mixed: file count, copies, paths and profiles are all checked', () => {
  const ok = { ...mixedBase, files: [stl(0, 0, 1)] };
  const many = Array.from({ length: MAX_MIXED_FILES + 1 }, (_, k) => stl(k, 0, 1));
  assert.equal(buildMixedArgs({ ...ok, files: many.slice(0, MAX_MIXED_FILES) }).indexOf('--load-settings'), MAX_MIXED_FILES);
  const bad = [
    { ...ok, files: [] },
    { ...ok, files: undefined },
    { ...ok, files: many },
    { ...ok, files: [stl(0, 0, 0)] },
    { ...ok, files: [stl(0, 0, 1), stl(1, 0, 501)] },
    { ...ok, files: [stl(0, 0, 1.5)] },
    { ...ok, files: [{ path: '', copies: 1 }] },
    { ...ok, files: [null] },
    { ...ok, outputDir: undefined },
    { ...ok, profilePaths: { ...base.profilePaths, machine: undefined } },
    { ...ok, profilePaths: { ...base.profilePaths, process: undefined } },
    { ...ok, profilePaths: { ...base.profilePaths, filaments: [] } },
    { ...ok, profilePaths: { ...base.profilePaths, filaments: ['/s/f0.json', '/s/f1.json'] } },
    { ...ok, profilePaths: { ...base.profilePaths, filaments: ['/s/a;b.json'] } },
  ];
  for (const input of bad) assert.throws(() => buildMixedArgs(input), ArgsError, JSON.stringify(input).slice(0, 120));
});

test('export: project, --export-stls dir, debug and logfile only', () => {
  assert.deepEqual(
    buildExportArgs({ inputPath: '/uploads/a/dress.3mf', exportDir: '/scratch/j/export_1', logFile: '/scratch/j/export_1.log' }),
    ['/uploads/a/dress.3mf', '--export-stls', '/scratch/j/export_1', '--debug', '3', '--logfile', '/scratch/j/export_1.log'],
  );
  assert.throws(() => buildExportArgs({ inputPath: '/uploads/a.3mf', exportDir: '', logFile: '/l' }), ArgsError);
  assert.throws(() => buildExportArgs({ exportDir: '/e', logFile: '/l' }), ArgsError);
});
