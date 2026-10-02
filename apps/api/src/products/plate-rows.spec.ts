import { resolveInConfig } from '../catalog-core/bom-resolve';
import { boxConfig, SETTINGS } from '../catalog-core/__fixtures__/box-product';
import { sardineConfig } from '../catalog-core/__fixtures__/sardine-tin';
import { costEngine } from '../catalog-core/cost-engine';
import { printerOf } from '../catalog-core/pricing-core';
import { plateRowsOf, plateUnitCost, priceForUnits, type PlateRowsInput } from './plate-rows';

/** Owner spec 2026-10-02 items 1, 2, 6: the plate list's cost, price, margin and printer per plate. */

const file = (id: string) => ({ attachmentId: id, filename: `${id}.gcode`, sizeBytes: 10, downloadUrl: `/api/attachments/${id}/download` });

function boxInput(over: Partial<PlateRowsInput> = {}): PlateRowsInput {
  const config = boxConfig();
  return {
    bom: resolveInConfig(config, null, null),
    componentId: 'box',
    own: { printMinutes: 34, grams: 9.4, file: file('a-own'), slicedFor: 'Creality Hi' },
    layouts: [{ id: 'box12', name: '×12', unitsPerPlate: 12, plateMinutes: 243, plateGrams: 112.8, source: 'GCODE', attachmentId: 'a-12' }],
    files: new Map([['a-12', { file: file('a-12'), slicedFor: 'Creality K1 Max' }]]),
    listPrice: 0.93,
    tiers: [],
    settings: SETTINGS,
    pricingPrinter: printerOf(config),
    printers: [{ id: 'pr-hi', name: 'HI', model: null, isActive: true }],
    ...over,
  };
}

describe('plateRowsOf (the §3.8 Box)', () => {
  it('×1 is the Pricing card: cost 0.372, list price 0.930, margin 60.0 %, its own file and printer', () => {
    const [one] = plateRowsOf(boxInput());
    expect(one).toMatchObject({
      layoutId: null, name: '×1', unitsPerPlate: 1, plateMinutes: 34, plateGrams: 9.4, source: 'COMPONENT',
      costPerUnit: 0.372, pricePerUnit: 0.93, priceSource: 'LIST', tierMinQty: null, marginPct: 60,
      file: file('a-own'), slicedFor: 'Creality Hi', printer: { id: 'pr-hi', name: 'HI' },
    });
  });

  it('×12 from the plate: 243 min / 112.8 g → 20.25 min and 9.4 g a unit → cost 0.265; no tiers → list price', () => {
    const rows = plateRowsOf(boxInput());
    expect(rows[1]).toMatchObject({
      layoutId: 'box12', unitsPerPlate: 12, plateMinutes: 243, plateGrams: 112.8, source: 'GCODE',
      costPerUnit: 0.265, pricePerUnit: 0.93, priceSource: 'LIST', marginPct: 71.5,
      slicedFor: 'Creality K1 Max', printer: null,
    });
  });

  it('×12 takes the highest bulk tier with min qty ≤ 12; ×1 always the list price', () => {
    const rows = plateRowsOf(boxInput({ tiers: [{ minQty: 10, unitPrice: 0.8 }, { minQty: 13, unitPrice: 0.7 }, { minQty: 1, unitPrice: 0.9 }] }));
    expect(rows[0]).toMatchObject({ pricePerUnit: 0.93, priceSource: 'LIST' });
    expect(rows[1]).toMatchObject({ pricePerUnit: 0.8, priceSource: 'TIER', tierMinQty: 10, marginPct: 66.9 });
  });

  it('the cost comes from the catalog-core engine (same as unitCostAtOne with the per-unit values swapped)', () => {
    const spy = jest.spyOn(costEngine, 'unitCostAtOne');
    plateRowsOf(boxInput());
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('no settings, an incomplete bill of materials or no price → no cost / margin, rows still listed', () => {
    expect(plateRowsOf(boxInput({ settings: null })).map((r) => [r.costPerUnit, r.marginPct])).toEqual([[null, null], [null, null]]);
    const zero = boxConfig({}, (row) => { row.components[0].material.costPerGram = 0; });
    const rows = plateRowsOf(boxInput({ bom: resolveInConfig(zero, null, null) }));
    expect(rows.map((r) => r.costPerUnit)).toEqual([null, null]);
    expect(plateRowsOf(boxInput({ listPrice: null }))[1]).toMatchObject({ pricePerUnit: null, priceSource: null, marginPct: null });
  });

  it('a manual layout without a file: no file, no printer', () => {
    const rows = plateRowsOf(boxInput({ layouts: [{ id: 'box12', name: 'Full bed', unitsPerPlate: 12, plateMinutes: 243, plateGrams: 112.8, source: 'MANUAL', attachmentId: null }] }));
    expect(rows[1]).toMatchObject({ name: 'Full bed', source: 'MANUAL', file: null, slicedFor: null, printer: null });
  });
});

describe('plateUnitCost on a multi-part product', () => {
  it('is the product unit cost with only that part re-timed: the other parts are unchanged', () => {
    const config = sardineConfig();
    const bom = resolveInConfig(config, null, null);
    const base = costEngine.unitCostAtOne(bom, SETTINGS, printerOf(config)).perUnit!.total;
    const box12 = bom.components.find((c) => c.componentId === 'c1')!.layouts.find((l) => l.layoutId === 'l1')!;
    const onPlate = plateUnitCost(bom, 'c1', box12, SETTINGS, printerOf(config))!;
    // Box 34 min → 20.25 min a unit on the ×12, so the product unit gets cheaper.
    expect(onPlate).toBeLessThan(base);
    expect(plateUnitCost(bom, 'c1', null, SETTINGS, printerOf(config))).toBe(base);
  });
});

describe('priceForUnits', () => {
  it('picks the highest tier at or below N, else the list price', () => {
    const tiers = [{ minQty: 50, unitPrice: 0.6 }, { minQty: 10, unitPrice: 0.8 }];
    expect(priceForUnits(12, 1, tiers)).toEqual({ price: 0.8, source: 'TIER', tierMinQty: 10 });
    expect(priceForUnits(60, 1, tiers)).toEqual({ price: 0.6, source: 'TIER', tierMinQty: 50 });
    expect(priceForUnits(9, 1, tiers)).toEqual({ price: 1, source: 'LIST', tierMinQty: null });
    expect(priceForUnits(9, null, tiers)).toEqual({ price: null, source: null, tierMinQty: null });
  });
});
