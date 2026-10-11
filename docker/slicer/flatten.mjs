// Pure preset flattening for the OrcaSlicer sidecar (no I/O).
//
// OrcaSlicer's CLI cannot follow `inherits` when a preset is loaded with
// --load-settings / --load-filaments, so every chain is resolved here, down to
// the root, and the merged preset is written out without `inherits`.

export const PRESET_KINDS = ['machine', 'process', 'filament'];

/** Keys removed from every flattened preset (host addresses, shell hooks, ids). */
export const STRIPPED_KEYS = [
  'filament_colour',
  'compatible_printers',
  'compatible_prints',
  'compatible_printers_condition',
  'compatible_prints_condition',
  'print_settings_id',
  'printer_settings_id',
  'filament_settings_id',
  'version',
  'is_custom_defined',
  'setting_id',
  'filament_id',
  'post_process',
  'thumbnails',
  'thumbnails_format',
];
const STRIPPED_PREFIX = 'printhost_';

const MAX_CHAIN_DEPTH = 32;

export class PresetError extends Error {
  /**
   * @param {'UNRESOLVED_PARENT'|'INVALID_VALUE'|'INVALID_PRESET'|'CYCLE'} code
   * @param {string} message
   * @param {{preset?: string, parent?: string, key?: string}} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PresetError';
    this.code = code;
    this.preset = details.preset;
    this.parent = details.parent;
    this.key = details.key;
  }
}

export function isStrippedKey(key) {
  return STRIPPED_KEYS.includes(key) || key.startsWith(STRIPPED_PREFIX);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function presetName(raw) {
  return typeof raw?.name === 'string' && raw.name.length > 0 ? raw.name : '(unnamed)';
}

/**
 * Every preset value must be a string or an array of strings: a preset is a
 * code path into the container (post_process is a shell command list), so
 * nothing else is forwarded to orca-slicer.
 */
export function validateValues(preset, name = presetName(preset)) {
  for (const [key, value] of Object.entries(preset)) {
    const ok = typeof value === 'string'
      || (Array.isArray(value) && value.every((v) => typeof v === 'string'));
    if (!ok) {
      throw new PresetError(
        'INVALID_VALUE',
        `preset "${name}": key "${key}" must be a string or an array of strings`,
        { preset: name, key },
      );
    }
  }
}

function parentNameOf(raw) {
  const inherits = raw.inherits;
  if (inherits === undefined || inherits === null || inherits === '') return null;
  if (typeof inherits !== 'string') {
    throw new PresetError(
      'INVALID_VALUE',
      `preset "${presetName(raw)}": key "inherits" must be a string`,
      { preset: presetName(raw), key: 'inherits' },
    );
  }
  return inherits;
}

/**
 * Resolve `raw` to its root through `lookup` and merge child keys over parent
 * keys. `lookup(name, childRaw)` returns the parent preset object or null; the
 * caller decides the search order (request siblings first, then the bundled
 * system presets of the same kind).
 *
 * @param {object} raw          the preset exactly as exported by OrcaSlicer
 * @param {(name: string, child: object) => object|null|undefined} lookup
 * @param {{density?: string}} [options]
 * @returns {object} a new preset with no `inherits`, `from: "system"`, unsafe keys removed
 */
export function flattenPreset(raw, lookup, options = {}) {
  if (!isPlainObject(raw)) {
    throw new PresetError('INVALID_PRESET', 'preset must be a JSON object');
  }
  const chain = [raw];
  const seen = new Set([presetName(raw)]);
  let current = raw;
  for (let depth = 0; ; depth += 1) {
    const parentName = parentNameOf(current);
    if (parentName === null) break;
    if (depth >= MAX_CHAIN_DEPTH || seen.has(parentName)) {
      throw new PresetError(
        'CYCLE',
        `preset "${presetName(raw)}": inheritance chain loops at "${parentName}"`,
        { preset: presetName(raw), parent: parentName },
      );
    }
    const parent = lookup(parentName, current);
    if (!isPlainObject(parent)) {
      throw new PresetError(
        'UNRESOLVED_PARENT',
        `preset "${presetName(current)}" inherits "${parentName}", which is not available`,
        { preset: presetName(current), parent: parentName },
      );
    }
    seen.add(parentName);
    chain.push(parent);
    current = parent;
  }

  // Root first, child last, so child keys win.
  const merged = {};
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    for (const [key, value] of Object.entries(chain[i])) {
      if (key === 'inherits' || isStrippedKey(key)) continue;
      merged[key] = value;
    }
  }
  merged.name = presetName(raw);
  merged.from = 'system';
  if (options.density !== undefined) {
    if (typeof options.density !== 'string' || !/^\d+(\.\d+)?$/.test(options.density)) {
      throw new PresetError(
        'INVALID_VALUE',
        `preset "${merged.name}": density must be a decimal string like "1.25"`,
        { preset: merged.name, key: 'filament_density' },
      );
    }
    merged.filament_density = [options.density];
  }
  validateValues(merged);
  return merged;
}

/**
 * Build a lookup that searches request siblings (by name) before the system
 * index. `systemLookup(name, child)` is the vendor-index lookup for one kind.
 */
export function makeLookup(siblings, systemLookup) {
  const byName = new Map();
  for (const sibling of siblings ?? []) {
    if (isPlainObject(sibling) && typeof sibling.name === 'string') {
      byName.set(sibling.name, sibling);
    }
  }
  return (name, child) => byName.get(name) ?? systemLookup?.(name, child) ?? null;
}
