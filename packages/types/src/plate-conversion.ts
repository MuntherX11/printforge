/**
 * Convert to plate (O8a preview GET, O8 POST
 * /products/:id/variants/:variantId/convert-to-layout): a legacy size option
 * that is really "N per plate" becomes a plate layout on one part, and the
 * option is switched off with its history kept.
 *
 * Pure: the api returns these shapes, and the app's dialog prefills its form
 * with the helpers below.
 */
import type { ComponentPlateLayout, MaterialLite, Problem, SurplusPolicy } from './index';

/** A size's conversion marker. label null = the layout was deleted since. */
export interface SizeConvertedTo {
  layoutId: string;
  /** "BASE ×50"; null = the layout no longer exists */
  label: string | null;
  layoutActive: boolean;
}

/** Converted = marked AND its layout still exists (a live conversion). */
export function isConverted(s: { convertedTo: SizeConvertedTo | null }): boolean {
  return !!s.convertedTo && s.convertedTo.label !== null;
}

/** How the plate's filament per colour was worked out. */
export type PlateSlotMatch = 'SINGLE' | 'FILE_COLOURS' | 'FILE_ORDER' | 'SPLIT';

/** Where a slot's colour came from: the filament's hex, its catalogue swatch, or its colour name. */
export type SlotColourSource = 'FILAMENT' | 'CATALOGUE' | 'NAME';

export interface LayoutConversionBody {
  componentId: string;
  unitsPerPlate: number;
  plateMinutes: number;
  plateGrams: number;
  colorChanges?: number;
  assembledUploadId?: string;
  /** POST only; omitted = the preview's recommendActive */
  isActive?: boolean;
}

/** One plan for N units of the part: plates by size, minutes, grams and extra units. */
export interface PlanSummary {
  plates: Array<{ unitsPerPlate: number; plateCount: number }>;
  minutes: number;
  grams: number;
  extra: number;
}

export interface LayoutConversionSlot {
  colorIndex: number;
  gramsUsed: number;
  material: MaterialLite | null;
  colour: { hex: string | null; source: SlotColourSource | null; swatch: string | null };
  /** the file's tools booked on this slot (none without a file) */
  tools: Array<{ index: number; colorHex: string | null; grams: number }>;
}

export interface LayoutConversionPreview {
  option: {
    id: string;
    name: string;
    isActive: boolean;
    legacyPrice: number | null;
    estimatedGrams: number | null;
    estimatedMinutes: number | null;
  };
  component: {
    id: string;
    description: string;
    sizeOptionId: string | null;
    isMultiColour: boolean;
    gramsPerUnit: number;
    minutesPerUnit: number;
  };
  layout: {
    name: string;
    unitsPerPlate: number;
    plateMinutes: number;
    plateGrams: number;
    colorChanges: number;
    source: 'GCODE' | 'MANUAL';
    objectCount: number | null;
    gcodeFilename: string | null;
    minutesPerUnit: number;
    gramsPerUnit: number;
    slots: LayoutConversionSlot[];
  };
  slotMatch: PlateSlotMatch;
  recommendActive: boolean;
  planning: {
    surplusPolicy: SurplusPolicy;
    /** the sizes whose jobs plan this part */
    appliesTo: string[];
    rows: Array<{ units: number; now: PlanSummary | null; withPlate: PlanSummary }>;
  };
  history: { orderLines: number; quoteLines: number; jobs: number };
  /** open order lines with units left to plan, and DRAFT/SENT quote lines, on this option */
  openLines: {
    total: number;
    lines: Array<{ kind: 'ORDER' | 'QUOTE'; number: string; quantity: number; partlyPlanned: boolean }>;
  };
  warnings: Problem[];
}

export interface LayoutConversionResult {
  layout: ComponentPlateLayout;
  option: { id: string; name: string; isActive: false; convertedLayoutId: string };
  warnings: Problem[];
}

// ---------------------------------------------------------------- prefills

/** The option's grams per unit must be within this band of the part's for a count in its name to be believed. */
export const NAME_COUNT_BAND = { min: 0.5, max: 3 } as const;

/**
 * The plate count a name carries: exactly one whole-number token of 2–500
 * ("b50" → 50, "Box x 12" → 12). "fish 1", "60%", "0.4", "1 of 50" → null.
 */
export function plateCountInName(name: string): number | null {
  const tokens = name.match(/\d+(?:[.,]\d+)?%?/g) ?? [];
  const pure = tokens.filter((t) => /^\d+$/.test(t));
  if (pure.length !== 1) return null;
  const n = Number(pure[0]);
  return n >= 2 && n <= 500 ? n : null;
}

export type UnitsPrefillSource = 'FILE' | 'NAME' | 'WEIGHT';

/**
 * Units on the plate, in order: the file's object labels; the count in the
 * option's name when its grams per unit agree with the part's (within
 * NAME_COUNT_BAND, or when there are no grams to compare); the option's grams
 * over the part's, rounded down (plate grams include purge and brim).
 */
export function unitsPerPlatePrefill(input: {
  optionName: string;
  optionGrams: number | null;
  componentGrams: number | null;
  objectCount: number | null;
}): { units: number | null; source: UnitsPrefillSource | null; ratio: number | null } {
  const og = input.optionGrams ?? 0;
  const cg = input.componentGrams ?? 0;
  const ratio = og > 0 && cg > 0 ? og / cg : null;
  if (input.objectCount !== null && input.objectCount >= 1) return { units: input.objectCount, source: 'FILE', ratio };
  const weight = ratio !== null && ratio >= 1 ? Math.min(500, Math.floor(ratio)) : null;
  const n = plateCountInName(input.optionName);
  if (n !== null) {
    const perUnit = ratio === null ? null : og / n / cg;
    if (perUnit === null || (perUnit >= NAME_COUNT_BAND.min && perUnit <= NAME_COUNT_BAND.max)) return { units: n, source: 'NAME', ratio };
  }
  if (weight !== null) return { units: weight, source: 'WEIGHT', ratio };
  return { units: null, source: null, ratio };
}

const wordsOf = (s: string): string[] => s.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);

/**
 * The part an option most likely is: the only part; else the one part all of
 * whose description words appear in the option's name ("Box x 12" → Box,
 * "fish 1" → Fish); else null.
 */
export function defaultPartFor<T extends { id: string; description: string }>(optionName: string, parts: T[]): T | null {
  if (parts.length === 1) return parts[0];
  const name = new Set(wordsOf(optionName));
  const hits = parts.filter((p) => {
    const w = wordsOf(p.description);
    return w.length > 0 && w.every((x) => name.has(x));
  });
  return hits.length === 1 ? hits[0] : null;
}
