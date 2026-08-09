/**
 * Filament colour names and their approximate RGB, used to pick the closest
 * available colour when the exact one the slicer asked for is out of stock.
 *
 * Shared with the 3MF/G-code onboarding path, which maps a slicer's hex to the
 * nearest name here — so a substitution and an import agree on what "closest"
 * means.
 */
export const COLOUR_RGB: Record<string, [number, number, number]> = {
  Black:   [0, 0, 0],
  White:   [255, 255, 255],
  Red:     [255, 0, 0],
  Blue:    [0, 0, 255],
  Green:   [0, 128, 0],
  Yellow:  [255, 255, 0],
  Orange:  [255, 128, 0],
  Purple:  [128, 0, 128],
  Pink:    [255, 192, 203],
  Brown:   [128, 64, 0],
  Grey:    [128, 128, 128],
  Silver:  [192, 192, 192],
  Gold:    [255, 215, 0],
  Beige:   [245, 222, 179],
  Cyan:    [0, 206, 209],
  Teal:    [0, 128, 128],
  Navy:    [0, 0, 128],
  Magenta: [255, 0, 255],
  Natural: [240, 225, 200],
};

/**
 * RGB for a stored colour name. Names are free text, so this matches loosely:
 * exact first, then a containment match, so "Transparent Purple" still reads as
 * purple rather than falling through to nothing.
 */
export function colourToRgb(colour?: string | null): [number, number, number] | null {
  if (!colour) return null;
  const c = colour.trim().toLowerCase();
  if (!c) return null;

  for (const [name, rgb] of Object.entries(COLOUR_RGB)) {
    if (name.toLowerCase() === c) return rgb;
  }
  // Longest name wins; ties go to whichever appears first, so "Navy Blue"
  // resolves to Navy rather than Blue — the qualifier leads in most shade
  // names ("Navy Blue", "Sky Blue", "Dark Green").
  let best: [number, number, number] | null = null;
  let bestLen = 0;
  let bestIdx = Infinity;
  for (const [name, rgb] of Object.entries(COLOUR_RGB)) {
    const n = name.toLowerCase();
    const idx = c.indexOf(n);
    if (idx === -1) continue;
    if (n.length > bestLen || (n.length === bestLen && idx < bestIdx)) {
      best = rgb; bestLen = n.length; bestIdx = idx;
    }
  }
  return best;
}

/**
 * Squared RGB distance between two colour names, or null when either colour
 * cannot be placed on the palette. Squared is fine — only the ordering is used.
 */
export function colourDistance(a?: string | null, b?: string | null): number | null {
  const ra = colourToRgb(a);
  const rb = colourToRgb(b);
  if (!ra || !rb) return null;
  return (ra[0] - rb[0]) ** 2 + (ra[1] - rb[1]) ** 2 + (ra[2] - rb[2]) ** 2;
}
