import type { Problem } from '@printforge/types';
import type { CostSettings } from '../costing/costing.service';
import type { ResolvedBom } from './bom-resolve';
import { minutesForPlan, gramsForPlan, PlanCache, PlanError, suggestPlan, type PlannedPlate } from './plate-planner';

/**
 * Pure cost maths (spec §3.8).
 *
 * - unitCostAtOne: the price basis. Per-unit component values only; never reads
 *   PlateLayout rows (explicit ×1 layouts included) and never calls the planner,
 *   so layouts can't change a price.
 * - costForQuantity(N) = costFromBasis(quantityBasis(N)): the bulk floor. Plans
 *   depend only on the size, so the basis is computed once per N and priced per
 *   colour. Time and material are both pro-rated to delivered units.
 */

export const round3 = (x: number) => Math.round(x * 1000) / 1000;
export const round1 = (x: number) => Math.round(x * 10) / 10;

export interface PricingPrinter {
  name: string;
  hourlyRate: number;
  wattage: number;
  markupMultiplier: number;
}

export type PurgeBasis = 'SLICER_INCLUDED' | 'COLOUR_CHANGES' | 'NONE';

/**
 * Slicer grams already include flush and tower, so the manual colour-change
 * purge never applies. A per-unit component estimated from a ×N plate (WP5) has
 * no file of its own, but its grams still came from the slicer.
 */
export function slicerIncluded(bom: Pick<ResolvedBom, 'hasSlicerComponent' | 'components'>): boolean {
  return bom.hasSlicerComponent || bom.components.some((c) => c.perUnitEstimated);
}

export interface CostResult {
  complete: boolean;
  problems: Problem[];
  N: number;
  minutes: number;
  grams: number;
  materials: Array<{ materialId: string; name: string; type: string; colorHex: string | null; grams: number; costPerGram: number; cost: number }>;
  purge: { basis: PurgeBasis; changesPerUnit: number; gramsPerChange: number; grams: number };
  /** unrounded totals for N units */
  lines: { material: number; machine: number; electricity: number; waste: number; overhead: number; parts: number };
  total: number;
  unit: number;
  /** per unit, 3 dp; null when incomplete */
  perUnit: { material: number; machine: number; electricity: number; waste: number; overhead: number; parts: number; total: number } | null;
  /** per-component share of round3(material+machine+electricity+waste+overhead); sums exactly */
  components: Array<{ componentId: string; description: string; quantity: number; gramsPerUnit: number; minutesPerUnit: number; cost: number }>;
  parts: Array<{ partId: string; name: string; quantity: number; unitCost: number; lineCost: number }>;
  machine: { minutesPerUnit: number; hourlyRate: number; rateSource: 'PRINTER' | 'SETTING'; wattage: number; electricityRatePerKwh: number };
  overheadPercent: number;
  markup: { multiplier: number; source: 'PRINTER' | 'SETTING'; printerName: string | null };
}

/** Planning half of costForQuantity: depends only on the size, never on the colour. */
export interface QuantityBasis {
  N: number;
  plans: Map<string, PlannedPlate[]>;
  minutes: number;
  minutesByComponent: Map<string, number>;
  /** grams per `${componentId}:${colorIndex}` */
  grams: Map<string, number>;
  /** the same grams in bom slot order (components, then slots) — the fast path */
  slotGrams: Float64Array;
  problems: Problem[];
}

const slotKey = (componentId: string, colorIndex: number) => `${componentId}:${colorIndex}`;

export function markupOf(settings: CostSettings, printer: PricingPrinter | null) {
  const usePrinter = !!printer && printer.markupMultiplier > 0;
  return {
    multiplier: usePrinter ? printer!.markupMultiplier : settings.markupMultiplier,
    source: (usePrinter ? 'PRINTER' : 'SETTING') as 'PRINTER' | 'SETTING',
    printerName: printer?.name ?? null,
  };
}

