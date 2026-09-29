/**
 * Edit Material's brand and colour (safety spec §4). The dialog reuses the
 * New Material dropdowns (FilamentBrandColour) unchanged; these pure helpers
 * decide how a stored filament opens in them and what a save sends.
 *
 * - The dialog starts from the stored values and is "dirty" only after the
 *   user really changes brand or colour. An untouched dialog sends no brand,
 *   color or colorHex, so all three stay exactly as stored.
 * - A stored brand or colour the dropdown doesn't offer opens as "Other…" with
 *   its text filled in, instead of silently showing the first option.
 *
 * Pure and DOM-free: the app uses it in the browser and the api jest suite
 * tests it (through the '@printforge/types' moduleNameMapper).
 */

/** The dialog's brand/colour/hex state. `dirty` turns true on a real edit. */
export interface EditIdentity {
  dirty: boolean;
  brand: string;
  colour: string;
  /** Bare or '#'-prefixed six-digit hex, or ''. */
  hex: string;
}

/** The stored filament fields the dialog starts from. */
export interface EditIdentitySource {
  brand?: string | null;
  color?: string | null;
  colorHex?: string | null;
}

/** One catalogue swatch, as far as the dropdown lists need it. */
export interface CatalogueSwatchRef {
  /** The catalogue's own type name ('PLA Matte', 'PETG-HS', …). */
  type: string;
  brand: string;
  colour: string;
}

/** Which dropdown must open on "Other…": none, Brand (which also opens Color), or Color. */
export type EditOtherMode = 'none' | 'brand' | 'colour';

export interface OtherModeInput {
  swatches: readonly CatalogueSwatchRef[];
  /** Maps a catalogue type onto a material type (the picker's toMaterialType). */
  toType: (catalogueType: string) => string;
  /** The material type selected in the dialog ('PLA' … 'OTHER'). */
  type: string;
  brand: string;
  colour: string;
}

/** The dialog's starting state: the stored values, not dirty. */
export function initialIdentity(material: EditIdentitySource): EditIdentity {
  return {
    dirty: false,
    brand: material.brand ?? '',
    colour: material.color ?? '',
    hex: material.colorHex ?? '',
  };
}

/**
 * Mirrors the dropdowns' lists: brands are the ones with a swatch of this
 * type, and colours are that type's colours, narrowed to the brand when one
 * is set. Comparison is exact, as the native select's is.
 * - 'brand' when the brand is set and not offered for this type;
 * - otherwise 'colour' when the colour is set and not offered;
 * - otherwise 'none'.
 */
export function otherModeFor({ swatches, toType, type, brand, colour }: OtherModeInput): EditOtherMode {
  const forType = swatches.filter((s) => toType(s.type) === type);
  if (brand !== '' && !forType.some((s) => s.brand === brand)) return 'brand';
  if (colour !== '' && !forType.some((s) => (!brand || s.brand === brand) && s.colour === colour)) return 'colour';
  return 'none';
}

/**
 * The brand, color and colorHex a save sends, or null when the user never
 * changed them (then the save sends none of the three). Values are trimmed,
 * the hex loses its '#', and '' is kept (the server stores '' as null).
 */
export function identityFields(v: EditIdentity): { brand: string; color: string; colorHex: string } | null {
  if (!v.dirty) return null;
  return {
    brand: v.brand.trim(),
    color: v.colour.trim(),
    colorHex: v.hex.trim().replace(/^#/, ''),
  };
}
