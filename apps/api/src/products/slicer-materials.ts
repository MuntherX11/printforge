import { normText, SHADE_RGB, type FilamentMatchHow, type FilamentSlotMatch, type SlicerFilament } from '@printforge/types';
import { COLOUR_RGB, deltaE, hexToRgb } from '../common/utils/colour';
import { colourWords } from '../file-parser/slicer-filament';

/**
 * Filament matching for slicer imports (spec §3.12 "Material matching"). Pure:
 * the onboarding service creates what `resolveSlot` can't find, inside its
 * import transaction, and reports it; the analysis endpoints show the same
 * plan (`planFilamentSlots`) before anything is imported.
 */

export const MATERIAL_TYPES = ['PLA', 'PETG', 'ABS', 'TPU', 'ASA', 'NYLON', 'RESIN', 'OTHER'] as const;
export type MaterialTypeValue = (typeof MATERIAL_TYPES)[number];

const NYLON_FAMILY = new Set(['PA', 'PA6', 'PA12', 'PAHT']);
const isEnum = (t: string): t is MaterialTypeValue => (MATERIAL_TYPES as readonly string[]).includes(t);

/**
 * Slicer type → MaterialType: exact enum value; else the prefix before `-`/`+`/
 * space when that is an enum value (`PLA-CF` → PLA, `PETG-CF` → PETG); `PA`,
 * `PA6`, `PA12`, `PAHT`, `PA-CF` → NYLON; anything else → OTHER. Never a value
 * outside the enum, so an exotic slicer type can't fail the Prisma write.
 * An absent type defaults to PLA, as before.
 */
export function normaliseMaterialType(raw: unknown): MaterialTypeValue {
  const t = String(raw ?? '').trim().toUpperCase();
  if (!t) return 'PLA';
  if (isEnum(t)) return t;
  const prefix = t.split(/[-+\s]/)[0];
  if (NYLON_FAMILY.has(t) || NYLON_FAMILY.has(prefix)) return 'NYLON';
  if (isEnum(prefix)) return prefix;
  return 'OTHER';
}

/** `#RRGGBB`, `rrggbb` or Bambu's `#RRGGBBAA` → `RRGGBB` (upper case), else null. */
export function normaliseHex(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let h = raw.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{8}$/.test(h)) h = h.slice(0, 6);
  return /^[0-9a-fA-F]{6}$/.test(h) ? h.toUpperCase() : null;
}

/** Nearest common colour word for a hex (legacy `color` names). */
/**
 * Colour word for NAMING a filament an import creates: the nearest of the
 * common words and the shade names by Delta E (perceptual), so a sardine red
 * #CC3A2F reads "Fire Engine Red" rather than the RGB-nearest "Brown".
 * Matching keeps using hexToColorName, unchanged.
 */
export function nameColourForHex(hex: string): string {
  const toHex = ([r, g, b]: readonly number[]) => [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  let best = hexToColorName(hex);
  let dist = Infinity;
  for (const [name, rgb] of [...Object.entries(COLOUR_RGB), ...Object.entries(SHADE_RGB)]) {
    const d = deltaE(hex, toHex(rgb));
    if (d !== null && d < dist) {
      dist = d;
      best = name;
    }
  }
  return best;
}

export function hexToColorName(hex: string): string {
  const rgb = hexToRgb(hex) ?? [0, 0, 0];
  let best = 'Black';
  let dist = Infinity;
  for (const [name, [r, g, b]] of Object.entries(COLOUR_RGB)) {
    const d = (rgb[0] - r) ** 2 + (rgb[1] - g) ** 2 + (rgb[2] - b) ** 2;
    if (d < dist) {
      dist = d;
      best = name;
    }
  }
  return best;
}

export interface MatchableMaterial {
  id: string;
  name: string;
  type: string;
  brand?: string | null;
  color: string | null;
  colorHex: string | null;
}

export const MAX_MATCH_DELTA_E = 10;

/** Brand aliases after lower-casing and dropping spaces and punctuation. */
const BRAND_ALIASES: Record<string, string> = { bambu: 'bambulab', bbl: 'bambulab', prusapolymers: 'prusa', prusament: 'prusa' };

/** 'eSUN' = 'eSun' = 'E Sun'; 'Bambu' = 'Bambu Lab'; 'Generic', '(Undefined)' and blank → null (no brand). */
export function brandKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const k = raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (!k || k === 'generic' || k === 'undefined' || k === 'none') return null;
  return BRAND_ALIASES[k] ?? k;
}

/** A colour name compared case- and space-insensitively, line words dropped: 'Matte  ivory white' = 'Ivory White'; grey = gray. */
export function colourKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const w = colourWords(raw, null, null);
  return w ? w.toLowerCase().replace(/\bgrey\b/g, 'gray') : null;
}

/** A shop filament's colour name: its colour, else the colour words of its name ('PLA Red' → red). */
function materialColourKey(m: MatchableMaterial): string | null {
  return colourKey(m.color) ?? colourKey(colourWords(m.name, m.brand ?? null, m.type));
}

