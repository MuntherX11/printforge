/**
 * How many copies of a part to ask the slicer for when the owner says "fill
 * the plate" (slicer plan D12). A grid estimate from the part's XY bounding
 * box and the printer's bed, padded so the slicer's own arrange — which packs
 * tighter than a grid — has enough copies to work with; what does not fit is
 * dropped by the slicer, not by us.
 *
 * Pure: no fetching, no React.
 */

export const FILL_PLATE_DEFAULT_GAP_MM = 5;
export const FILL_PLATE_DEFAULT_MARGIN_PCT = 20;
export const FILL_PLATE_DEFAULT_CAP = 500;

export interface FillPlateBbox {
  x: number;
  y: number;
}

/**
 * The bed, either as its size or in Orca's `printable_area` form: the bed's
 * corner points as "XxY" strings, e.g. ["0x0", "220x0", "220x220", "0x220"].
 */
export type FillPlatePrintableArea = string[] | FillPlateBbox;

export interface FillPlateOptions {
  /** Extra copies over the grid estimate, in percent. Default 20. */
  marginPct?: number;
  /** Space the slicer keeps between parts, in mm. Default 5. */
  gapMm?: number;
  /** Most copies ever asked for. Default 500. */
  cap?: number;
}

const finitePositive = (n: number): boolean => Number.isFinite(n) && n > 0;

/** Width and height of the bed, or null when it cannot be read. */
export function printableAreaSize(area: FillPlatePrintableArea): FillPlateBbox | null {
  if (!Array.isArray(area)) {
    return finitePositive(area?.x) && finitePositive(area?.y) ? { x: area.x, y: area.y } : null;
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (const point of area) {
    const m = /^\s*(-?[\d.]+)\s*x\s*(-?[\d.]+)\s*$/i.exec(String(point));
    if (!m) return null;
    const x = Number(m[1]);
    const y = Number(m[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    xs.push(x);
    ys.push(y);
  }
  if (xs.length < 2) return null;
  const size = { x: Math.max(...xs) - Math.min(...xs), y: Math.max(...ys) - Math.min(...ys) };
  return finitePositive(size.x) && finitePositive(size.y) ? size : null;
}

/** Copies of a (w x h) part laid out as a grid with `gap` between them, in either orientation. */
function gridCopies(bed: FillPlateBbox, part: FillPlateBbox, gap: number): number {
  const fit = (w: number, h: number) => Math.floor(bed.x / (w + gap)) * Math.floor(bed.y / (h + gap));
  return Math.max(fit(part.x, part.y), fit(part.y, part.x));
}

/**
 * Copies to request: grid copies (the better of the two orientations) plus
 * the margin, rounded up and clamped to [1, cap]. A bbox or bed that cannot
 * be read, or is zero, negative or non-finite, estimates 1.
 */
export function fillPlateEstimate(bbox: FillPlateBbox, printableArea: FillPlatePrintableArea, opts: FillPlateOptions = {}): number {
  // An option that is missing or unreadable falls back to its default.
  const { gapMm, marginPct, cap: capOpt } = opts;
  const gap = typeof gapMm === 'number' && Number.isFinite(gapMm) && gapMm >= 0 ? gapMm : FILL_PLATE_DEFAULT_GAP_MM;
  const margin = typeof marginPct === 'number' && Number.isFinite(marginPct) && marginPct >= 0 ? marginPct : FILL_PLATE_DEFAULT_MARGIN_PCT;
  const cap = typeof capOpt === 'number' && finitePositive(capOpt) ? Math.floor(capOpt) : FILL_PLATE_DEFAULT_CAP;

  if (!bbox || !finitePositive(bbox.x) || !finitePositive(bbox.y)) return 1;
  const bed = printableAreaSize(printableArea);
  if (!bed) return 1;

  const copies = Math.ceil(gridCopies(bed, bbox, gap) * (1 + margin / 100));
  if (!Number.isFinite(copies)) return 1;
  return Math.min(Math.max(copies, 1), Math.max(cap, 1));
}
