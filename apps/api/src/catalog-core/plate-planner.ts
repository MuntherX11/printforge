import { BadRequestException } from '@nestjs/common';
import type { SurplusPolicy } from '@printforge/types';

/**
 * Plate plans (spec §3.5, §3.6). Pure functions, no I/O.
 *
 * A layout here is what the resolver hands out: an active explicit PlateLayout
 * or the implicit single (layoutId null). Colour never selects layouts.
 */

export interface PlannerLayout {
  layoutId: string | null;
  label: string;
  unitsPerPlate: number;
  plateMinutes: number;
  plateGrams: number;
  /** grams per plate per colour index */
  slotGrams: ReadonlyMap<number, number>;
  attachmentId?: string | null;
  gcodeFilename?: string | null;
  colorChanges?: number;
}

export interface PlannedPlate {
  layout: PlannerLayout;
  plateCount: number;
}

export class PlanError extends Error {
  constructor(public readonly code: 'NO_USABLE_LAYOUT') {
    super(code);
  }
}

interface PlanTable {
  umax: number;
  /** minCount[x] = fewest reductions summing to x (Infinity = unreachable), x in 0..umax-1 */
  minCount: Int32Array;
  choice: Int32Array;
}

const INF = 0x3fffffff;

/**
 * The minCount/choice table depends only on the set of plate sizes, never on N
 * (it is built up to umax - 1, and s0 < umax always). It is memoised per layout
 * set, keyed by the sorted unitsPerPlate list, for the life of one request: the
 * bulk floor evaluates thousands of N over the same few layout sets.
 */
export class PlanCache {
  private readonly tables = new Map<string, PlanTable>();
  /** How many tables were built (specs assert "once per layout set"). */
  tablesBuilt = 0;

  table(sizes: number[]): PlanTable {
    const key = sizes.join(',');
    let t = this.tables.get(key);
    if (!t) {
      t = buildTable(sizes);
      this.tables.set(key, t);
      this.tablesBuilt++;
    }
    return t;
  }
}

function buildTable(sizesDesc: number[]): PlanTable {
  const umax = sizesDesc[0];
  const coins = sizesDesc.filter((u) => u < umax).map((u) => umax - u).sort((a, b) => b - a);
  const minCount = new Int32Array(umax).fill(INF);
  const choice = new Int32Array(umax).fill(0);
  minCount[0] = 0;
  for (let x = 1; x < umax; x++) {
    for (const d of coins) {
      // descending coins with a strict < keep the largest reduction on ties
      if (d <= x && minCount[x - d] + 1 < minCount[x]) {
        minCount[x] = minCount[x - d] + 1;
        choice[x] = d;
      }
    }
  }
  return { umax, minCount, choice };
}

const prepared = new WeakMap<ReadonlyArray<PlannerLayout>, { bySize: Map<number, PlannerLayout>; sizes: number[] }>();

/** One layout per size (lower minutes per unit wins), sizes descending; memoised per layouts array. */
function prepare(layouts: ReadonlyArray<PlannerLayout>) {
  let p = prepared.get(layouts);
  if (!p) {
    const bySize = new Map<number, PlannerLayout>();
    // The resolver already dedupes; defensively keep the lower minutes per unit.
    for (const l of layouts) {
      const prev = bySize.get(l.unitsPerPlate);
      if (!prev || l.plateMinutes / l.unitsPerPlate < prev.plateMinutes / prev.unitsPerPlate) bySize.set(l.unitsPerPlate, l);
    }
    p = { bySize, sizes: [...bySize.keys()].sort((a, b) => b - a) };
    prepared.set(layouts, p);
  }
  return p;
}

/**
 * Plates for N units. Lexicographic objective: fewest plates, then least surplus,
 * then fewest non-maximum plates, then larger reductions first. Result grouped by
 * unitsPerPlate, largest first.
 */