function priceIt(
  bom: ResolvedBom,
  N: number,
  minutesByComponent: Map<string, number>,
  gramsOf: (componentId: string, colorIndex: number) => number,
  settings: CostSettings,
  printer: PricingPrinter | null,
  extraProblems: Problem[],
): CostResult {
  const mats = new Map<string, CostResult['materials'][number]>();
  const compMaterial = new Map<string, number>();
  const compGrams = new Map<string, number>();
  let material = 0;
  let grams = 0;
  let minutes = 0;
  for (const c of bom.components) {
    minutes += minutesByComponent.get(c.componentId) ?? 0;
    let cm = 0;
    let cg = 0;
    for (const s of c.slots) {
      const g = gramsOf(c.componentId, s.colorIndex);
      const cost = g * s.material.costPerGram;
      cm += cost;
      cg += g;
      const m = mats.get(s.materialId) ?? {
        materialId: s.materialId, name: s.material.name, type: String(s.material.type), colorHex: s.material.colorHex,
        grams: 0, costPerGram: s.material.costPerGram, cost: 0,
      };
      m.grams += g;
      m.cost += cost;
      mats.set(s.materialId, m);
    }
    compMaterial.set(c.componentId, cm);
    compGrams.set(c.componentId, cg);
    material += cm;
    grams += cg;
  }

  let basis: PurgeBasis = 'NONE';
  let purgeGrams = 0;
  if (slicerIncluded(bom)) basis = 'SLICER_INCLUDED';
  else if (bom.productColorChanges > 0) {
    basis = 'COLOUR_CHANGES';
    purgeGrams = bom.productColorChanges * settings.purgeWasteGrams * N;
  }
  const waste = grams > 0 ? purgeGrams * (material / grams) : 0;
  const hours = minutes / 60;
  const usePrinterRate = !!printer && printer.hourlyRate > 0;
  const hourlyRate = usePrinterRate ? printer!.hourlyRate : settings.machineHourlyRate;
  const wattage = printer?.wattage || 200;
  const machine = hours * hourlyRate;
  const electricity = (wattage / 1000) * hours * settings.electricityRateKwh;
  const overhead = (material + machine + electricity + waste) * (settings.overheadPercent / 100);
  const parts = bom.parts.reduce((s, p) => s + p.unitCost * p.quantity * N, 0);
  const subtotal = round3(material + machine + electricity + waste + overhead);
  const total = round3(subtotal + round3(parts));
  const unit = round3(total / N);

  // Component allocation (display): exact material; machine+electricity by minutes
  // share (grams share when there are no minutes); waste by grams; overhead by
  // subtotal share. Rounded to 3 dp with the residue on the largest line.
  const run = machine + electricity;
  const raw = bom.components.map((c) => {
    const m = minutesByComponent.get(c.componentId) ?? 0;
    const g = compGrams.get(c.componentId) ?? 0;
    const runShare = minutes > 0 ? m / minutes : grams > 0 ? g / grams : 0;
    const sub = (compMaterial.get(c.componentId) ?? 0) + run * runShare + (grams > 0 ? (waste * g) / grams : 0);
    return sub;
  });
  const subSum = raw.reduce((s, x) => s + x, 0);
  const alloc = raw.map((sub) => round3(sub + (subSum > 0 ? (overhead * sub) / subSum : 0)));
  if (alloc.length) {
    const residue = round3(subtotal - alloc.reduce((s, x) => s + x, 0));
    let big = 0;
    for (let i = 1; i < alloc.length; i++) if (alloc[i] > alloc[big]) big = i;
    alloc[big] = round3(alloc[big] + residue);
  }

  const problems = [...bom.problems, ...extraProblems];
  const complete = problems.length === 0;
  return {
    complete,
    problems,
    N,
    minutes,
    grams,
    materials: [...mats.values()].map((m) => ({ ...m, grams: round3(m.grams), cost: round3(m.cost) })),
    purge: { basis, changesPerUnit: basis === 'COLOUR_CHANGES' ? bom.productColorChanges : 0, gramsPerChange: settings.purgeWasteGrams, grams: purgeGrams },
    lines: { material, machine, electricity, waste, overhead, parts },
    total,
    unit,
    perUnit: complete
      ? {
          material: round3(material / N), machine: round3(machine / N), electricity: round3(electricity / N),
          waste: round3(waste / N), overhead: round3(overhead / N), parts: round3(parts / N), total: unit,
        }
      : null,
    components: bom.components.map((c, i) => ({
      componentId: c.componentId, description: c.description, quantity: c.quantity,
      gramsPerUnit: c.gramsPerUnit, minutesPerUnit: c.minutesPerUnit, cost: alloc[i] ?? 0,
    })),
    parts: bom.parts.map((p) => ({ partId: p.partId, name: p.name, quantity: p.quantity, unitCost: p.unitCost, lineCost: round3(p.unitCost * p.quantity * N) })),
    machine: {
      minutesPerUnit: minutes / N, hourlyRate, rateSource: usePrinterRate ? 'PRINTER' : 'SETTING',
      wattage, electricityRatePerKwh: settings.electricityRateKwh,
    },
    overheadPercent: settings.overheadPercent,
    markup: markupOf(settings, printer),
  };
}

