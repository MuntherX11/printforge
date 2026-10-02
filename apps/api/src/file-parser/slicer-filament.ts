import type { SlicerFilament } from '@printforge/types';

/**
 * A slot's filament identity from slicer files: the G-code header lines
 *   ; filament_settings_id = "eSUN PLA+ Fire Engine Red @BBL X1C";"Bambu PLA Basic @BBL A1"
 *   ; filament_vendor = eSUN;Bambu Lab
 *   ; filament_type = PLA;PLA
 *   ; filament_colour = #C12E1F;#F7E6DE
 * and the same keys as JSON arrays in a 3MF's Metadata/project_settings.config.
 * Pure; the matcher (products/slicer-materials) decides what each slot becomes.
 */

/** Words that name a filament line, finish or a tweak of the profile — never its colour. */
const NOT_COLOUR = new Set([
  'basic', 'matte', 'silk', 'metal', 'plus', 'pro', 'hf', 'hyper', 'speed', 'high', 'rapid', 'lite', 'tough',
  'multi', 'generic', 'template', 'default', 'copy', 'kopieren', 'kopírovat', 'system', 'galaxy', 'sparkle',
  'marble', 'glow', 'wood', 'translucent', 'cf', 'gf', 'flow', 'rate', 'ratio', 'calibrated', 'fan', 'full',
  'aux', 'off', 'nozzle', 'meta', 'support', 'for', 'bbl', 'filament',
]);

/** A material-type token: PLA, PLA+, PETG-CF, PA12, TPU … */
const TYPE_TOKEN = /^(PLA|PETG|PET|PCTG|ABS|ASA|TPU|TPE|PA\d*|PAHT|PC|PVA|HIPS|NYLON|PP|PE|PPS|BVOH)([+-]\S*)?$/i;

const MAX_COLOUR_NAME = 40;
const MAX_PROFILE = 80;

/** `"a";"b"` or `a;b` → ['a', 'b']; quotes removed, entries trimmed (blank entries kept, by position). */
export function splitSlicerList(raw: string): string[] {
  const out: string[] = [];
  const re = /\s*(?:"([^"]*)"|([^;]*))\s*(?:;|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out.push((m[1] ?? m[2] ?? '').trim());
    if (re.lastIndex >= raw.length) break;
  }
  return out;
}

/** 'eSUN PLA+ @BBL X1C(project.3mf)' → 'eSUN PLA+' (everything from the first '@' or '('); null when nothing is left. */
export function cleanProfile(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw
    .replace(/[(@].*$/, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s-]+$/, '')
    .trim();
  return s ? s.slice(0, MAX_PROFILE) : null;
}

/** The vendor, or null for Generic, (Undefined) and blank. */
export function cleanVendor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!s || /^\(?\s*(generic|undefined|none)\s*\)?$/i.test(s)) return null;
  return s.slice(0, 60);
}

const words = (s: string) => s.split(/[\s_/,]+/).map((w) => w.replace(/^[^\p{L}\p{N}+]+|[^\p{L}\p{N}+]+$/gu, '')).filter(Boolean);
const isTypeWord = (w: string, rawType: string | null) =>
  TYPE_TOKEN.test(w) || (!!rawType && w.toUpperCase() === rawType.trim().toUpperCase());
const titleIfLower = (w: string) => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w);

/**
 * The colour words of a text: drop vendor words, type words, line/finish words
 * ('Basic', 'Matte', 'Silk' …), words with digits (printer and nozzle names)
 * and single letters. 'eSUN PLA+ Fire Engine Red' → 'Fire Engine Red'.
 */
export function colourWords(text: string, vendor: string | null, rawType: string | null): string | null {
  const vendorWords = new Set(words(vendor ?? '').map((w) => w.toLowerCase()));
  const kept = words(text).filter((w) => {
    const lower = w.toLowerCase().replace(/\+$/, '');
    if (vendorWords.has(w.toLowerCase()) || isTypeWord(w, rawType) || NOT_COLOUR.has(lower)) return false;
    if (/\d/.test(w) || !/\p{L}/u.test(w)) return false;
    return w.length >= 2;
  });
  const name = kept.map(titleIfLower).join(' ').slice(0, MAX_COLOUR_NAME).trim();
  return name || null;
}

/**
 * The colour a profile names: the words AFTER its type word, minus line words.
 * A profile with no type word is a user's own label ('Plamore', 'No Fan 3')
 * and names no colour. 'Bambu PLA Basic Beige' → 'Beige'; 'eSUN PLA+' → null.
 */
export function profileColourName(profile: string | null, vendor: string | null, rawType: string | null): string | null {
  if (!profile) return null;
  const ws = words(profile);
  let last = -1;
  ws.forEach((w, i) => { if (isTypeWord(w, rawType)) last = i; });
  if (last < 0) return null;
  return colourWords(ws.slice(last + 1).join(' '), vendor, rawType);
}

/** `#RRGGBB` / `#RRGGBBAA` → 'RRGGBB'. */
function hexOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const h = raw.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(h)) return h.slice(0, 6).toUpperCase();
  return null;
}

/** One slot's identity; null when the file says nothing about it. */
export function slicerFilament(rawProfile: unknown, rawVendor: unknown, rawType: unknown, rawHex: unknown): SlicerFilament | null {
  const profile = cleanProfile(rawProfile);
  const vendor = cleanVendor(rawVendor);
  const type = typeof rawType === 'string' && rawType.trim() ? rawType.trim().slice(0, 30) : null;
  const colorHex = hexOf(rawHex);
  if (!profile && !vendor && !type && !colorHex) return null;
  return { profile, vendor, type, colorHex, colorName: profileColourName(profile, vendor, type) };
}

/** Per-slot identities from parallel slicer lists (G-code header or project settings). */
export function slicerFilaments(lists: { profiles: string[]; vendors: string[]; types: string[]; colours: string[] }): SlicerFilament[] {
  const n = Math.max(lists.profiles.length, lists.vendors.length);
  const out: SlicerFilament[] = [];
  for (let i = 0; i < n; i++) {
    const f = slicerFilament(lists.profiles[i], lists.vendors[i], lists.types[i], lists.colours[i]);
    out.push(f ?? { profile: null, vendor: null, type: null, colorHex: null, colorName: null });
  }
  return out;
}

/** The project's filament list from Metadata/project_settings.config (JSON); [] when unreadable. */
export function filamentsFromProjectSettings(text: string): SlicerFilament[] {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text);
  } catch {
    return [];
  }
  const list = (k: string): string[] => {
    const v = j?.[k];
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : ''));
    return typeof v === 'string' ? splitSlicerList(v) : [];
  };
  return slicerFilaments({
    profiles: list('filament_settings_id'),
    vendors: list('filament_vendor'),
    types: list('filament_type'),
    colours: list('filament_colour'),
  });
}
