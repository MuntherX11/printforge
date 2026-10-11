import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, ArgsError, MAX_COPIES } from '../args.mjs';

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
