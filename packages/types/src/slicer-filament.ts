/**
 * The filament a slicer file names for one slot, and how an import maps it to
 * the shop's filaments. The api parses the identity (file-parser/slicer-filament)
 * and matches it (products/slicer-materials); the 3MF wizard and the G-code
 * confirm step show the mapping with `filamentMatchText`. Pure.
 */

/** One slot's filament as Bambu Studio / OrcaSlicer / PrusaSlicer write it. */
export interface SlicerFilament {
  /** filament_settings_id without " @printer" and "(project.3mf)": 'eSUN PLA+ Fire Engine Red'. */
  profile: string | null;
  /** filament_vendor; null for Generic, (Undefined) or blank. */
  vendor: string | null;
  /** filament_type as written ('PLA+', 'PETG-CF'). */
  type: string | null;
  /** RRGGBB, upper case, no hash. */
  colorHex: string | null;
  /** The profile's colour words: 'eSUN PLA+ Fire Engine Red' → 'Fire Engine Red'; null when it names none. */
  colorName: string | null;
}

/**
 * How a slot found its filament, in match order:
 * NAME brand + colour name + type · HEX type + exact hex · BRAND_CLOSEST brand + type + ΔE ≤ 10 ·
 * CLOSEST type + ΔE ≤ 10 · COLOUR_NAME type + colour name · TYPE_ONLY the file has no colour at all ·
 * SAME_IDENTITY the filament it would create already exists (brand + type + colour).
 */
export type FilamentMatchHow = 'NAME' | 'HEX' | 'BRAND_CLOSEST' | 'CLOSEST' | 'COLOUR_NAME' | 'TYPE_ONLY' | 'SAME_IDENTITY';

export interface FilamentMatchMaterial {
  id: string;
  name: string;
  type: string;
  brand: string | null;
  color: string | null;
  colorHex: string | null;
}

/** One slot of an analysed file and what the import will do with it. Exactly one of `material` / `create` is set. */
export interface FilamentSlotMatch {
  /** 0-based slot (tool) index. */
  index: number;
  file: SlicerFilament;
  material: FilamentMatchMaterial | null;
  how: FilamentMatchHow | null;
  /** The filament the import creates (cost 0 until set). */
  create: { name: string; brand: string | null; color: string | null; colorHex: string | null } | null;
}

const HOW_TEXT: Record<FilamentMatchHow, string> = {
  NAME: 'exact',
  HEX: 'exact',
  BRAND_CLOSEST: 'closest colour',
  CLOSEST: 'closest colour',
  COLOUR_NAME: 'same colour name',
  TYPE_ONLY: 'same type, no colour in the file',
  SAME_IDENTITY: 'same filament',
};

/** Exact (by brand + colour name, or by hex) needs no second look; a nearest colour or a new filament does. */
export function isExactFilamentMatch(m: FilamentSlotMatch): boolean {
  return m.how === 'NAME' || m.how === 'HEX';
}

/** 'eSUN PLA+ Fire Engine Red', else the type and hex the file gives: 'PLA #CC3A2F'. */
export function slicerFilamentLabel(f: SlicerFilament): string {
  const profile = (f.profile ?? '').trim();
  const base = profile || [f.vendor, f.type].filter(Boolean).join(' ') || 'Filament';
  if (f.colorName && !base.toLowerCase().includes(f.colorName.toLowerCase())) return `${base} ${f.colorName}`;
  if (!f.colorName && f.colorHex) return `${base} #${f.colorHex}`;
  return base;
}

/**
 * The shop filament as the Filaments list reads it: brand, type and colour
 * ('eSun PLA Fire Engine Red'), since names often aren't colours ('PLA Red',
 * 'eSUN PLA'); its name, brand in front, when it has no colour.
 */
export function shopFilamentLabel(m: { name: string; type: string; brand: string | null; color: string | null }): string {
  const brand = (m.brand ?? '').trim();
  const color = (m.color ?? '').trim();
  if (color) return [brand, m.type, color].filter(Boolean).join(' ');
  return brand && !m.name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${m.name}` : m.name;
}

/**
 * 'eSUN PLA+ Fire Engine Red → your eSun PLA Fire Engine Red (exact)', or
 * '… → new filament eSUN PLA+ Peach Pink (cost 0 — set it after)'.
 */
export function filamentMatchText(m: FilamentSlotMatch): string {
  const from = slicerFilamentLabel(m.file);
  if (m.material) return `${from} → your ${shopFilamentLabel(m.material)} (${HOW_TEXT[m.how ?? 'NAME']})`;
  return `${from} → new filament ${m.create?.name ?? 'Filament'} (cost 0 — set it after)`;
}
