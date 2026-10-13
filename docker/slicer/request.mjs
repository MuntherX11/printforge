// /slice request validation for the slicer sidecar (pure: no I/O, nothing is run).
import path from 'node:path';
import { validateCopies } from './args.mjs';

const MAX_FILAMENTS = 16;
export const MAX_INPUTS = 24;

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

export function isObject(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }

export function presetFromBody(value, what) {
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

function filamentsFromBody(list) {
  return list.map((f, i) => {
    const { raw, density } = presetFromBody(f, `filaments[${i}]`);
    if (density !== undefined && typeof density !== 'string') {
      throw new HttpError(400, `filaments[${i}].density must be a string`);
    }
    return { raw, density };
  });
}

function siblingsFromBody(body) {
  return Array.isArray(body.siblings)
    ? body.siblings.map((s, i) => presetFromBody(s, `siblings[${i}]`).raw)
    : [];
}

/**
 * Validate and normalise the mixed-plate shape of a /slice body:
 * `{ inputs: [{ inputPath, kind, copies }], machine, process, filaments: [one], siblings? }`.
 */
export function parseMixedRequest(body, uploadsDir) {
  if (!isObject(body)) throw new HttpError(400, 'body must be a JSON object');
  for (const key of ['inputPath', 'kind', 'copies']) {
    if (body[key] !== undefined) {
      throw new HttpError(400, `"${key}" belongs inside inputs[] when inputs is given`);
    }
  }
  if (!Array.isArray(body.inputs) || body.inputs.length < 1 || body.inputs.length > MAX_INPUTS) {
    throw new HttpError(400, `inputs must hold between 1 and ${MAX_INPUTS} models`);
  }
  const inputs = body.inputs.map((input, k) => {
    const what = `inputs[${k}]`;
    if (!isObject(input)) throw new HttpError(400, `${what} must be an object`);
    const { kind, copies } = input;
    if (kind !== 'stl' && kind !== '3mf') throw new HttpError(400, `${what}.kind must be "stl" or "3mf"`);
    try {
      validateCopies(copies);
      return { kind, copies, inputPath: resolveInputPath(uploadsDir, input.inputPath) };
    } catch (err) {
      throw new HttpError(400, `${what}: ${err.message}`, { input: k });
    }
  });
  if (!Array.isArray(body.filaments) || body.filaments.length !== 1) {
    throw new HttpError(400, 'a mixed plate takes exactly one filament');
  }
  if (body.machine === undefined || body.process === undefined) {
    throw new HttpError(400, 'a mixed plate needs machine and process presets');
  }
  return {
    mixed: true,
    inputs,
    machine: presetFromBody(body.machine, 'machine').raw,
    process: presetFromBody(body.process, 'process').raw,
    filaments: filamentsFromBody(body.filaments),
    siblings: siblingsFromBody(body),
  };
}

/** Validate and normalise a /slice request body (either shape). */
export function parseSliceRequest(body, uploadsDir) {
  if (!isObject(body)) throw new HttpError(400, 'body must be a JSON object');
  if (body.inputs !== undefined) return parseMixedRequest(body, uploadsDir);
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
  const filaments = filamentsFromBody(body.filaments);
  const machine = body.machine === undefined ? null : presetFromBody(body.machine, 'machine').raw;
  const process_ = body.process === undefined ? null : presetFromBody(body.process, 'process').raw;
  if (kind === 'stl' && (!machine || !process_)) {
    throw new HttpError(400, 'stl slicing needs machine and process presets');
  }
  return { kind, copies, inputPath, machine, process: process_, filaments, siblings: siblingsFromBody(body) };
}
