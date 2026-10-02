import type { ComponentPlateRow, FileRef } from '@printforge/types';
import type { ResolvedBom, ResolvedComponent } from '../catalog-core/bom-resolve';
import { costEngine, round1, type PricingPrinter } from '../catalog-core/cost-engine';
import type { CostSettings } from '../costing/costing.service';
import { matchPrinter, type MatchablePrinter } from '../file-parser/printer-match';

/**
 * The plate list under each bill-of-materials part (owner spec 2026-10-02
 * items 1, 2, 6): the part's own single unit (×1) and every active ×N layout,
 * each with its cost per unit, price per unit, margin, printer and file.
 * Pure.
 *
 * Cost per unit is the catalog-core price basis (unitCostAtOne) of the size
 * on its standard colour, with this part's per-unit time and grams taken from
 * the plate (plate minutes and per-colour grams ÷ units) and every other part
 * and hardware part as they are. It is therefore the cost of one product unit
 * when this part is printed on this plate, and the ×1 row equals the Pricing
 * card's cost. No arithmetic of its own: the cost engine does it all.
 *
 * Price per unit: ×1 = the size's list price; ×N = the price of the highest
 * bulk tier whose min qty ≤ N, else the list price.
 */

export interface PriceTierLite { minQty: number; unitPrice: number }

export interface PlateRowsInput {
  /** the part's size resolved on its standard colour; null when it can't be resolved */
  bom: ResolvedBom | null;
  componentId: string;
  /** the part's own values, for the ×1 row */
  own: { printMinutes: number; grams: number; file: FileRef | null; slicedFor: string | null };
  /** the part's active layouts */
  layouts: ReadonlyArray<{ id: string; name: string; unitsPerPlate: number; plateMinutes: number; plateGrams: number; source: ComponentPlateRow['source']; attachmentId: string | null }>;
  /** files of the layouts, by attachment id */
  files: ReadonlyMap<string, { file: FileRef; slicedFor: string | null }>;
  listPrice: number | null;
  tiers: ReadonlyArray<PriceTierLite>;
  settings: CostSettings | null;
  pricingPrinter: PricingPrinter | null;
  printers: ReadonlyArray<MatchablePrinter>;
}

/** The unit price for N units: the highest tier with minQty ≤ N, else the list price. */
export function priceForUnits(n: number, listPrice: number | null, tiers: ReadonlyArray<PriceTierLite>) {
  let tier: PriceTierLite | null = null;
  for (const t of tiers) if (t.minQty <= n && (!tier || t.minQty > tier.minQty)) tier = t;
  if (n > 1 && tier) return { price: tier.unitPrice, source: 'TIER' as const, tierMinQty: tier.minQty };
  return { price: listPrice, source: listPrice === null ? null : ('LIST' as const), tierMinQty: null };
}

/** Product unit cost with `component` printed on a plate of `units`, or null when the bom can't be costed. */
export function plateUnitCost(
  bom: ResolvedBom,
  componentId: string,
  plate: { unitsPerPlate: number; plateMinutes: number; slotGrams: ReadonlyMap<number, number> } | null,
  settings: CostSettings,
  printer: PricingPrinter | null,
): number | null {
  const components: ResolvedComponent[] = !plate ? bom.components : bom.components.map((c) => {
    if (c.componentId !== componentId) return c;
    const u = plate.unitsPerPlate;
    return {
      ...c,
      minutesPerUnit: plate.plateMinutes / u,
      slots: c.slots.map((s) => ({ ...s, gramsPerUnit: (plate.slotGrams.get(s.colorIndex) ?? 0) / u })),
    };
  });
  const cost = costEngine.unitCostAtOne({ ...bom, components }, settings, printer);
  return cost.perUnit ? cost.perUnit.total : null;
}

export function plateRowsOf(input: PlateRowsInput): ComponentPlateRow[] {
  const rc = input.bom?.components.find((c) => c.componentId === input.componentId) ?? null;
  const cost = (plate: Parameters<typeof plateUnitCost>[2]) =>
    input.bom && rc && input.settings ? plateUnitCost(input.bom, input.componentId, plate, input.settings, input.pricingPrinter) : null;
  // The resolved layout carries the per-colour grams mapped onto the part's colours.
  const resolved = (id: string) => rc?.layouts.find((x) => x.layoutId === id) ?? null;
  const printerOf = (slicedFor: string | null) => {
    const p = matchPrinter(slicedFor, input.printers);
    return p ? { id: p.id, name: p.name } : null;
  };
  const row = (base: Omit<ComponentPlateRow, 'pricePerUnit' | 'priceSource' | 'tierMinQty' | 'marginPct' | 'printer'>): ComponentPlateRow => {
    const p = base.layoutId === null
      ? { price: input.listPrice, source: input.listPrice === null ? null : ('LIST' as const), tierMinQty: null }
      : priceForUnits(base.unitsPerPlate, input.listPrice, input.tiers);
    const margin = base.costPerUnit !== null && p.price !== null && p.price > 0 ? round1(((p.price - base.costPerUnit) / p.price) * 100) : null;
    return { ...base, pricePerUnit: p.price, priceSource: p.source, tierMinQty: p.tierMinQty, marginPct: margin, printer: printerOf(base.slicedFor) };
  };

  const rows: ComponentPlateRow[] = [row({
    layoutId: null, name: '×1', unitsPerPlate: 1, plateMinutes: input.own.printMinutes, plateGrams: input.own.grams, source: 'COMPONENT',
    costPerUnit: cost(null), file: input.own.file, slicedFor: input.own.file ? input.own.slicedFor : null,
  })];
  for (const l of [...input.layouts].sort((a, b) => a.unitsPerPlate - b.unitsPerPlate)) {
    const f = l.attachmentId ? input.files.get(l.attachmentId) ?? null : null;
    const r = resolved(l.id);
    rows.push(row({
      layoutId: l.id, name: l.name, unitsPerPlate: l.unitsPerPlate, plateMinutes: l.plateMinutes, plateGrams: l.plateGrams, source: l.source,
      costPerUnit: r ? cost({ unitsPerPlate: r.unitsPerPlate, plateMinutes: r.plateMinutes, slotGrams: r.slotGrams }) : null,
      file: f?.file ?? null, slicedFor: f?.slicedFor ?? null,
    }));
  }
  return rows;
}
