import { createHash } from 'crypto';
import type { BulkFloor, CellCost, OptionCost, Problem } from '@printforge/types';
import type { CostSettings } from '../costing/costing.service';
import { resolveInConfig, type ResolvedBom } from './bom-resolve';
import { optionsOfKind, type OptionRow, type ProductConfig } from './catalog-config';
import { costEngine, priceFromCost, round1, round3, type CostResult, type PricingPrinter } from './cost-engine';
import { colourOffered, isExcluded, standardColourLabel, standardSizeLabel, standardSizeSellable, type PairContext } from './option-pair';
import { PlanCache } from './plate-planner';

/**
 * Pure pricing maths over a loaded ProductConfig (spec §3.8, §3.9, §4.1.2).
 * PricingService does the I/O; everything here is deterministic and testable.
 */

export const COLOUR_COSTS_MORE_PCT = 10;

export function printerOf(config: ProductConfig): PricingPrinter | null {
  return config.printer ? { name: config.printer.name, hourlyRate: config.printer.hourlyRate, wattage: config.printer.wattage, markupMultiplier: config.printer.markupMultiplier } : null;
}

/** The size's stored price: Product.basePrice for the standard size, ProductVariant.basePrice for a size. */
export function storedPriceOf(config: ProductConfig, size: OptionRow | null): number | null {
  return size ? size.basePrice : config.product.basePrice;
}

/** OptionCost of one pair (§4.1.2). Colours never have a price: computedPrice is null for a colour pair. */
export function optionCostOf(config: ProductConfig, bom: ResolvedBom, cost: CostResult, settings: CostSettings): OptionCost {
  const size = bom.sizeOptionId ? config.options.find((o) => o.id === bom.sizeOptionId) ?? null : null;
  const storedPrice = storedPriceOf(config, size);
  const standardColour = bom.colourOptionId === null;
  const computedPrice = standardColour && cost.complete ? priceFromCost(cost.unit, settings, printerOf(config)) : null;
  const perUnit = cost.perUnit;
  return {
    sizeOptionId: bom.sizeOptionId,
    colourOptionId: bom.colourOptionId,
    label: bom.label,
    complete: cost.complete,
    fallbackToBase: bom.fallbackToBase,
    problems: cost.problems,
    warnings: bom.warnings,
    perUnit,
    materials: cost.materials,
    components: cost.components,
    parts: cost.parts,
    purge: cost.purge,
    machine: cost.machine,
    overheadPercent: cost.overheadPercent,
    markup: cost.markup,
    storedPrice,
    computedPrice,
    priceUpToDate: standardColour ? computedPrice !== null && storedPrice !== null && Math.abs(storedPrice - computedPrice) < 0.0005 : true,
    marginPct: perUnit && storedPrice && storedPrice > 0 ? round1(((storedPrice - perUnit.total) / storedPrice) * 100) : null,
  };
}

export interface CellGrid {
  cells: CellCost[];
  sizes: Array<OptionRow | null>;
  colours: Array<OptionRow | null>;
}

/**
 * Every size × every colour, inactive ones included and flagged (§3.8 cell costs).
 * One size-stage per size; each cell only re-maps slot materials and prices.
 */
