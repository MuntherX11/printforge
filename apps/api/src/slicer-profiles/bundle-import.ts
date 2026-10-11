import JSZip from 'jszip';
import * as path from 'path';
import { SlicerProfileKind } from '@printforge/types';

/**
 * Parse an OrcaSlicer bundle (`.orca_printer` / `.orca_filament`: a zip with a
 * `bundle_structure.json` index naming the preset files it holds) into raw
 * presets. Pure: no database, no network, no disk.
 *
 * Presets are kept exactly as exported (decision D11: the slicer container
 * flattens `inherits` at slice time). The only transformation is a safety
 * screen: a preset is a code path into that container (`post_process` is a
 * shell command list), so every value must be a string or a string array —
 * Orca stores numbers and booleans as strings ("0.2", "1"); anything else is
 * not an Orca preset and is skipped.
 */

export type PresetJson = Record<string, string | string[]>;

export interface ParsedPreset {
  kind: SlicerProfileKind;
  name: string;
  /** The preset's `inherits` value as exported, null when it is a root preset. */
  inherits: string | null;
  json: PresetJson;
}

export interface BundleParseResult {
  presets: ParsedPreset[];
  skipped: Array<{ name: string; reason: string }>;
}

/** The whole bundle is unusable (not a zip, no index). Per-file problems are `skipped` entries instead. */
export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

/** bundle_structure.json sections → preset kind. `filament_path` is the .orca_filament spelling. */
const SECTIONS: ReadonlyArray<[string, SlicerProfileKind]> = [
  ['printer_config', SlicerProfileKind.MACHINE],
  ['process_config', SlicerProfileKind.PROCESS],
  ['filament_config', SlicerProfileKind.FILAMENT],
  ['filament_path', SlicerProfileKind.FILAMENT],
];

const MAX_PRESET_BYTES = 1024 * 1024;

const norm = (name: string) => name.replace(/\\/g, '/').replace(/^\.\/+/, '');

/** True when the entry name stays inside the archive root (no `..` segment, not absolute). */
export function isSafeEntryPath(name: string): boolean {
  const n = norm(name);
  if (!n || path.posix.isAbsolute(n) || /^[a-zA-Z]:/.test(n)) return false;
  return !n.split('/').some((seg) => seg === '..');
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Null when every value is a string or a string array, else the offending key. */
export function firstUnsafeKey(json: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(json)) {
    if (typeof value === 'string' || isStringArray(value)) continue;
    return key;
  }
  return null;
}

export async function parseBundle(buffer: Buffer): Promise<BundleParseResult> {
  if (!buffer?.length) throw new BundleError('No file uploaded');

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new BundleError('Uploaded file is not an OrcaSlicer bundle (not a zip archive)');
  }

  // Entries by normalized name so `printer\\x.json` and `printer/x.json` both resolve.
  const entries = new Map<string, JSZip.JSZipObject>();
  for (const f of Object.values(zip.files)) if (!f.dir) entries.set(norm(f.name), f);

  const index = entries.get('bundle_structure.json');
  if (!index) throw new BundleError('Bundle is missing bundle_structure.json');

  let structure: Record<string, unknown>;
  try {
    structure = JSON.parse(await index.async('string'));
  } catch {
    throw new BundleError('bundle_structure.json is not valid JSON');
  }
  if (!structure || typeof structure !== 'object' || Array.isArray(structure)) {
    throw new BundleError('bundle_structure.json is not a JSON object');
  }

  const result: BundleParseResult = { presets: [], skipped: [] };
  const seen = new Set<string>();

  for (const [section, kind] of SECTIONS) {
    const listed = structure[section];
    if (listed === undefined) continue;
    if (!isStringArray(listed)) {
      result.skipped.push({ name: section, reason: `${section} must be a list of file paths` });
      continue;
    }
    for (const rawPath of listed) {
      const preset = await readPreset(entries, rawPath, kind, result.skipped);
      if (!preset) continue;
      const key = `${preset.kind}:${preset.name}`;
      if (seen.has(key)) {
        result.skipped.push({ name: rawPath, reason: `Duplicate ${kind.toLowerCase()} preset "${preset.name}" in the bundle` });
        continue;
      }
      seen.add(key);
      result.presets.push(preset);
    }
  }

  if (result.presets.length === 0 && result.skipped.length === 0) {
    throw new BundleError('Bundle lists no presets');
  }
  return result;
}

async function readPreset(
  entries: Map<string, JSZip.JSZipObject>,
  rawPath: string,
  kind: SlicerProfileKind,
  skipped: BundleParseResult['skipped'],
): Promise<ParsedPreset | null> {
  const skip = (reason: string) => {
    skipped.push({ name: rawPath, reason });
    return null;
  };
  if (!isSafeEntryPath(rawPath)) return skip('Unsafe path in bundle');
  const entry = entries.get(norm(rawPath));
  if (!entry) return skip('Listed in bundle_structure.json but not in the archive');

  const text = await entry.async('string');
  if (Buffer.byteLength(text) > MAX_PRESET_BYTES) return skip('Preset is larger than 1 MB');

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return skip('Not valid JSON');
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return skip('Preset is not a JSON object');

  const obj = json as Record<string, unknown>;
  const unsafe = firstUnsafeKey(obj);
  if (unsafe) return skip(`"${unsafe}" is not a string or a list of strings`);

  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (!name) return skip('Preset has no "name"');
  if (name.length > 200) return skip('Preset name is longer than 200 characters');

  const inherits = typeof obj.inherits === 'string' && obj.inherits.trim() ? obj.inherits.trim() : null;
  return { kind, name, inherits, json: obj as PresetJson };
}
