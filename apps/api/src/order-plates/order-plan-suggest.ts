import { MAX_UNITS_PER_PLATE, ORDER_PLAN_MAX_PLATES, ORDER_PLATE_MAX_ITEMS, type OrderPlanWarning, type OrderPlateKind } from '@printforge/types';
import { suggestJobPlates } from '../catalog-core/job-plate-suggestion';
import { PlanCache, PlanError, type PlannerLayout } from '../catalog-core/plate-planner';
import { PROJECT_FILL_UNITS } from '../slice/fill-units';
import type { PlanNeed } from './order-plate-model';
import { SKETCH_GAP_MM, UNKNOWN_FOOTPRINT } from './order-plate-preview';

/**
 * The plates an order is suggested to print (owner decisions 2026-10-13). Pure.
 *
 *  1. A multi-colour project prints alone, on its own printer: PROJECT plates
 *     of as many units as one plate is known to hold.
 *  2. A part without a model prints from its existing plate files: LAYOUT
 *     plates, chosen by the job planner (least printer time).
 *  3. Parts with a model and one filament share MIXED plates, per filament.
 *     Each new plate goes to the printer that has the least to do so far — the
 *     plates of steps 1 and 2 count — and is filled, largest parts first, until
 *     the parts' boxes (with the slicer's gap around each) cover 80 % of the
 *     bed. The slicer has the last word: a plate that turns out too full comes
 *     back with what fitted, and the rest shows as still needing a plate.
 *
 * Staff may change everything afterwards; this only has to be a sensible start.
 */

/** Share of the bed the boxes of a suggested mixed plate may cover. */
export const MIX_FILL_SHARE = 0.8;

export interface SuggestNeed {
  rowKey: string;
  orderItemId: string;
  componentId: string;
  description: string;
  mode: 'MIX' | 'PROJECT' | 'LAYOUT' | 'BLOCKED';
  /** Units still to put on plates. */
  units: number;
  materialId: string | null;
  /** PROJECT: the printer the project is locked to. */
  lockedPrinterId: string | null;
  /** PROJECT: units one plate is known (or estimated) to hold; null = not known. */
  capacity: number | null;
  footprint: { x: number; y: number } | null;
  minutesPerUnit: number;
  gramsPerUnit: number;
  pricingPrinterId: string | null;
  layouts: ReadonlyArray<PlannerLayout>;
}

export interface SuggestPrinter {
  id: string;
  name: string;
  bed: { x: number; y: number } | null;
  canSliceModels: boolean;
}

export interface SuggestedPlate {
  kind: OrderPlateKind;
  printerId: string | null;
  items: Array<{ rowKey: string; orderItemId: string; componentId: string; units: number }>;
  layoutId: string | null;
  plateCount: number;
  estMinutes: number;
  estGrams: number;
}

export interface OrderPlateSuggestion {
  plates: SuggestedPlate[];
  warnings: OrderPlanWarning[];
}

/** A need of the plan as the suggestion reads it, for `units` of it. */
export const toSuggestNeed = (n: PlanNeed, units: number): SuggestNeed => ({
  rowKey: n.rowKey, orderItemId: n.orderItemId, componentId: n.componentId, description: n.componentDescription, mode: n.mode,
  units, materialId: n.materialId, lockedPrinterId: n.lockedPrinterId, capacity: n.capacity, footprint: n.footprint,
  minutesPerUnit: n.minutesPerUnit, gramsPerUnit: n.gramsPerUnit, pricingPrinterId: n.pricingPrinterId, layouts: n.plannerLayouts,
});

const ref = (n: SuggestNeed, units: number) => ({ rowKey: n.rowKey, orderItemId: n.orderItemId, componentId: n.componentId, units });
const round1 = (n: number) => Math.round(n * 10) / 10;
const estimate = (items: ReadonlyArray<{ need: SuggestNeed; units: number }>) => ({
  estMinutes: round1(items.reduce((s, i) => s + i.units * i.need.minutesPerUnit, 0)),
  estGrams: round1(items.reduce((s, i) => s + i.units * i.need.gramsPerUnit, 0)),
});

const boxOf = (n: SuggestNeed) => n.footprint ?? UNKNOWN_FOOTPRINT;
const areaOf = (n: SuggestNeed) => boxOf(n).x * boxOf(n).y;
/** Bed area one unit takes on a mixed plate: its box plus the slicer's gap. */
const slotArea = (n: SuggestNeed) => (boxOf(n).x + SKETCH_GAP_MM) * (boxOf(n).y + SKETCH_GAP_MM);
const fitsBed = (n: SuggestNeed, bed: { x: number; y: number }) => {
  const b = boxOf(n);
  return (b.x <= bed.x && b.y <= bed.y) || (b.y <= bed.x && b.x <= bed.y);
};

