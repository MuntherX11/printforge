/**
 * Colour matching for filament substitution.
 *
 * Two tiers. When both filaments have a hex — which they do once they come from
 * the swatch catalogue — distance is CIE76 Delta E in LAB space, which is
 * perceptual: "Fire Engine Red" (#91202B) and "Red" (#C4402A) are a real
 * distance apart rather than both collapsing to pure red.
 *
 * When a hex is missing, it falls back to matching the colour name against a
 * small palette. That is coarse — every named red is identical to it — so it
 * exists only so filaments entered by hand before the catalogue still get some
 * kind of suggestion.
 */

/** Rough RGB for common colour words, used only when no hex is available. */
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

/** "#91202B" / "91202b" -> [145, 32, 43]. Null if it isn't a 6-digit hex. */
export function hexToRgb(hex?: string | null): [number, number, number] | null {
  if (!hex) return null;
  const h = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** sRGB (0-255) to CIE L*a*b*, D65 white point. */
export function rgbToLab([r, g, b]: [number, number, number]): [number, number, number] {
  // sRGB companding
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r), G = lin(g), B = lin(b);

  // Linear RGB to XYZ
  let x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  let y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750) / 1.0;
  let z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883;

  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  x = f(x); y = f(y); z = f(z);

  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export function hexToLab(hex?: string | null): [number, number, number] | null {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToLab(rgb) : null;
}

/**
 * CIE76 Delta E between two hex colours. Roughly: under ~2 is imperceptible,
 * ~10 reads as the same colour family, over ~30 is plainly a different colour.
 */
export function deltaE(hexA?: string | null, hexB?: string | null): number | null {
  const a = hexToLab(hexA);
  const b = hexToLab(hexB);
  if (!a || !b) return null;
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

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
 * How far apart two filaments look. Prefers Delta E on the hex values and only
 * falls back to comparing colour names when a hex is missing.
 *
 * The two scales are not interchangeable, so a caller must not rank a
 * hex-derived distance against a name-derived one — `comparable` says which
 * scale produced the number.
 */
export function filamentColourDistance(
  a: { colour?: string | null; hex?: string | null },
  b: { colour?: string | null; hex?: string | null },
): { distance: number; basis: 'hex' | 'name' } | null {
  const dE = deltaE(a.hex, b.hex);
  if (dE !== null) return { distance: dE, basis: 'hex' };

  const ra = colourToRgb(a.colour);
  const rb = colourToRgb(b.colour);
  if (!ra || !rb) return null;
  const rgbDist = Math.sqrt((ra[0] - rb[0]) ** 2 + (ra[1] - rb[1]) ** 2 + (ra[2] - rb[2]) ** 2);
  return { distance: rgbDist, basis: 'name' };
}

/**
 * Squared RGB distance between two colour names. Retained for callers that
 * only ever have names; prefer filamentColourDistance.
 */
export function colourDistance(a?: string | null, b?: string | null): number | null {
  const ra = colourToRgb(a);
  const rb = colourToRgb(b);
  if (!ra || !rb) return null;
  return (ra[0] - rb[0]) ** 2 + (ra[1] - rb[1]) ** 2 + (ra[2] - rb[2]) ** 2;
}