/** One slot of a slicer file, ready to match. */
export interface SlotFilament {
  rawType: unknown;
  type: MaterialTypeValue;
  hex: string | null;
  vendor: string | null;
  profile: string | null;
  colorName: string | null;
}

/** The slot from its parsed type and hex plus the file's identity, when the file has one. */
export function slotFilament(rawType: unknown, rawHex: unknown, file?: SlicerFilament | null): SlotFilament {
  const raw = rawType ?? file?.type ?? null;
  return {
    rawType: raw,
    type: normaliseMaterialType(raw),
    hex: normaliseHex(rawHex) ?? normaliseHex(file?.colorHex),
    vendor: file?.vendor ?? null,
    profile: file?.profile ?? null,
    colorName: file?.colorName ?? null,
  };
}

export interface MaterialMatch<M> {
  material: M;
  how: FilamentMatchHow;
}

function nearest<M extends MatchableMaterial>(list: M[], hex: string): M | null {
  let best: M | null = null;
  let bestD = Infinity;
  for (const m of list) {
    const d = deltaE(normaliseHex(m.colorHex), hex);
    if (d !== null && d <= MAX_MATCH_DELTA_E && d < bestD) {
      best = m;
      bestD = d;
    }
  }
  return best;
}

const byName = <M extends MatchableMaterial>(list: M[]) => [...list].sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));

/**
 * Match order (owner spec "the 3MF will already have the correct filaments set"),
 * always within the slot's type:
 * 1 brand + colour name (NAME) · 2 exact hex, the slot's brand first (HEX) ·
 * 3 brand + nearest ΔE ≤ 10 (BRAND_CLOSEST) · 4 nearest ΔE ≤ 10 (CLOSEST) ·
 * 5 colour name, any brand (COLOUR_NAME) · 6 only when the file gives no colour
 * at all: the first of the type by name, the slot's brand first (TYPE_ONLY) ·
 * otherwise null (the caller creates one). Brands compare with brandKey and
 * colour names with colourKey; materials keep their given order on ties.
 */
export function matchMaterial<M extends MatchableMaterial>(materials: M[], slot: SlotFilament): MaterialMatch<M> | null {
  const same = materials.filter((m) => m.type === slot.type);
  const brand = brandKey(slot.vendor);
  const sameBrand = same.filter((m) => brandKey(m.brand) === brand);
  const name = colourKey(slot.colorName);
  const hex = slot.hex;

  if (name) {
    const hit = sameBrand.find((m) => materialColourKey(m) === name);
    if (hit) return { material: hit, how: 'NAME' };
  }
  if (hex) {
    const exact = (list: M[]) => list.find((m) => normaliseHex(m.colorHex) === hex);
    const hit = exact(sameBrand) ?? exact(same);
    if (hit) return { material: hit, how: 'HEX' };
    const closeBrand = nearest(sameBrand, hex);
    if (closeBrand) return { material: closeBrand, how: 'BRAND_CLOSEST' };
    const close = nearest(same, hex);
    if (close) return { material: close, how: 'CLOSEST' };
  }
  if (name) {
    const hit = same.find((m) => materialColourKey(m) === name);
    if (hit) return { material: hit, how: 'COLOUR_NAME' };
  }
  if (!hex && !name) {
    const hit = byName(sameBrand)[0] ?? byName(same)[0];
    if (hit) return { material: hit, how: 'TYPE_ONLY' };
  }
  return null;
}

export interface NewMaterialData {
  name: string;
  type: MaterialTypeValue;
  brand: string | null;
  color: string | null;
  colorHex: string | null;
  costPerGram: number;
  density: number;
}

const has = (text: string, part: string) => text.toLowerCase().includes(part.toLowerCase());

/** The profile already says who makes it: 'Bambu PLA Basic' for Bambu Lab, 'Bambulab PLA Red' too. */
function namesVendor(profile: string, vendor: string): boolean {
  if (has(profile, vendor)) return true;
  const first = profile.trim().split(/\s+/)[0] ?? '';
  return has(profile, vendor.trim().split(/\s+/)[0] ?? vendor) || (!!brandKey(first) && brandKey(first) === brandKey(vendor));
}

/**
 * The filament an import creates (cost 0 → blocking MATERIAL_ZERO_COST until
 * set). A file with a vendor or profile gives the real brand (spelled as the
 * shop already spells it), the profile's colour name (else the nearest colour
 * word) and the profile as the name: 'eSUN PLA+ Peach Pink'. A file without
 * either keeps the old '<TYPE> <colour word>' name.
 */
