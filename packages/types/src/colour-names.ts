/**
 * Colour words → RGB. Pure and DOM-free: the api uses it for filament
 * matching, the app uses it to draw a filament's dot when no hex is stored.
 *
 * Two tables:
 * - COLOUR_RGB is the coarse palette the api's colour-name matching has always
 *   used (substitute spools, Convert to plate tool colours, slicer import
 *   names). It must stay exactly as it is, or matching results change.
 * - SHADE_RGB adds common shade names, used only for the approximate dot
 *   (approxColourHex). Nothing it returns is ever stored.
 */

export type Rgb = [number, number, number];

/** Rough RGB for common colour words, used only when no hex is available. */
export const COLOUR_RGB: Record<string, Rgb> = {
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

/** Shade names for the approximate dot only (never used for matching). */
export const SHADE_RGB: Record<string, Rgb> = {
  'Fire Engine Red': [206, 32, 41],
  'Dark Red':        [139, 0, 0],
  Maroon:            [128, 0, 0],
  Rose:              [230, 120, 150],
  'Light Blue':      [140, 195, 235],
  'Sky Blue':        [135, 206, 235],
  'Haze Blue':       [140, 170, 200],
  'Dark Blue':       [0, 40, 120],
  'Royal Blue':      [65, 105, 225],
  Gray:              [128, 128, 128],
  'Dark Grey':       [80, 80, 80],
  'Dark Gray':       [80, 80, 80],
  'Light Grey':      [200, 200, 200],
  'Light Gray':      [200, 200, 200],
  'Cold White':      [240, 246, 255],
  'Bone White':      [227, 218, 201],
  Ivory:             [255, 255, 240],
  Khaki:             [195, 176, 145],
  'Light Khaki':     [215, 200, 160],
  Tan:               [210, 180, 140],
  Sand:              [215, 195, 155],
  Peach:             [255, 203, 164],
  'Peach Pink':      [255, 190, 175],
  Matcha:            [150, 170, 90],
  'Dark Green':      [0, 90, 40],
  Olive:             [128, 128, 0],
  Lime:              [160, 220, 60],
  Mint:              [170, 240, 200],
  Glow:              [170, 255, 140],
  'Glow Green':      [170, 255, 140],
  'Glowing Green':   [170, 255, 140],
  'Light Yellow':    [255, 245, 160],
  Violet:            [143, 0, 255],
  Lavender:          [190, 170, 230],
  Eggplant:          [97, 64, 81],
  Bronze:            [176, 120, 60],
  Copper:            [184, 115, 51],
  Wood:              [160, 115, 75],
  Marble:            [205, 205, 200],
};

/**
 * RGB for a stored colour name, against COLOUR_RGB only. Names are free text,
 * so this matches loosely: exact first, then a containment match, so
 * "Transparent Purple" still reads as purple rather than falling through.
 */
export function colourToRgb(colour?: string | null): Rgb | null {
  if (!colour) return null;
  const c = colour.trim().toLowerCase();
  if (!c) return null;

  for (const [name, rgb] of Object.entries(COLOUR_RGB)) {
    if (name.toLowerCase() === c) return rgb;
  }
  // Longest name wins; ties go to whichever appears first, so "Navy Blue"
  // resolves to Navy rather than Blue — the qualifier leads in most shade
  // names ("Navy Blue", "Sky Blue", "Dark Green").
  let best: Rgb | null = null;
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

/** Words that make a colour see-through: the dot shows the colour lighter. */
const CLEAR_WORDS = ['transparent', 'translucent', 'clear'];
/** How far a see-through colour is moved towards white (0–1). */
const CLEAR_TINT = 0.45;

const PHRASES: Array<{ words: string; rgb: Rgb }> = Object.entries({ ...COLOUR_RGB, ...SHADE_RGB })
  .map(([name, rgb]) => ({ words: name.toLowerCase(), rgb }));

const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0').toUpperCase();

/**
 * An approximate dot colour for a filament known only by its colour name, as a
 * bare upper-case hex ('C3B091'), or null when no colour word is recognised.
 * Whole words only, case-insensitive; the longest phrase wins, ties go to the
 * earliest ("Haze Blue" → haze blue, "Navy Blue" → navy). "Transparent X" is X
 * tinted lighter. Display only: callers never store the result.
 */
export function approxColourHex(name?: string | null): string | null {
  const text = ` ${(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  if (text.trim() === '') return null;
  let best: { len: number; idx: number; rgb: Rgb } | null = null;
  for (const p of PHRASES) {
    const idx = text.indexOf(` ${p.words} `);
    if (idx === -1) continue;
    if (!best || p.words.length > best.len || (p.words.length === best.len && idx < best.idx)) {
      best = { len: p.words.length, idx, rgb: p.rgb };
    }
  }
  if (!best) return null;
  const clear = CLEAR_WORDS.some((w) => text.includes(` ${w} `));
  const [r, g, b] = clear ? best.rgb.map((v) => v + (255 - v) * CLEAR_TINT) : best.rgb;
  return `${hex2(r)}${hex2(g)}${hex2(b)}`;
}
