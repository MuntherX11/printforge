import type { MaterialLite, PlateSlotMatch, Problem, SlotColourSource } from '@printforge/types';
import { COLOUR_RGB, colourToRgb, deltaE } from '../common/utils/colour';
import { catalogueSwatchFor, type CatalogueSwatchRow } from '../inventory/catalogue-swatch';
import { hexToColorName, MAX_MATCH_DELTA_E, normaliseHex } from './slicer-materials';

/**
 * A converted plate's filament per colour (O8). A plate layout's slots must be
 * the part's own colour indexes (the resolver ignores any other set), so this
 * always returns exactly one slot per part colour, with grams summing to the
 * plate grams. A plate file's tools are matched to the part's filaments by
 * colour; failing that by position, failing that split like one unit. Pure.
 */

export interface SlotColour {
  /** RRGGBB, upper case; null when the colour is only known by name */
  hex: string | null;
  source: SlotColourSource | null;
  /** "{brand} {colour} {type}" of the catalogue swatch used */
  swatch: string | null;
  /** the palette colour word the filament's colour name resolves to (NAME) */
  name: string | null;
}

export interface PartSlot {
  colorIndex: number;
  material: MaterialLite | null;
  perUnitGrams: number;
}

export interface FileTool {
  index: number;
  /** RRGGBB or null */
  colorHex: string | null;
  grams: number;
}

export interface MatchedSlot {
  colorIndex: number;
  gramsUsed: number;
  tools: FileTool[];
  colour: SlotColour;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const NONE: SlotColour = { hex: null, source: null, swatch: null, name: null };

/** A filament's colour: its own hex, its catalogue swatch (brand + colour name), its colour name's palette word. */
export function slotColourOf(material: MaterialLite | null, swatches: readonly CatalogueSwatchRow[]): SlotColour {
  if (!material) return NONE;
  const own = normaliseHex(material.colorHex);
  if (own) return { hex: own, source: 'FILAMENT', swatch: null, name: null };
  const sw = catalogueSwatchFor(material, swatches);
  const swHex = sw ? normaliseHex(sw.hex) : null;
  if (sw && swHex) return { hex: swHex, source: 'CATALOGUE', swatch: `${sw.brand} ${sw.colour} ${sw.type}`, name: null };
  const rgb = colourToRgb(material.color);
  const word = rgb ? Object.keys(COLOUR_RGB).find((k) => COLOUR_RGB[k] === rgb) ?? null : null;
  if (word) return { hex: null, source: 'NAME', swatch: null, name: word };
  return NONE;
}

/** Grams per slot in `weights` proportions, scaled to `total` (equal split when they are all 0). */
function scaled(slots: PartSlot[], weight: (s: PartSlot) => number, total: number): number[] {
  const w = slots.map((s) => Math.max(0, weight(s)));
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((x) => round2(sum > 0 ? (x / sum) * total : total / slots.length));
}

/** Best slot per tool by colour (ΔE on hexes, the palette word on names); null when a tool can't be placed. */
function byColour(S: PartSlot[], T: FileTool[], colours: SlotColour[]): Map<number, FileTool[]> | null {
  const out = new Map<number, FileTool[]>(S.map((s) => [s.colorIndex, []]));
  for (const t of T) {
    if (!t.colorHex) return null;
    const word = hexToColorName(t.colorHex);
    const scored: Array<{ colorIndex: number; score: number; name: boolean }> = [];
    S.forEach((s, i) => {
      const c = colours[i];
      if (c.hex) {
        const d = deltaE(c.hex, t.colorHex);
        if (d !== null && d <= MAX_MATCH_DELTA_E) scored.push({ colorIndex: s.colorIndex, score: d, name: false });
      } else if (c.name && c.name === word) {
        scored.push({ colorIndex: s.colorIndex, score: 100, name: true });
      }
    });
    if (!scored.length) return null;
    const best = Math.min(...scored.map((x) => x.score));
    const tied = scored.filter((x) => x.score === best);
    // Two filaments known only by the same colour word: which one printed is a guess.
    if (tied.length > 1 && tied[0].name) return null;
    const pick = tied.find((x) => x.colorIndex === t.index) ?? tied[0];
    out.get(pick.colorIndex)!.push(t);
  }
  return [...out.values()].every((list) => list.length > 0) ? out : null;
}

/**
 * Slots of a converted plate. `S` = the part's slots (one entry, colour 0, for
 * a single-material part); `T` = the file's used tools (grams > 0).
 */
export function matchPlateSlots(
  desc: string,
  S: PartSlot[],
  T: FileTool[],
  plateGrams: number,
  swatches: readonly CatalogueSwatchRow[],
): { slots: MatchedSlot[]; match: PlateSlotMatch; warnings: Problem[] } {
  const colours = S.map((s) => slotColourOf(s.material, swatches));
  const build = (grams: number[], tools: (s: PartSlot) => FileTool[]): MatchedSlot[] =>
    S.map((s, i) => ({ colorIndex: s.colorIndex, gramsUsed: grams[i], tools: tools(s), colour: colours[i] }));
  const perUnit = () => scaled(S, (s) => s.perUnitGrams, plateGrams);

  if (S.length === 1) {
    const warnings: Problem[] = T.length > 1
      ? [{ code: 'PLATE_EXTRA_FILAMENTS', message: `"${desc}" has one filament but the file prints ${T.length} — all ${round2(plateGrams)} g are booked on ${S[0].material?.name ?? 'its filament'}` }]
      : [];
    return { slots: build([round2(plateGrams)], () => T), match: 'SINGLE', warnings };
  }
  if (!T.length) return { slots: build(perUnit(), () => []), match: 'SPLIT', warnings: [] };

  const matched = byColour(S, T, colours);
  if (matched) {
    const grams = scaled(S, (s) => matched.get(s.colorIndex)!.reduce((a, t) => a + t.grams, 0), plateGrams);
    return { slots: build(grams, (s) => matched.get(s.colorIndex)!), match: 'FILE_COLOURS', warnings: [] };
  }

  const toolIdx = [...new Set(T.map((t) => t.index))].sort((a, b) => a - b);
  const slotIdx = S.map((s) => s.colorIndex).sort((a, b) => a - b);
  if (toolIdx.length === slotIdx.length && toolIdx.every((v, i) => v === slotIdx[i])) {
    const at = (s: PartSlot) => T.filter((t) => t.index === s.colorIndex);
    const grams = scaled(S, (s) => at(s).reduce((a, t) => a + t.grams, 0), plateGrams);
    return {
      slots: build(grams, at),
      match: 'FILE_ORDER',
      warnings: [{ code: 'PLATE_COLOURS_BY_POSITION', message: `"${desc}": the file's colours couldn't be matched to its filaments — matched by position (tool 1 → colour 1, …)` }],
    };
  }
  return {
    slots: build(perUnit(), () => []),
    match: 'SPLIT',
    warnings: [{ code: 'PLATE_COLOURS_SPLIT', message: `"${desc}": the file's filaments don't match its colours — filament per colour is split like one unit` }],
  };
}
