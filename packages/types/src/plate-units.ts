/**
 * Units on a sliced plate, read from its G-code object labels (Klipper
 * EXCLUDE_OBJECT_DEFINE, Marlin M486, "; printing object"; the purge tower is
 * never counted). The BOM card's "Upload G-code" and the 3MF import wizard
 * prefill their "units on the plate" with these helpers, so a 12-up plate is
 * imported as one part ×12 rather than one part holding twelve units' grams.
 *
 * Pure: no fetching, no React. The api enforces the same 1–500 bound.
 */

export const PLATE_UNITS_MIN = 1;
export const PLATE_UNITS_MAX = 500;

export interface PlateObjectLabels {
  /** null = the file has no object labels (count unknown, not zero). */
  objectCount?: number | null;
  objectModels?: Array<{ model: string; count: number }> | null;
}

export type PlateUnitsDetection =
  /** Several objects, all one model (or models unnamed): one part ×units. */
  | { kind: 'UNITS'; units: number }
  /** One object: a single unit. */
  | { kind: 'SINGLE' }
  /** Different models on one plate: the count can't be one part's units. */
  | { kind: 'MIXED'; objectCount: number; models: Array<{ model: string; count: number }> }
  /** No labels, or a count outside 1–500: the owner enters it. */
  | { kind: 'UNKNOWN' };

export function detectPlateUnits(labels: PlateObjectLabels): PlateUnitsDetection {
  const n = labels.objectCount;
  if (n === null || n === undefined || !Number.isInteger(n) || n < PLATE_UNITS_MIN) return { kind: 'UNKNOWN' };
  const models = labels.objectModels ?? [];
  if (new Set(models.map((m) => m.model)).size > 1) return { kind: 'MIXED', objectCount: n, models };
  if (n === 1) return { kind: 'SINGLE' };
  if (n > PLATE_UNITS_MAX) return { kind: 'UNKNOWN' };
  return { kind: 'UNITS', units: n };
}

/** The "units on the plate" input's starting text: the count when it is one part's, else ''. */
export function plateUnitsPrefill(labels: PlateObjectLabels): string {
  return detectionPrefill(detectPlateUnits(labels));
}

/** plateUnitsPrefill for an already-made detection. */
export function detectionPrefill(d: PlateUnitsDetection): string {
  if (d.kind === 'UNITS') return String(d.units);
  if (d.kind === 'SINGLE') return '1';
  return '';
}

/** Parse the typed units: null when empty, NaN when not a whole number 1–500. */
export function parsePlateUnits(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = /^\d+$/.test(t) ? Number(t) : NaN;
  return n >= PLATE_UNITS_MIN && n <= PLATE_UNITS_MAX ? n : NaN;
}

export interface GcodeHeaderFigures {
  estimatedTimeSeconds: number | null;
  filamentUsedGrams: number | null;
  tools?: Array<{ filamentGrams?: number | null }> | null;
}

export interface PlateFigures {
  grams: number;
  minutes: number;
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

/** A whole plate's grams and minutes as the G-code import reads them (header total, else the tools' sum). */
export function gcodePlateFigures(a: GcodeHeaderFigures): PlateFigures {
  const toolGrams = (a.tools ?? []).reduce((s, t) => s + (t.filamentGrams && t.filamentGrams > 0 ? t.filamentGrams : 0), 0);
  const grams = a.filamentUsedGrams && a.filamentUsedGrams > 0 ? a.filamentUsedGrams : toolGrams;
  const minutes = a.estimatedTimeSeconds && a.estimatedTimeSeconds > 0 ? Math.round(a.estimatedTimeSeconds / 60) : 0;
  return { grams, minutes };
}

/** One unit's share of a ×units plate, rounded as the import stores it. */
export function perUnitFigures(plate: PlateFigures, units: number): PlateFigures {
  const n = Number.isInteger(units) && units >= PLATE_UNITS_MIN ? units : 1;
  return { grams: round2(plate.grams / n), minutes: round1(plate.minutes / n) };
}

/**
 * Why a plate can't be imported as ×units (the server would refuse it), or
 * null when it can. A single unit always imports; a file without filament
 * weight is skipped by the import whatever its units.
 */
export function plateUnitsProblem(plate: PlateFigures, units: number | null): string | null {
  if (units === null || Number.isNaN(units) || units <= 1 || !(plate.grams > 0)) return null;
  if (!(plate.minutes > 0)) return 'No print time found in this file, so it can\'t be a plate layout — enter 1 or leave it empty';
  return null;
}

/** The BOM row's plate link: "Calibrate plate", or "Plate layouts (×6, ×12)" once it has active layouts. */
export function plateLinkLabel(layouts: Array<{ unitsPerPlate: number; isActive: boolean }>): string {
  const units = [...new Set(layouts.filter((l) => l.isActive).map((l) => l.unitsPerPlate))].sort((a, b) => a - b);
  return units.length ? `Plate layouts (${units.map((u) => `×${u}`).join(', ')})` : 'Calibrate plate';
}
