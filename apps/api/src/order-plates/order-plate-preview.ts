import type { OrderPlatePreviewDto } from '@printforge/types';
import type { PlateOutline } from '../file-parser/plate-footprint';

/**
 * The top-down drawing of a plate (v2.19.0). Pure.
 *
 *  - exact: the outlines the slicer wrote into the sliced file, one per object,
 *    each given to the plan row it belongs to;
 *  - sketch: before slicing, every unit's bounding box laid out in rows on the
 *    bed. Positions are not the slicer's — it only shows how full the plate is.
 *
 * Coordinates are bed millimetres from the bed's front-left corner.
 */

export const PREVIEW_MAX_POINTS = 64;
export const SKETCH_GAP_MM = 5;
/** Footprint drawn (and planned) for a part whose size is not known. */
export const UNKNOWN_FOOTPRINT = { x: 40, y: 40 } as const;
/** Most boxes a sketch draws; the rest count as overflow. */
export const SKETCH_MAX_OBJECTS = 1500;

export interface Bed {
  x: number;
  y: number;
  /** The bed's front-left corner in the slicer's coordinates (0,0 on every printer seen so far). */
  originX: number;
  originY: number;
}

/** The bed from Orca's `printable_area` corner points ("0x0", "220x0", ...); null when it cannot be read. */
export function bedOf(area: unknown): Bed | null {
  if (!Array.isArray(area) || area.length < 2) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const point of area) {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*x\s*(-?\d+(?:\.\d+)?)\s*$/i.exec(String(point));
    if (!m) return null;
    xs.push(Number(m[1]));
    ys.push(Number(m[2]));
  }
  const x = Math.max(...xs) - Math.min(...xs);
  const y = Math.max(...ys) - Math.min(...ys);
  if (!(Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0)) return null;
  return { x, y, originX: Math.min(...xs), originY: Math.min(...ys) };
}

/** At most `max` points of a closed outline, evenly taken (the first is always kept). */
export function simplifyPolygon(points: ReadonlyArray<[number, number]>, max = PREVIEW_MAX_POINTS): Array<[number, number]> {
  if (points.length <= max) return points.map(([x, y]) => [x, y]);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < max; i++) {
    const [x, y] = points[Math.floor((i * points.length) / max)];
    out.push([x, y]);
  }
  return out;
}

/**
 * The input a label of a mixed plate belongs to. The slicer container names
 * input k, object j `in<k>_<j>.stl`, and the label is that name behind a path
 * prefix that differs per system, followed by `_<n>` or `_id_<i>_copy_<c>` for
 * a copy. Matched on the whole file name, so `in1_` is never read out of `in11_`.
 */
export function inputOfLabel(label: string): number | null {
  const m = /(?:^|[^A-Za-z0-9])in(\d{1,3})_\d{1,3}\.stl(?:_|$)/i.exec(label);
  return m ? Number(m[1]) : null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The exact drawing. `rowKeys[k]` is the plan row of input k; a plate with one
 * part gives every object to it (a project's labels are the project's own).
 * Null when the file labels no object or the bed is not known.
 */
export function exactPreview(bed: Bed | null, outlines: ReadonlyArray<PlateOutline>, rowKeys: ReadonlyArray<string>): OrderPlatePreviewDto | null {
  if (!bed || !outlines.length) return null;
  const objects = outlines.map((o) => {
    const k = rowKeys.length === 1 ? 0 : inputOfLabel(o.name);
    return {
      rowKey: k !== null && k < rowKeys.length ? rowKeys[k] : null,
      polygon: simplifyPolygon(o.polygon).map(([x, y]) => [round2(x - bed.originX), round2(y - bed.originY)] as [number, number]),
    };
  });
  return { bed: { x: bed.x, y: bed.y }, exact: true, objects, overflow: 0 };
}

export interface SketchItem {
  rowKey: string;
  units: number;
  footprint: { x: number; y: number } | null;
}

/**
 * The sketch: units in the order given, left to right in rows from the front
 * of the bed, SKETCH_GAP_MM apart; a unit is turned when that is the only way
 * it fits the bed's width. Units that find no room are counted in `overflow`.
 * Null when no part on the plate has a known footprint.
 */
export function sketchPreview(bed: { x: number; y: number } | null, items: ReadonlyArray<SketchItem>): OrderPlatePreviewDto | null {
  if (!bed || !(bed.x > 0 && bed.y > 0) || !items.some((i) => i.footprint)) return null;
  const objects: OrderPlatePreviewDto['objects'] = [];
  let overflow = 0;
  let x = 0;
  let y = 0;
  let rowDepth = 0;
  let full = false;
  for (const item of items) {
    const f = item.footprint ?? UNKNOWN_FOOTPRINT;
    // Lying along the bed's width when both ways fit, so rows stay shallow.
    let w = Math.max(f.x, f.y);
    let d = Math.min(f.x, f.y);
    if (w > bed.x) [w, d] = [d, w];
    const fits = w > 0 && d > 0 && w <= bed.x && d <= bed.y;
    for (let u = 0; u < item.units; u++) {
      if (!fits || full || objects.length >= SKETCH_MAX_OBJECTS) { overflow++; continue; }
      if (x > 0 && x + w > bed.x) {
        x = 0;
        y += rowDepth + SKETCH_GAP_MM;
        rowDepth = 0;
      }
      if (y + d > bed.y) { full = true; overflow++; continue; }
      objects.push({ rowKey: item.rowKey, polygon: [[round2(x), round2(y)], [round2(x + w), round2(y)], [round2(x + w), round2(y + d)], [round2(x), round2(y + d)]] });
      x += w + SKETCH_GAP_MM;
      rowDepth = Math.max(rowDepth, d);
    }
  }
  return { bed: { x: bed.x, y: bed.y }, exact: false, objects, overflow };
}
