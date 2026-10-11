// orca-slicer command-line construction (pure).

export const MIN_COPIES = 1;
export const MAX_COPIES = 500;

export class ArgsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgsError';
  }
}

export function validateCopies(copies) {
  if (!Number.isInteger(copies) || copies < MIN_COPIES || copies > MAX_COPIES) {
    throw new ArgsError(`copies must be an integer between ${MIN_COPIES} and ${MAX_COPIES}`);
  }
  return copies;
}

/**
 * @param {object} input
 * @param {'stl'|'3mf'} input.kind
 * @param {string} input.inputPath        absolute path of the model inside the container
 * @param {number} input.copies           1..500
 * @param {object} input.profilePaths     flattened preset files written to scratch
 * @param {string} [input.profilePaths.machine]
 * @param {string} [input.profilePaths.process]
 * @param {string[]} input.profilePaths.filaments  one per extruder slot, in slot order
 * @param {string} input.outputDir        where plate_*.gcode land
 * @param {string} input.logFile          orca-slicer --logfile target
 * @returns {string[]} argv for orca-slicer (without the binary itself)
 */
export function buildArgs({ kind, inputPath, copies, profilePaths, outputDir, logFile }) {
  validateCopies(copies);
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    throw new ArgsError('inputPath is required');
  }
  if (typeof outputDir !== 'string' || typeof logFile !== 'string') {
    throw new ArgsError('outputDir and logFile are required');
  }
  const filaments = profilePaths?.filaments;
  if (!Array.isArray(filaments) || filaments.length === 0
    || !filaments.every((p) => typeof p === 'string' && p.length > 0)) {
    throw new ArgsError('at least one filament profile path is required');
  }
  for (const p of [profilePaths.machine, profilePaths.process, ...filaments]) {
    if (typeof p === 'string' && p.includes(';')) {
      throw new ArgsError('profile paths must not contain ";"');
    }
  }

  const tail = [
    '--slice', '1',
    '--exclude-object=1',
    '--outputdir', outputDir,
    '--debug', '3',
    '--logfile', logFile,
  ];

  if (kind === 'stl') {
    if (!profilePaths.machine || !profilePaths.process) {
      throw new ArgsError('stl slicing needs machine and process profiles');
    }
    return [
      inputPath,
      '--load-settings', `${profilePaths.machine};${profilePaths.process}`,
      '--load-filaments', filaments.join(';'),
      '--clone-objects', String(copies),
      '--arrange', '1',
      ...tail,
    ];
  }
  if (kind === '3mf') {
    const repetitions = copies === 1 ? [] : ['--repetitions', String(copies)];
    return [
      inputPath,
      '--load-filaments', filaments.join(';'),
      ...repetitions,
      ...tail,
    ];
  }
  throw new ArgsError(`unknown kind "${kind}" (expected "stl" or "3mf")`);
}