export function suggestOrderPlates(needs: ReadonlyArray<SuggestNeed>, printers: ReadonlyArray<SuggestPrinter>, cache: PlanCache = new PlanCache()): OrderPlateSuggestion {
  const plates: SuggestedPlate[] = [];
  const warnings: OrderPlanWarning[] = [];
  /** Minutes placed on each printer so far. */
  const load = new Map<string, number>(printers.map((p) => [p.id, 0]));
  const add = (plate: SuggestedPlate) => {
    plates.push(plate);
    if (plate.printerId && load.has(plate.printerId)) load.set(plate.printerId, load.get(plate.printerId)! + plate.estMinutes * plate.plateCount);
  };
  const open = needs.filter((n) => n.units > 0);

  // 1. Projects: alone, on their own printer.
  for (const n of open.filter((x) => x.mode === 'PROJECT')) {
    if (!n.lockedPrinterId) continue; // such a need is BLOCKED upstream; never guess a printer
    const perPlate = Math.max(1, Math.min(MAX_UNITS_PER_PLATE, n.capacity && n.capacity >= 1 ? Math.floor(n.capacity) : PROJECT_FILL_UNITS));
    for (let left = n.units; left > 0 && plates.length < ORDER_PLAN_MAX_PLATES; ) {
      const units = Math.min(perPlate, left);
      add({ kind: 'PROJECT', printerId: n.lockedPrinterId, items: [ref(n, units)], layoutId: null, plateCount: 1, ...estimate([{ need: n, units }]) });
      left -= units;
    }
  }

  // 2. Parts without a model: their existing plates.
  for (const n of open.filter((x) => x.mode === 'LAYOUT')) {
    const pricing = printers.find((p) => p.id === n.pricingPrinterId) ?? null;
    let chosen: ReturnType<typeof suggestJobPlates> | null = null;
    try {
      chosen = suggestJobPlates(n.units, n.layouts, cache, { prefer: pricing ? { id: pricing.id, name: pricing.name } : null });
    } catch (e) {
      if (!(e instanceof PlanError)) throw e;
    }
    if (!chosen || chosen.blocked || !chosen.plates.length) {
      warnings.push({ code: 'BLOCKED', rowKey: n.rowKey, message: `"${n.description}" has no plate that can be used — slice it or upload a file for it` });
      continue;
    }
    for (const p of chosen.plates) {
      if (plates.length >= ORDER_PLAN_MAX_PLATES) break;
      add({
        kind: 'LAYOUT',
        // The printer the plate was sliced for; a plate that names none goes to the product's pricing printer.
        printerId: p.layout.printerId ?? pricing?.id ?? null,
        items: [ref(n, p.layout.unitsPerPlate)],
        layoutId: p.layout.layoutId,
        plateCount: Math.min(p.plateCount, 200),
        estMinutes: round1(p.layout.plateMinutes),
        estGrams: round1(p.layout.plateGrams),
      });
    }
  }

  // 3. Models of one filament share plates.
  const mix = open.filter((n) => n.mode === 'MIX' && n.materialId);
  const eligible = printers.filter((p) => p.canSliceModels && p.bed);
  if (mix.length && !eligible.length) {
    warnings.push({ code: 'NO_PRINTER', message: 'No printer can slice models yet — give a printer a machine profile and a default process in Settings › Slicer' });
  }
  const groups = new Map<string, SuggestNeed[]>();
  for (const n of mix) groups.set(n.materialId!, [...(groups.get(n.materialId!) ?? []), n]);
  for (const group of eligible.length ? groups.values() : []) {
    // Largest footprint first; units of one row stay together because a row is one entry.
    const queue = [...group]
      .sort((a, b) => areaOf(b) - areaOf(a) || a.rowKey.localeCompare(b.rowKey))
      .map((need) => ({ need, left: need.units }));
    for (const q of queue) {
      if (eligible.some((p) => fitsBed(q.need, p.bed!))) continue;
      warnings.push({ code: 'NO_PRINTER', rowKey: q.need.rowKey, message: `"${q.need.description}" is larger than the bed of every printer that can slice models` });
      q.left = 0;
    }
    while (queue.some((q) => q.left > 0) && plates.length < ORDER_PLAN_MAX_PLATES) {
      const first = queue.find((q) => q.left > 0)!;
      const printer = eligible
        .filter((p) => queue.some((q) => q.left > 0 && fitsBed(q.need, p.bed!)))
        .sort((a, b) =>
          load.get(a.id)! - load.get(b.id)!
          || Number(b.id === first.need.pricingPrinterId) - Number(a.id === first.need.pricingPrinterId)
          || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1))[0];
      const budget = printer.bed!.x * printer.bed!.y * MIX_FILL_SHARE;
      let used = 0;
      const items: Array<{ need: SuggestNeed; units: number }> = [];
      for (const q of queue) {
        if (items.length >= ORDER_PLATE_MAX_ITEMS) break;
        if (q.left <= 0 || !fitsBed(q.need, printer.bed!)) continue;
        let units = Math.floor((budget - used) / slotArea(q.need));
        // A part that fits the bed always gets a plate, however little of the 80 % is left for it.
        if (units < 1 && !items.length) units = 1;
        units = Math.min(units, q.left, MAX_UNITS_PER_PLATE);
        if (units < 1) continue;
        items.push({ need: q.need, units });
        used += units * slotArea(q.need);
        q.left -= units;
      }
      add({ kind: 'MIXED', printerId: printer.id, items: items.map((i) => ref(i.need, i.units)), layoutId: null, plateCount: 1, ...estimate(items) });
    }
  }

  if (plates.length >= ORDER_PLAN_MAX_PLATES) {
    warnings.push({ code: 'SHORT', message: `The plan stops at ${ORDER_PLAN_MAX_PLATES} plates — create jobs for these first, then prepare the rest` });
  }
  return { plates, warnings };
}
