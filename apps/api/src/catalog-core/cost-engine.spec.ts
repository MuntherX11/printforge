import { resolveInConfig } from './bom-resolve';
import { toProductConfig } from './catalog-config';
import { costEngine, costForQuantity, priceFromCost, round3, unitCostAtOne } from './cost-engine';
import { boxConfig, boxRow, SETTINGS } from './__fixtures__/box-product';
import { fixtureComponent, M, sardineConfig, OPT } from './__fixtures__/sardine-tin';
import { PlanCache } from './plate-planner';

const printer = { name: 'K1', hourlyRate: 0.4, wattage: 200, markupMultiplier: 2.5 };

describe('cost engine (§3.8)', () => {
  it('Box: unit cost 0.372, price 0.930 (standard size, standard colour)', () => {
    const bom = resolveInConfig(boxConfig(), null, null);
    const r = unitCostAtOne(bom, SETTINGS, printer);
    expect(r.complete).toBe(true);
    expect(r.perUnit!.material).toBe(0.094);
    expect(r.perUnit!.machine).toBe(0.227);
    expect(r.perUnit!.electricity).toBe(0.003);
    expect(r.perUnit!.waste).toBe(0);
    expect(r.lines.overhead).toBeCloseTo(0.048525, 6);
    expect(r.unit).toBe(0.372);
    expect(priceFromCost(r.unit, SETTINGS, printer)).toBe(0.93);
  });

  it('pair (Standard, Red): cost 0.394 — cost and margin only, no price for a colour', () => {
    const config = boxConfig({ withRed: true });
    const red = unitCostAtOne(resolveInConfig(config, null, 'v-box-red'), SETTINGS, printer);
    expect(red.perUnit!.material).toBe(0.113);
    expect(red.lines.overhead).toBeCloseTo(0.051345, 6);
    expect(red.unit).toBe(0.394);
    const sizePrice = 0.93;
    expect(Math.round(((sizePrice - red.unit) / sizePrice) * 1000) / 10).toBe(57.6);
  });

  it('weighted multicolour: Fish White 1.2 g × 0.010 + Orange 0.3 g × 0.030 = 0.021', () => {
    const config = toProductConfig({
      ...boxRow(),
      components: [fixtureComponent('fish', null, 'Fish', 1, 0, 9, [[0, M.white, 1.2, 'fixed'], [1, M.orange, 0.3, 'fixed']], [])],
    });
    const r = unitCostAtOne(resolveInConfig(config, null, null), SETTINGS, printer);
    expect(r.perUnit!.material).toBe(0.021);
    expect(r.materials.map((m) => [m.name, m.grams, m.cost])).toEqual([['PLA White', 1.2, 0.012], ['Silk Orange', 0.3, 0.009]]);
  });

  it('purge: slicer components → 0 (SLICER_INCLUDED); hand-entered Coaster → waste 0.100 (COLOUR_CHANGES)', () => {
    const slicer = unitCostAtOne(resolveInConfig(boxConfig({}, (r) => { r.colorChanges = 3; }), null, null), SETTINGS, printer);
    expect(slicer.purge.basis).toBe('SLICER_INCLUDED');
    expect(slicer.lines.waste).toBe(0);

    const coaster = fixtureComponent('coaster', null, 'Coaster', 1, 0, 30, [[0, M.black, 20, null]], [], { gcodeFilename: null });
    const config = toProductConfig({ ...boxRow(), colorChanges: 2, components: [coaster] });
    const r = unitCostAtOne(resolveInConfig(config, null, null), SETTINGS, printer);
    expect(r.purge).toEqual({ basis: 'COLOUR_CHANGES', changesPerUnit: 2, gramsPerChange: 5, grams: 10 });
    expect(round3(r.lines.waste)).toBe(0.1);

    const none = unitCostAtOne(resolveInConfig(toProductConfig({ ...boxRow(), components: [coaster] }), null, null), SETTINGS, printer);
    expect(none.purge.basis).toBe('NONE');
  });

  it('purge: a per-unit component estimated from a ×N plate (no file, single colour) never gets the manual purge', () => {
    const perUnit = fixtureComponent('pu', null, 'Box', 1, 0, 20, [[0, M.black, 9.4, null]], [{ id: 'pu12', units: 12, minutes: 240, grams: 112.8 }], {
      gcodeFilename: null, attachmentId: null, perUnitEstimatedFromLayoutId: 'pu12',
    });
    const config = toProductConfig({ ...boxRow(), colorChanges: 2, components: [perUnit] });
    const bom = resolveInConfig(config, null, null);
    expect(bom.hasSlicerComponent).toBe(false);
    const r = unitCostAtOne(bom, SETTINGS, printer);
    expect(r.purge.basis).toBe('SLICER_INCLUDED');
    expect(r.purge.grams).toBe(0);
    expect(r.lines.waste).toBe(0);
    const bulk = costForQuantity(bom, 24, SETTINGS, printer, new PlanCache());
    expect(bulk.lines.waste).toBe(0);
  });

  it('parts are added after overhead', () => {
    const config = toProductConfig({ ...boxRow(), parts: [{ partId: 'pt1', quantity: 2, part: { name: 'Magnet', unitCost: 0.05, isActive: true, stockQty: 10 } }] });
    const r = unitCostAtOne(resolveInConfig(config, null, null), SETTINGS, printer);
    expect(r.lines.overhead).toBeCloseTo(0.048525, 6); // unchanged by parts
    expect(r.perUnit!.parts).toBe(0.1);
    expect(r.unit).toBe(0.472);
    expect(r.parts).toEqual([{ partId: 'pt1', name: 'Magnet', quantity: 2, unitCost: 0.05, lineCost: 0.1 }]);
  });

  it('component allocation sums exactly for a 3-component BOM with awkward rounding', () => {
    const comps = [
      fixtureComponent('a', null, 'A', 1, 0, 7, [[0, M.black, 1.111, null]], []),
      fixtureComponent('b', null, 'B', 3, 1, 11, [[0, M.silver, 2.333, null]], []),
      fixtureComponent('c', null, 'C', 2, 2, 13, [[0, M.orange, 0.777, null], [1, M.white, 0.1, null]], []),
    ];
    const r = unitCostAtOne(resolveInConfig(toProductConfig({ ...boxRow(), components: comps }), null, null), SETTINGS, printer);
    const sum = r.components.reduce((s, c) => s + c.cost, 0);
    const subtotal = round3(r.lines.material + r.lines.machine + r.lines.electricity + r.lines.waste + r.lines.overhead);
    expect(round3(sum)).toBe(subtotal);
    for (const c of r.components) expect(c.cost).toBe(round3(c.cost));
  });

  describe('price basis is layout-free', () => {
    it('Sardine tin: Fish quantity 2 with a ×24 layout → per-unit sum, no ×24 plate time', () => {
      const bom = resolveInConfig(sardineConfig(), null, null);
      const r = unitCostAtOne(bom, SETTINGS, printer);
      const minutes = bom.components.reduce((s, c) => s + c.quantity * c.minutesPerUnit, 0);
      expect(minutes).toBe(34 + 26 + 2 * 9 + 6 + 11);
      expect(r.minutes).toBe(minutes);
      expect(r.grams).toBeCloseTo(9.4 + 6.0 + 2 * 1.5 + 1.5 + 2.6, 9);
    });

    it('an explicit ×1 layout with different minutes changes neither unitCostAtOne nor the computed price', () => {
      const before = unitCostAtOne(resolveInConfig(boxConfig(), null, null), SETTINGS, printer);
      const withX1 = boxConfig({}, (row) => {
        row.components[0].plateLayouts.push({ ...row.components[0].plateLayouts[0], id: 'x1', name: '×1', unitsPerPlate: 1, plateMinutes: 99, plateGrams: 20 });
      });
      const bom = resolveInConfig(withX1, null, null);
      expect(bom.components[0].layouts.find((l) => l.unitsPerPlate === 1)!.layoutId).toBe('x1');
      const after = unitCostAtOne(bom, SETTINGS, printer);
      expect(after.unit).toBe(before.unit);
      expect(priceFromCost(after.unit, SETTINGS, printer)).toBe(0.93);
    });
  });

  it('costForQuantity: unit(24) 0.265, unit(25) 0.270, unit(26) 0.265, unit(37) 0.268', () => {
    const bom = resolveInConfig(boxConfig(), null, null);
    const u = (n: number) => costForQuantity(bom, n, SETTINGS, printer).unit;
    expect(u(24)).toBe(0.265);
    expect(u(25)).toBe(0.27);
    expect(costForQuantity(bom, 25, SETTINGS, printer).minutes).toBeCloseTo(520, 6);
    expect(u(26)).toBe(0.265);
    expect(costForQuantity(bom, 26, SETTINGS, printer).minutes).toBeCloseTo(526.5, 6);
    expect(u(37)).toBe(0.268);
    expect(costForQuantity(bom, 37, SETTINGS, printer).minutes).toBeCloseTo(763, 6);
  });

  it('band 25–49: worst 0.270 at 25', () => {
    const bom = resolveInConfig(boxConfig(), null, null);
    const cache = new PlanCache();
    let worst = 0;
    let at = 0;
    for (let n = 25; n <= 49; n++) {
      const u = costEngine.costFromBasis(costEngine.quantityBasis(bom, n, cache), bom, SETTINGS, printer).unit;
      if (u > worst) { worst = u; at = n; }
    }
    expect([worst, at]).toEqual([0.27, 25]);
  });

  it('incomplete BOM (including MATERIAL_ZERO_COST) → perUnit null with the codes', () => {
    const zero = boxConfig({}, (row) => { row.components[0].material!.costPerGram = 0; });
    const r = unitCostAtOne(resolveInConfig(zero, null, null), SETTINGS, printer);
    expect(r.complete).toBe(false);
    expect(r.perUnit).toBeNull();
    expect(r.problems.map((p) => p.code)).toEqual(['MATERIAL_ZERO_COST']);

    const legacySize = sardineConfig((row) => { row.components = row.components.filter((c) => c.variantId === null); });
    const l = unitCostAtOne(resolveInConfig(legacySize, OPT.large, null), SETTINGS, printer);
    expect(l.perUnit).toBeNull();
    expect(l.problems.map((p) => p.code)).toContain('SIZE_OPTION_NO_COMPONENTS');
  });
  it('unitFromBasis (bulk-floor fast path) equals costFromBasis().unit', () => {
    const bom = resolveInConfig(sardineConfig(), OPT.large, OPT.red);
    const cache = new PlanCache();
    for (let n = 1; n <= 60; n++) {
      const basis = costEngine.quantityBasis(bom, n, cache);
      expect(costEngine.unitFromBasis(basis, bom, SETTINGS, printer)).toBe(costEngine.costFromBasis(basis, bom, SETTINGS, printer).unit);
    }
  });
});
