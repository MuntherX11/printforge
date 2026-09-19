import { COLOUR_RGB, deltaE, hexToRgb } from '../common/utils/colour';

/**
 * Filament matching for slicer imports (spec §3.12 "Material matching"). Pure:
 * the onboarding service creates what `matchMaterial` can't find, inside its
 * import transaction, and reports it.
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
  color: string | null;
  colorHex: string | null;
}

export const MAX_MATCH_DELTA_E = 10;

/**
 * Match order (§3.12): 1 same type and equal hex; 2 same type, smallest ΔE ≤ 10;
 * 3 same type and legacy colour name = hexToColorName; 4 no colour info → first
 * material of the type by name; otherwise null (the caller creates one).
 */
export function matchMaterial<M extends MatchableMaterial>(materials: M[], type: MaterialTypeValue, rawHex: unknown): M | null {
  const same = materials.filter((m) => m.type === type);
  const hex = normaliseHex(rawHex);
  if (!hex) {
    return [...same].sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1))[0] ?? null;
  }
  const exact = same.find((m) => normaliseHex(m.colorHex) === hex);
  if (exact) return exact;
  let best: M | null = null;
  let bestD = Infinity;
  for (const m of same) {
    const d = deltaE(normaliseHex(m.colorHex), hex);
    if (d !== null && d <= MAX_MATCH_DELTA_E && d < bestD) {
      best = m;
      bestD = d;
    }
  }
  if (best) return best;
  const name = hexToColorName(hex).toLowerCase();
  return same.find((m) => (m.color ?? '').trim().toLowerCase() === name) ?? null;
}

/** Data for a filament the import has to create (cost 0 → blocking MATERIAL_ZERO_COST until set). */
export function newMaterialData(rawType: unknown, type: MaterialTypeValue, rawHex: unknown) {
  const hex = normaliseHex(rawHex);
  const colourName = hex ? hexToColorName(hex) : null;
  const label = String(rawType ?? '').trim().toUpperCase().replace(/[^A-Z0-9+\- ]/g, '').slice(0, 30) || type;
  return { name: `${label} ${colourName ?? 'Unknown'}`, type, color: colourName, colorHex: hex, costPerGram: 0, density: 1.24 };
}