export function cellCostsOf(config: ProductConfig, ctx: PairContext, settings: CostSettings): CellGrid {
  const sizes: Array<OptionRow | null> = [null, ...optionsOfKind(config, 'SIZE')];
  const colours: Array<OptionRow | null> = [null, ...optionsOfKind(config, 'COLOUR')];
  const printer = printerOf(config);
  const cells: CellCost[] = [];
  for (const size of sizes) {
    const price = storedPriceOf(config, size);
    const sizeActive = size ? size.isActive : standardSizeSellable(config, 'STAFF');
    const sizeToCustomers = size ? size.isActive && (size.basePrice ?? 0) > 0 && config.product.isActive : standardSizeSellable(config, 'CUSTOMER');
    let standardCost: number | null = null;
    for (const colour of colours) {
      const bom = resolveInConfig(config, size?.id ?? null, colour?.id ?? null);
      const cost = costEngine.unitCostAtOne(bom, settings, printer);
      const costPerUnit = cost.complete ? cost.unit : null;
      if (!colour) standardCost = costPerUnit;
      const excluded = colour ? isExcluded(colour, size?.id ?? null) : false;
      cells.push({
        sizeOptionId: size?.id ?? null,
        colourOptionId: colour?.id ?? null,
        sizeLabel: size ? size.name : standardSizeLabel(config),
        colourLabel: colour ? colour.name : standardColourLabel(config),
        active: config.product.isActive && sizeActive && (colour ? colour.isActive : true),
        excluded,
        offeredToCustomers: sizeToCustomers && colourOffered(ctx, size?.id ?? null, colour?.id ?? null, 'CUSTOMER'),
        complete: cost.complete,
        costPerUnit,
        price,
        marginPct: costPerUnit !== null && price && price > 0 ? round1(((price - costPerUnit) / price) * 100) : null,
        deltaVsStandardPct: costPerUnit !== null && standardCost !== null && standardCost > 0 ? round1(((costPerUnit - standardCost) / standardCost) * 100) : null,
        problems: cost.problems,
        warnings: bom.warnings,
      });
    }
  }
  return { cells, sizes, colours };
}

/** COLOUR_COSTS_MORE (§3.8): active, non-excluded colour cells more than 10 % (strictly) dearer than the standard colour. */
export function colourCostWarnings(cells: ReadonlyArray<CellCost>): Problem[] {
  const out: Problem[] = [];
  for (const c of cells) {
    if (c.colourOptionId === null || !c.active || c.excluded) continue;
    if (c.deltaVsStandardPct === null || !(c.deltaVsStandardPct > COLOUR_COSTS_MORE_PCT)) continue;
    out.push({
      code: 'COLOUR_COSTS_MORE',
      message: `"${c.colourLabel}" costs ${c.deltaVsStandardPct.toFixed(1)} % more than the standard colour on ${c.sizeLabel} (cost ${(c.costPerUnit ?? 0).toFixed(3)}, price ${(c.price ?? 0).toFixed(3)}, margin ${c.marginPct === null ? '—' : c.marginPct.toFixed(1)} %)`,
    });
  }
  return out;
}

