/**
 * The catalogue swatch of a filament: same brand AND same colour name (case
 * and punctuation ignored), preferring the same filament type. Never a guess
 * from the colour name alone — that is the sloppiness a hex is meant to
 * remove. Pure; shared by the Filaments page's hex suggestions and the plate
 * conversion's colour matching.
 */

export interface CatalogueSwatchRow {
  brand: string;
  colour: string;
  type: string;
  hex: string;
}

/** Lower case, letters and digits only ("Bambu Lab" → "bambulab"). */
export const normSwatch = (s?: string | null): string => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function catalogueSwatchFor<T extends CatalogueSwatchRow>(
  material: { brand?: string | null; color?: string | null; type?: string | null },
  swatches: readonly T[],
): T | null {
  const brand = normSwatch(material.brand);
  const colour = normSwatch(material.color);
  if (!brand || !colour) return null;
  const same = swatches.filter((s) => normSwatch(s.brand) === brand && normSwatch(s.colour) === colour);
  if (!same.length) return null;
  const type = normSwatch(material.type);
  return same.find((s) => normSwatch(s.type) === type) ?? same[0];
}