export function suggestPlan(N: number, layouts: ReadonlyArray<PlannerLayout>, cache?: PlanCache): PlannedPlate[] {
  if (N <= 0) return [];
  if (!layouts.length) throw new PlanError('NO_USABLE_LAYOUT');
  const { bySize, sizes } = prepare(layouts);
  const umax = sizes[0];
  const P = Math.ceil(N / umax);
  const s0 = P * umax - N;
  if (s0 === 0) return [{ layout: bySize.get(umax)!, plateCount: P }];

  const t = (cache ?? new PlanCache()).table(sizes);
  let best = 0;
  for (let x = s0; x > 0; x--) {
    if (t.minCount[x] <= P) { best = x; break; }
  }
  const replaced = new Map<number, number>(); // unitsPerPlate -> count
  let x = best;
  let n = 0;
  while (x > 0) {
    const d = t.choice[x];
    const u = umax - d;
    replaced.set(u, (replaced.get(u) ?? 0) + 1);
    x -= d;
    n++;
  }
  const out: PlannedPlate[] = [];
  if (P - n > 0) out.push({ layout: bySize.get(umax)!, plateCount: P - n });
  for (const u of [...replaced.keys()].sort((a, b) => b - a)) {
    out.push({ layout: bySize.get(u)!, plateCount: replaced.get(u)! });
  }
  return out;
}

export function unitsOf(plan: ReadonlyArray<PlannedPlate>): number {
  return plan.reduce((s, p) => s + p.plateCount * p.layout.unitsPerPlate, 0);
}

/**
 * Remove cancelled units from the last plates first (§3.6): `perPlate(k)` is the
 * per-plate amount (grams of a slot, or minutes); the cancelled share of a plate
 * is pro-rated per unit.
 */
function applyPolicy(
  plan: ReadonlyArray<PlannedPlate>,
  R: number,
  policy: SurplusPolicy,
  perPlate: (p: PlannedPlate) => number,
): number {
  let total = plan.reduce((s, p) => s + p.plateCount * perPlate(p), 0);
  if (policy !== 'CANCEL_ON_PRINTER') return total;
  let remaining = Math.max(0, unitsOf(plan) - R);
  for (let k = plan.length - 1; k >= 0 && remaining > 0; k--) {
    const p = plan[k];
    const u = p.layout.unitsPerPlate;
    const c = Math.min(remaining, p.plateCount * u);
    total -= (c * perPlate(p)) / u;
    remaining -= c;
  }
  return total;
}

/** Filament of one colour index for a plan, by policy. */
export function gramsForPlan(plan: ReadonlyArray<PlannedPlate>, colorIndex: number, R: number, policy: SurplusPolicy): number {
  return applyPolicy(plan, R, policy, (p) => p.layout.slotGrams.get(colorIndex) ?? 0);
}

/** Print minutes for a plan, by policy (the cost floor uses CANCEL: delivered units only). */
export function minutesForPlan(plan: ReadonlyArray<PlannedPlate>, R: number, policy: SurplusPolicy): number {
  return applyPolicy(plan, R, policy, (p) => p.layout.plateMinutes);
}

export interface PlanEdit {
  componentId: string;
  layoutId: string | null;
  plateCount: unknown;
}

/**
 * Validate a user-edited plan for one component group (J2/J5). `layouts` are the
 * component's usable layouts (active + implicit single); `inactiveLayoutIds` its
 * inactive explicit layouts, so the error can say which case it is.
 */
export function validatePlan(
  component: { componentId: string; description: string; layouts: ReadonlyArray<PlannerLayout>; inactiveLayoutIds?: ReadonlyArray<string> },
  R: number,
  plates: ReadonlyArray<PlanEdit>,
): PlannedPlate[] {
  const out: PlannedPlate[] = [];
  for (const e of plates) {
    const count = e.plateCount;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 10000) {
      throw new BadRequestException(`"${component.description}": plate count must be a whole number from 1 to 10000`);
    }
    let layout: PlannerLayout | undefined;
    if (e.layoutId === null) {
      layout = component.layouts.find((l) => l.layoutId === null);
      if (!layout) {
        throw new BadRequestException(`"${component.description}" has no single-unit plate — choose one of its layouts`);
      }
    } else {
      layout = component.layouts.find((l) => l.layoutId === e.layoutId);
      if (!layout) {
        if (component.inactiveLayoutIds?.includes(e.layoutId)) {
          throw new BadRequestException(`"${component.description}": that layout is no longer active`);
        }
        throw new BadRequestException(`"${component.description}": that layout belongs to another component`);
      }
    }
    out.push({ layout, plateCount: count });
  }
  const U = unitsOf(out);
  if (U < R) {
    throw new BadRequestException(`"${component.description}": plates cover ${U} units but ${R} are needed`);
  }
  return out;
}