/** The price basis: per-unit values, N = 1. Never reads layouts. */
export function unitCostAtOne(bom: ResolvedBom, settings: CostSettings, printer: PricingPrinter | null): CostResult {
  const minutesByComponent = new Map(bom.components.map((c) => [c.componentId, c.quantity * c.minutesPerUnit]));
  const perSlot = new Map<string, number>();
  for (const c of bom.components) for (const s of c.slots) perSlot.set(slotKey(c.componentId, s.colorIndex), c.quantity * s.gramsPerUnit);
  return priceIt(bom, 1, minutesByComponent, (cid, idx) => perSlot.get(slotKey(cid, idx)) ?? 0, settings, printer, []);
}

/** Plans, minutes and grams for N units of a size, delivered units only (CANCEL). */
export function quantityBasis(bom: ResolvedBom, N: number, cache?: PlanCache): QuantityBasis {
  const plans = new Map<string, PlannedPlate[]>();
  const minutesByComponent = new Map<string, number>();
  const grams = new Map<string, number>();
  const problems: Problem[] = [];
  const slotGrams = new Float64Array(bom.components.reduce((s, c) => s + c.slots.length, 0));
  let i = 0;
  let minutes = 0;
  for (const c of bom.components) {
    const R = c.quantity * N;
    let plan: PlannedPlate[] = [];
    try {
      plan = suggestPlan(R, c.layouts, cache);
    } catch (e) {
      if (!(e instanceof PlanError)) throw e;
      problems.push({ code: 'NO_USABLE_LAYOUT', componentId: c.componentId, message: `"${c.description}" has no usable plate layout — slice it or enter its grams and minutes` });
    }
    plans.set(c.componentId, plan);
    const m = minutesForPlan(plan, R, 'CANCEL_ON_PRINTER');
    minutesByComponent.set(c.componentId, m);
    minutes += m;
    for (const s of c.slots) {
      const g = gramsForPlan(plan, s.colorIndex, R, 'CANCEL_ON_PRINTER');
      grams.set(slotKey(c.componentId, s.colorIndex), g);
      slotGrams[i++] = g;
    }
  }
  return { N, plans, minutes, minutesByComponent, grams, slotGrams, problems };
}

/**
 * Unit cost only, from a basis, for one colour of the same size (the bulk floor
 * prices thousands of (N, colour) points). Same arithmetic as costFromBasis,
 * without the display breakdown. null when the basis or the bom is incomplete.
 */
export function unitFromBasis(basis: QuantityBasis, bom: ResolvedBom, settings: CostSettings, printer: PricingPrinter | null): number | null {
  if (basis.problems.length || bom.problems.length) return null;
  let material = 0;
  let grams = 0;
  let i = 0;
  for (const c of bom.components) {
    for (const s of c.slots) {
      const g = basis.slotGrams[i++];
      material += g * s.material.costPerGram;
      grams += g;
    }
  }
  const N = basis.N;
  const purgeGrams = !slicerIncluded(bom) && bom.productColorChanges > 0 ? bom.productColorChanges * settings.purgeWasteGrams * N : 0;
  const waste = grams > 0 ? purgeGrams * (material / grams) : 0;
  const hours = basis.minutes / 60;
  const hourlyRate = printer && printer.hourlyRate > 0 ? printer.hourlyRate : settings.machineHourlyRate;
  const machine = hours * hourlyRate;
  const electricity = ((printer?.wattage || 200) / 1000) * hours * settings.electricityRateKwh;
  const overhead = (material + machine + electricity + waste) * (settings.overheadPercent / 100);
  const parts = bom.parts.reduce((s, p) => s + p.unitCost * p.quantity * N, 0);
  return round3(round3(round3(material + machine + electricity + waste + overhead) + round3(parts)) / N);
}

/** Price a basis for one colour of the size (the bom supplies the slot materials). */
export function costFromBasis(basis: QuantityBasis, bom: ResolvedBom, settings: CostSettings, printer: PricingPrinter | null): CostResult {
  return priceIt(bom, basis.N, basis.minutesByComponent, (cid, idx) => basis.grams.get(slotKey(cid, idx)) ?? 0, settings, printer, basis.problems);
}

export function costForQuantity(bom: ResolvedBom, N: number, settings: CostSettings, printer: PricingPrinter | null, cache?: PlanCache): CostResult {
  return costEngine.costFromBasis(costEngine.quantityBasis(bom, N, cache), bom, settings, printer);
}

/** Price of a size (computed on its standard colour): round3(unitCostAtOne × markup). */
export function priceFromCost(unit: number, settings: CostSettings, printer: PricingPrinter | null): number {
  return round3(unit * markupOf(settings, printer).multiplier);
}

/**
 * Called through this object by the services, so specs can count calls
 * (e.g. "quantityBasis once per evaluated N").
 */
export const costEngine = { unitCostAtOne, quantityBasis, costFromBasis, unitFromBasis, costForQuantity };