/** costVersion (§4.1.2): first 16 hex chars of SHA-1 over a canonical JSON of what cost depends on. */
export function computeCostVersion(config: ProductConfig, settings: CostSettings): string {
  const t = (d: Date | string) => new Date(d).toISOString();
  const canonical = {
    product: t(config.product.updatedAt),
    colorChanges: config.product.colorChanges,
    printer: config.printer ? [config.printer.hourlyRate, config.printer.wattage, config.printer.markupMultiplier] : null,
    components: config.components.map((c) => ({
      id: c.id, v: c.variantId, g: c.gramsUsed, m: c.printMinutes, q: c.quantity, mat: c.materialId, cc: c.colorChanges,
      file: !!(c.attachmentId || c.gcodeFilename), link: c.colourSlotId, fixed: c.colourFixed === true, multi: c.isMultiColor,
      slots: c.materials.map((s) => [s.colorIndex, s.materialId, s.gramsUsed, s.colourSlotId, s.colourFixed === true]),
      layouts: c.layouts.filter((l) => l.isActive).map((l) => [l.id, t(l.updatedAt)]).sort(),
    })),
    colourSlots: config.colourSlots.map((s) => [s.id, s.name]),
    colours: config.options
      .map((o) => ({ id: o.id, kind: o.kind, active: o.isActive, a: [...o.assignments].map((a) => [a.colourSlotId, a.materialId]).sort(), x: [...o.excludedSizeKeys].sort() }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    parts: config.parts.map((p) => [p.partId, p.quantity, p.unitCost]).sort(),
    materials: [...config.materials.values()].map((m) => [m.id, m.costPerGram]).sort(),
    settings: [settings.overheadPercent, settings.purgeWasteGrams, settings.electricityRateKwh, settings.machineHourlyRate, settings.markupMultiplier],
  };
  return createHash('sha1').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

const MAX_POINTS = 600;

/**
 * Cost floor per tier band of one size (§3.9). quantityBasis is computed once per
 * N and priced for every colour made in the size; the planner table is built once
 * per layout set (PlanCache).
 */
export function bulkFloorOf(
  config: ProductConfig,
  sizeOptionId: string | null,
  minQtys: number[],
  settings: CostSettings,
  cache: PlanCache = new PlanCache(),
): BulkFloor {
  const size = sizeOptionId ? config.options.find((o) => o.id === sizeOptionId) ?? null : null;
  const printer = printerOf(config);
  const standard = resolveInConfig(config, sizeOptionId, null);
  const colourRows = optionsOfKind(config, 'COLOUR').filter((c) => c.isActive && !isExcluded(c, sizeOptionId));
  const problems: Problem[] = [...standard.problems];
  const colourBoms: Array<{ colour: OptionRow | null; bom: ResolvedBom }> = [{ colour: null, bom: standard }];
  for (const c of colourRows) {
    const bom = resolveInConfig(config, sizeOptionId, c.id);
    if (!bom.complete) {
      problems.push({ code: 'COLOUR_COST_UNKNOWN', message: `"${c.name}" cost can't be computed — ${bom.problems[0]?.message ?? 'incomplete'}` });
      continue;
    }
    colourBoms.push({ colour: c, bom });
  }
  const colourLabelOf = (c: OptionRow | null) => (c ? c.name : standardColourLabel(config));
  const atOne = colourBoms.map(({ colour, bom }) => {
    const r = costEngine.unitCostAtOne(bom, settings, printer);
    return { colourOptionId: colour?.id ?? null, label: colourLabelOf(colour), unitCostAtOne: r.complete ? r.unit : null };
  });
  const available = standard.complete;
  const qtys = [...new Set(minQtys)].filter((q) => Number.isInteger(q) && q >= 1).sort((a, b) => a - b);
  const P = Math.max(1, ...standard.components.map((c) => Math.ceil(Math.max(1, ...c.layouts.map((l) => l.unitsPerPlate)) / Math.max(1, c.quantity))));

  const bands: BulkFloor['bands'] = [];
  if (available) {
    for (let i = 0; i < qtys.length; i++) {
      const lo = qtys[i];
      const last = i === qtys.length - 1;
      const hi = last ? lo + 2 * P - 1 : qtys[i + 1] - 1;
      const top = Math.min(hi, lo + 2 * P);
      const points: number[] = [];
      for (let n = lo; n <= top && points.length < MAX_POINTS - 1; n++) points.push(n);
      if (!points.includes(hi)) points.push(hi);

      let worst = -Infinity;
      let worstAt = lo;
      let worstColour: OptionRow | null = null;
      let standardWorst = -Infinity;
      let atMin = 0;
      let worstPlans: Map<string, any> | null = null;
      for (const N of points) {
        const basis = costEngine.quantityBasis(standard, N, cache);
        for (const { colour, bom } of colourBoms) {
          const unit = costEngine.unitFromBasis(basis, bom, settings, printer);
          if (unit === null) continue;
          if (unit > worst) { worst = unit; worstAt = N; worstColour = colour; worstPlans = basis.plans; }
          if (!colour) {
            standardWorst = Math.max(standardWorst, unit);
            if (N === lo) atMin = unit;
          }
        }
      }
      bands.push({
        minQty: lo,
        maxQty: last ? null : hi,
        worstUnitCost: round3(worst),
        worstAtQty: worstAt,
        worstColour: { colourOptionId: worstColour?.id ?? null, label: colourLabelOf(worstColour) },
        standardWorstUnitCost: round3(standardWorst),
        unitCostAtMin: round3(atMin),
        basis: standard.components.map((c) => ({
          componentId: c.componentId,
          description: c.description,
          layoutsUsed: ((worstPlans?.get(c.componentId) ?? []) as Array<{ layout: { label: string }; plateCount: number }>).map((p) => `${p.layout.label} × ${p.plateCount}`),
        })),
      });
    }
  }
  return {
    size: { sizeOptionId, label: size ? size.name : standardSizeLabel(config), listPrice: storedPriceOf(config, size) },
    available,
    problems,
    thinMarginPct: settings.thinMarginPercent,
    unitCostAtOne: atOne[0]?.unitCostAtOne ?? null,
    colours: atOne,
    bands,
  };
}