export function newMaterialData(slot: SlotFilament, materials: MatchableMaterial[] = []): NewMaterialData {
  const hex = slot.hex;
  const word = hex ? hexToColorName(hex) : null;
  const base = { type: slot.type, colorHex: hex, costPerGram: 0, density: 1.24 };
  if (!slot.vendor && !slot.profile) {
    const label = String(slot.rawType ?? '').trim().toUpperCase().replace(/[^A-Z0-9+\- ]/g, '').slice(0, 30) || slot.type;
    return { ...base, name: `${label} ${word ?? 'Unknown'}`, brand: null, color: word };
  }
  const key = brandKey(slot.vendor);
  const brand = key ? (materials.find((m) => brandKey(m.brand) === key)?.brand?.trim() || slot.vendor) : null;
  // Branded: name the colour perceptually (a sardine red is 'Fire Engine Red', not 'Brown').
  const color = slot.colorName ?? (hex ? nameColourForHex(hex) : null);
  let name = slot.profile ?? `${String(slot.rawType ?? slot.type).trim() || slot.type}`;
  if (slot.vendor && !namesVendor(name, slot.vendor) && !(brand && has(name, brand))) name = `${slot.vendor} ${name}`;
  if (color && !has(name, color)) name = `${name} ${color}`;
  return { ...base, name: name.slice(0, 120), brand, color };
}

export type SlotResolution<M> = { material: M; how: FilamentMatchHow; create: null } | { material: null; how: null; create: NewMaterialData };

/**
 * What one slot becomes: a match, else the filament it would create — unless
 * that filament's identity (brand, type, colour) already exists, which is
 * reused (SAME_IDENTITY) as the duplicate guard would.
 */
export function resolveSlot<M extends MatchableMaterial>(materials: M[], slot: SlotFilament): SlotResolution<M> {
  const hit = matchMaterial(materials, slot);
  if (hit) return { ...hit, create: null };
  const data = newMaterialData(slot, materials);
  if (data.color) {
    const b = brandKey(data.brand);
    const dup = materials.find((m) => m.type === data.type && brandKey(m.brand) === b && normText(m.color) === normText(data.color));
    if (dup) return { material: dup, how: 'SAME_IDENTITY', create: null };
  }
  return { material: null, how: null, create: data };
}

/** A used slot of an analysed file. */
export interface PlanSlot {
  index: number;
  rawType: unknown;
  rawHex: unknown;
  file?: SlicerFilament | null;
}

const NEW = 'new:';

/**
 * The import's filament plan for the analysis endpoints (read-only): each slot
 * resolved in order, a filament created for an earlier slot reused by a later
 * one exactly as the import does.
 */
export function planFilamentSlots(materials: MatchableMaterial[], slots: PlanSlot[]): FilamentSlotMatch[] {
  const pool: MatchableMaterial[] = [...materials];
  const created = new Map<string, NewMaterialData>();
  return slots.map((s) => {
    const slot = slotFilament(s.rawType, s.rawHex, s.file);
    const file: SlicerFilament = s.file ?? {
      profile: null, vendor: null, type: s.rawType == null ? null : String(s.rawType), colorHex: slot.hex, colorName: null,
    };
    const r = resolveSlot(pool, slot);
    const out = (create: NewMaterialData): FilamentSlotMatch => ({
      index: s.index, file, material: null, how: null,
      create: { name: create.name, brand: create.brand, color: create.color, colorHex: create.colorHex },
    });
    if (r.create) {
      const id = `${NEW}${created.size}`;
      created.set(id, r.create);
      pool.push({ id, name: r.create.name, type: r.create.type, brand: r.create.brand, color: r.create.color, colorHex: r.create.colorHex });
      return out(r.create);
    }
    const pending = created.get(r.material.id);
    if (pending) return out(pending);
    const m = r.material;
    return { index: s.index, file, how: r.how, create: null, material: { id: m.id, name: m.name, type: m.type, brand: m.brand ?? null, color: m.color, colorHex: normaliseHex(m.colorHex) } };
  });
}

/** The import's material snapshot (and the analysis preview's): oldest first, so ties pick the same filament. */
export const MATERIAL_SNAPSHOT = {
  select: { id: true, name: true, type: true, brand: true, color: true, colorHex: true },
  orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
};

/** What a G-code header gives the import: per-slot tools (used ones only) and grams. */
export interface GcodeToolsSource {
  tools?: Array<{ index: number; filamentGrams?: number; colorHex?: string; materialType?: string; filament?: SlicerFilament }>;
  filamentType: string | null;
  filamentUsedGrams: number | null;
  filamentColors?: string[];
  filaments?: SlicerFilament[];
}

/**
 * A G-code file's used slots: tools with grams, else one slot holding the
 * whole weight (single-tool slicers). Shared by the import and its preview.
 */
export function gcodeImportTools(a: GcodeToolsSource) {
  const used = (a.tools ?? []).filter((t) => (t.filamentGrams || 0) > 0).map((t) => ({
    index: t.index, grams: t.filamentGrams || 0, type: t.materialType ?? a.filamentType, hex: t.colorHex ?? null, filament: t.filament ?? null,
  }));
  const grams = a.filamentUsedGrams || used.reduce((s, t) => s + t.grams, 0);
  const first = a.filaments?.[0];
  const tools = used.length ? used : grams > 0
    ? [{ index: 0, grams, type: a.filamentType, hex: a.filamentColors?.[0] ?? null, filament: first && (first.profile || first.vendor) ? first : null }]
    : [];
  return { grams, tools };
}
