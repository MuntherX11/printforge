import { PlanCache, suggestPlan, type PlannedPlate, type PlannerLayout } from './plate-planner';

/**
 * The plates a new production job suggests (owner spec 2026-10-02 item 4).
 * Pure.
 *
 * Only plates that have a print file on record are suggested: a layout (or a
 * part's own single unit) without a G-code is never picked automatically. Among
 * those, the plan with the least printer time wins — full plate minutes (a
 * plate prints as sliced) plus PLATE_CHANGE_MINUTES for clearing the bed and
 * starting each plate — then the fewest plates, then the fewest extras. So 45
 * units with a ×20 file (300 min) and a single-unit file (20 min) are ×20, ×20
 * and 5 × ×1, not 3 × ×20; 40 units are 2 × ×20, never 40 singles, and a
 * small remainder that a big plate prints almost as fast goes on the big plate
 * (the planner's fewest-plates rule).
 *
 * When a part has no plate with a file at all, the old suggestion (fewest
 * plates, then least surplus, over every usable plate) is kept and the caller
 * warns "No G-code on file for <part> — upload one". The bulk-price floor never
 * uses this: it keeps suggestPlan.
 */

export interface JobPlateSuggestion {
  plates: PlannedPlate[];
  /** true when no usable plate has a file, so the plan came from plates without one */
  noFile: boolean;
}

const EPS = 1e-6;
/** Printer time counted per plate on top of its sliced minutes: clear the bed, heat up, first layer. */
export const PLATE_CHANGE_MINUTES = 10;
/** Above this many units the DP runs on the remainder after the most time-efficient plates. */
const DP_UNITS = 20_000;

export const hasFile = (l: PlannerLayout) => !!l.attachmentId;

/** One layout per plate size: the lower minutes per unit (then the earlier) wins. */
function bySize(layouts: ReadonlyArray<PlannerLayout>): PlannerLayout[] {
  const best = new Map<number, PlannerLayout>();
  for (const l of layouts) {
    if (!(l.unitsPerPlate >= 1)) continue;
    const prev = best.get(l.unitsPerPlate);
    if (!prev || l.plateMinutes / l.unitsPerPlate < prev.plateMinutes / prev.unitsPerPlate - EPS) best.set(l.unitsPerPlate, l);
  }
  return [...best.values()].sort((a, b) => b.unitsPerPlate - a.unitsPerPlate);
}

/** Least total plate minutes covering N units; then fewest plates; then least surplus. Grouped, largest plates first. */
export function quickestPlan(N: number, layouts: ReadonlyArray<PlannerLayout>): PlannedPlate[] {
  if (N <= 0) return [];
  const L = bySize(layouts);
  if (!L.length) return [];
  const counts = new Map<PlannerLayout, number>();

  // Very large runs: pre-assign the most time-efficient plate so the table stays small.
  let n = N;
  if (n > DP_UNITS) {
    const bulk = [...L].sort((a, b) => a.plateMinutes / a.unitsPerPlate - b.plateMinutes / b.unitsPerPlate || b.unitsPerPlate - a.unitsPerPlate)[0];
    const k = Math.floor((n - DP_UNITS) / bulk.unitsPerPlate);
    counts.set(bulk, k);
    n -= k * bulk.unitsPerPlate;
  }

  const umax = L[0].unitsPerPlate;
  const M = n + umax - 1;
  const minutes = new Float64Array(M + 1).fill(Infinity);
  const plates = new Int32Array(M + 1);
  const choice = new Int32Array(M + 1).fill(-1);
  minutes[0] = 0;
  for (let x = 1; x <= M; x++) {
    for (let i = 0; i < L.length; i++) {
      const u = L[i].unitsPerPlate;
      if (u > x || minutes[x - u] === Infinity) continue;
      const m = minutes[x - u] + L[i].plateMinutes + PLATE_CHANGE_MINUTES;
      const p = plates[x - u] + 1;
      const better = m < minutes[x] - EPS || (Math.abs(m - minutes[x]) <= EPS && p < plates[x]);
      if (better) {
        minutes[x] = m;
        plates[x] = p;
        choice[x] = i;
      }
    }
  }
  let best = -1;
  for (let x = n; x <= M; x++) {
    if (minutes[x] === Infinity) continue;
    if (best < 0 || minutes[x] < minutes[best] - EPS || (Math.abs(minutes[x] - minutes[best]) <= EPS && plates[x] < plates[best])) best = x;
  }
  if (best < 0) return [];
  for (let x = best; x > 0; x -= L[choice[x]].unitsPerPlate) {
    const l = L[choice[x]];
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[0].unitsPerPlate - a[0].unitsPerPlate)
    .map(([layout, plateCount]) => ({ layout, plateCount }));
}

/**
 * The job suggestion for R units of one part. Throws PlanError (from
 * suggestPlan) when the part has no usable plate at all.
 */
export function suggestJobPlates(R: number, layouts: ReadonlyArray<PlannerLayout>, cache?: PlanCache): JobPlateSuggestion {
  if (R <= 0) return { plates: [], noFile: false };
  const withFile = layouts.filter(hasFile);
  if (!withFile.length) return { plates: suggestPlan(R, layouts, cache), noFile: true };
  return { plates: quickestPlan(R, withFile), noFile: false };
}

/** "No G-code on file for "Box" — upload one" (owner wording). */
export const noGcodeOnFile = (description: string) => `No G-code on file for "${description}" — upload one`;
