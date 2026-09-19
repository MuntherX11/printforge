import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BomResolverService, resolveInConfig, standardColourLabelBySize, standardMixedWarnings } from './bom-resolver.service';
import { toProductConfig } from './catalog-config';
import { CatalogRequestContext } from './catalog-context';
import { key, M, OPT, PRODUCT_ID, resolverPrisma, sardineConfig, sardineRow, SLOT, fixtureMaterial } from './__fixtures__/sardine-tin';

const codes = (xs: Array<{ code: string }>) => xs.map((x) => x.code);
const comp = (bom: ReturnType<typeof resolveInConfig>, id: string) => bom.components.find((c) => c.componentId === id)!;

describe('BOM resolver (§3.2)', () => {
  it('standard pair: standard components, own filaments, complete', () => {
    const bom = resolveInConfig(sardineConfig(), null, null);
    expect(bom.components.map((c) => c.componentId)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(bom.label).toBe('Regular · Black');
    expect(bom.fallbackToBase).toBe(false);
    expect(bom.complete).toBe(true);
    expect(bom.productionReady).toBe(true);
    expect(comp(bom, 'c1').colourKey).toBe(key([0, M.black]));
    expect(comp(bom, 'c1').colourKey).toBe(comp(bom, 'c1').baseColourKey);
  });

  it('a SIZE with its own components uses them', () => {
    const bom = resolveInConfig(sardineConfig(), OPT.large, null);
    expect(bom.components.map((c) => c.description)).toEqual(['Large Box', 'Large Lid', 'Large Fish', 'Large Key']);
    expect(bom.sizeLabel).toBe('Large');
  });

  it('a legacy SIZE without components falls back to the standard BOM with SIZE_OPTION_NO_COMPONENTS', () => {
    const config = sardineConfig((r) => { r.components = r.components.filter((c) => c.variantId === null); });
    const bom = resolveInConfig(config, OPT.large, null);
    expect(bom.fallbackToBase).toBe(true);
    expect(bom.components.map((c) => c.componentId)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(codes(bom.problems)).toContain('SIZE_OPTION_NO_COMPONENTS');
    expect(bom.productionReady).toBe(true);
    expect(bom.complete).toBe(false);
  });

  describe('colour on the standard size (Blue)', () => {
    const bom = resolveInConfig(sardineConfig(), null, OPT.blue);
    it('linked single-material and multicolour slots take the assignment; fixed slots keep their own', () => {
      expect(comp(bom, 'c1').slots[0]).toMatchObject({ materialId: M.blue, baseMaterialId: M.black, assigned: true });
      expect(comp(bom, 'c2').slots.map((s) => [s.materialId, s.assigned])).toEqual([[M.blue, true], [M.white, true]]);
      expect(comp(bom, 'c3').slots.map((s) => [s.materialId, s.assigned])).toEqual([[M.white, false], [M.orange, false]]);
      expect(comp(bom, 'c5').slots.map((s) => [s.materialId, s.assigned])).toEqual([[M.gold, true], [M.white, false]]);
      expect(codes(bom.warnings)).not.toContain('COLOUR_SLOT_UNUSED');
    });
    it('a linked slot without an assignment keeps its own material (Red has no Trim row)', () => {
      const red = resolveInConfig(sardineConfig(), null, OPT.red);
      expect(comp(red, 'c4').slots[0]).toMatchObject({ materialId: M.silver, assigned: false, colourSlotId: SLOT.trim });
    });
  });

  it('(Large, Red): the §3.6.1 resolution table, exactly', () => {
    const bom = resolveInConfig(sardineConfig(), OPT.large, OPT.red);
    const c6 = comp(bom, 'c6'), c7 = comp(bom, 'c7'), c8 = comp(bom, 'c8'), c9 = comp(bom, 'c9');
    expect(c6.slots[0]).toMatchObject({ materialId: M.red, baseMaterialId: M.black, assigned: true, colourSlotName: 'Tin' });
    expect(c6.colourKey).toBe(key([0, M.red]));
    expect(c7.slots.map((s) => [s.colorIndex, s.materialId, s.assigned])).toEqual([[0, M.red, true], [1, M.silver, false]]);
    expect(c7.colourKey).toBe(key([0, M.red], [1, M.silver]));
    expect(c8.slots.map((s) => s.materialId)).toEqual([M.white, M.orange]);
    expect(c8.colourKey).toBe(c8.baseColourKey);
    expect(c9.slots[0].materialId).toBe(M.silver);
    expect(c9.colourKey).toBe(c9.baseColourKey);
    // only Large layouts apply
    expect(bom.components.flatMap((c) => c.layouts.map((l) => l.layoutId))).toEqual(['l6', null, 'l7', null, 'l8', null, 'l9', null]);
    const unused = bom.warnings.filter((w) => w.code === 'COLOUR_SLOT_UNUSED');
    expect(unused.map((w) => w.message)).toEqual([`"Band" isn't used by Large — Red's Band filament (PLA Gold) is ignored`]);
  });

  it('stockOnHand reads the bucket of the resolved colour key', () => {
    const config = sardineConfig((r) => {
      const c6 = r.components.find((c) => c.id === 'c6')!;
      c6.stockOnHand = 7;
      c6.colourStock = [{ colourKey: key([0, M.red]), stockOnHand: 2 }];
    });
    expect(comp(resolveInConfig(config, OPT.large, OPT.red), 'c6').stockOnHand).toBe(2);
    expect(comp(resolveInConfig(config, OPT.large, null), 'c6').stockOnHand).toBe(7);
    expect(comp(resolveInConfig(config, OPT.large, OPT.blue), 'c6').stockOnHand).toBe(0);
  });

  it('COLOUR_OPTION_NO_EFFECT when no assigned slot is linked on the size; COLOUR_OPTION_NOT_SET_UP with no rows', () => {
    const config = sardineConfig((r) => {
      r.variants.push({ ...r.variants[1], id: 'v-gold', name: 'Gold', colourAssignments: [{ colourSlotId: SLOT.band, materialId: M.gold, material: fixtureMaterial(M.gold) }] });
      r.variants.push({ ...r.variants[1], id: 'v-green', name: 'Green', colourAssignments: [] });
    });
    const gold = resolveInConfig(config, OPT.large, 'v-gold');
    expect(codes(gold.warnings)).toEqual(expect.arrayContaining(['COLOUR_SLOT_UNUSED', 'COLOUR_OPTION_NO_EFFECT']));
    expect(gold.warnings.find((w) => w.code === 'COLOUR_OPTION_NO_EFFECT')!.message).toBe(`"Gold" changes nothing on Large — link component colours to the product's colour slots`);
    expect(codes(resolveInConfig(config, null, 'v-gold').warnings)).not.toContain('COLOUR_OPTION_NO_EFFECT');
    const green = resolveInConfig(config, null, 'v-green');
    expect(green.warnings.map((w) => w.message)).toContain(`"Green" has no filaments assigned — it prints in the standard colours`);
  });

  it('two colours assigning Tin → PLA Red share Box\'s colour key; assigning its own material → the base key', () => {
    const config = sardineConfig((r) => {
      r.variants.push({ ...r.variants[1], id: 'v-rw', name: 'Red & White', colourAssignments: [{ colourSlotId: SLOT.tin, materialId: M.red, material: fixtureMaterial(M.red) }] });
      r.variants.push({ ...r.variants[1], id: 'v-black', name: 'Black', colourAssignments: [{ colourSlotId: SLOT.tin, materialId: M.black, material: fixtureMaterial(M.black) }] });
    });
    expect(comp(resolveInConfig(config, null, 'v-rw'), 'c1').colourKey).toBe(comp(resolveInConfig(config, null, OPT.red), 'c1').colourKey);
    const black = comp(resolveInConfig(config, null, 'v-black'), 'c1');
    expect(black.colourKey).toBe(black.baseColourKey);
  });

  it('ownership and kind: size of another product → 404, a colour as size → 400, a size as colour → 400', () => {
    const config = sardineConfig();
    expect(() => resolveInConfig(config, 'v-elsewhere', null)).toThrow(NotFoundException);
    expect(() => resolveInConfig(config, 'v-elsewhere', null)).toThrow('Size not found');
    expect(() => resolveInConfig(config, OPT.red, null)).toThrow(BadRequestException);
    expect(() => resolveInConfig(config, OPT.red, null)).toThrow('"Red" is a colour, not a size');
    expect(() => resolveInConfig(config, null, OPT.large)).toThrow('"Large" is a size, not a colour');
    expect(() => resolveInConfig(config, null, 'v-nope')).toThrow('Colour not found');
  });

  it('implicit single present when minutes and grams > 0 and no explicit ×1; absent otherwise', () => {
    const bom = resolveInConfig(sardineConfig(), null, null);
    expect(comp(bom, 'c1').layouts.map((l) => [l.layoutId, l.unitsPerPlate, l.label])).toEqual([['l1', 12, 'Box ×12'], [null, 1, 'Box single']]);
    const noMinutes = sardineConfig((r) => { r.components[0].printMinutes = 0; });
    const c1 = comp(resolveInConfig(noMinutes, null, null), 'c1');
    expect(c1.layouts.map((l) => l.layoutId)).toEqual(['l1']);
  });

  it('explicit layout slot grams: rows when the index set matches, else proportional', () => {
    const bom = resolveInConfig(sardineConfig(), null, null);
    const lid15 = comp(bom, 'c2').layouts[0];
    expect(lid15.slotGrams.get(0)).toBeCloseTo((90 * 5.2) / 6.0, 9);
    expect(lid15.slotGrams.get(1)).toBeCloseTo((90 * 0.8) / 6.0, 9);
    const fish = comp(bom, 'c3').layouts[0];
    expect([fish.slotGrams.get(0), fish.slotGrams.get(1)]).toEqual([28.8, 7.2]);
  });

  it('MATERIAL_ZERO_COST on an assigned colour filament: that pair incomplete, the standard pair complete, productionReady', () => {
    const config = sardineConfig((r) => { r.variants[1].colourAssignments[1].material.costPerGram = 0; }); // Red's PLA Gold
    const red = resolveInConfig(config, null, OPT.red);
    expect(codes(red.problems)).toEqual(['MATERIAL_ZERO_COST']);
    expect(red.problems[0]).toMatchObject({ materialId: M.gold, message: 'Filament "PLA Gold" has no cost per gram — set it on the Filaments page' });
    expect(red.complete).toBe(false);
    expect(red.productionReady).toBe(true);
    expect(resolveInConfig(config, null, null).complete).toBe(true);
  });

  it('COLOUR_SLOT_UNLINKED for an unlinked slot when a colour is resolved; a fixed slot never warns; both print their own', () => {
    const config = sardineConfig((r) => {
      const lid = r.components.find((c) => c.id === 'c7')!;
      lid.materials[0].colourSlotId = null; // Large Lid colour 1 unlinked
    });
    const bom = resolveInConfig(config, OPT.large, OPT.red);
    const w = bom.warnings.filter((x) => x.code === 'COLOUR_SLOT_UNLINKED');
    expect(w).toEqual([{ code: 'COLOUR_SLOT_UNLINKED', componentId: 'c7', message: `"Large Lid" colour 1 isn't linked or marked fixed — Red won't change it` }]);
    expect(comp(bom, 'c7').slots[0].materialId).toBe(M.black);
    expect(comp(bom, 'c8').slots[0].materialId).toBe(M.white); // fixed
    expect(codes(resolveInConfig(config, OPT.large, null).warnings)).not.toContain('COLOUR_SLOT_UNLINKED');
  });

  it('blocking problems carry the exact messages', () => {
    const config = sardineConfig((r) => {
      const box = r.components[0];
      box.materialId = null; box.material = null; box.gramsUsed = 0; box.printMinutes = 0;
    });
    const bom = resolveInConfig(config, null, null);
    expect(bom.problems.filter((p) => p.componentId === 'c1').map((p) => p.message)).toEqual([
      '"Box" has no filament set', '"Box" weighs 0 g — slice it or enter its grams', '"Box" has no print time — slice it or enter its minutes',
    ]);
    expect(bom.productionReady).toBe(false);
    const empty = toProductConfig({ ...sardineRow(), components: [], variants: [] });
    expect(resolveInConfig(empty, null, null).problems[0].message).toBe('No components — add or import the parts that are printed');
  });

  describe('standard colour consistency (SLOT_STANDARD_MIXED)', () => {
    it('Box PLA Black and Large Box PLA Grey on Tin → mixed; labels per size', () => {
      const config = sardineConfig((r) => {
        const c6 = r.components.find((c) => c.id === 'c6')!;
        c6.materialId = M.grey; c6.material = fixtureMaterial(M.grey);
      });
      const w = standardMixedWarnings(config);
      expect(w.map((x) => x.code)).toEqual(['SLOT_STANDARD_MIXED']);
      expect(w[0].message).toMatch(/^"Tin" is sliced in different filaments \(.*PLA Grey on Large Box.*\) — the standard colour differs between sizes$/);
      expect(standardColourLabelBySize(config)).toEqual({ standard: 'As sliced (PLA Black, PLA Silver)', [OPT.large]: 'As sliced (PLA Grey, PLA Black, PLA Silver)' });
      expect(standardColourLabelBySize(sardineConfig())).toBeNull();
    });
    it('two components of one size in different own filaments on one slot → not mixed', () => {
      const config = sardineConfig((r) => {
        r.components = r.components.filter((c) => c.variantId === null);
        const lid = r.components.find((c) => c.id === 'c2')!;
        lid.materials[0].materialId = M.grey; lid.materials[0].material = fixtureMaterial(M.grey);
      });
      expect(standardMixedWarnings(config)).toEqual([]);
    });
  });
});

describe('BomResolverService', () => {
  const setup = (rows = [sardineRow()]) => {
    const prisma = resolverPrisma(rows);
    return { prisma, svc: new BomResolverService(prisma as any) };
  };

  it('loads a product once per request and memoises resolutions per pair', async () => {
    const { prisma, svc } = setup();
    const ctx = new CatalogRequestContext();
    const spy = jest.spyOn(svc, 'resolveWithConfig');
    await svc.resolve(PRODUCT_ID, { sizeOptionId: OPT.large, colourOptionId: OPT.red }, ctx);
    await svc.resolve(PRODUCT_ID, { sizeOptionId: OPT.large, colourOptionId: OPT.red }, ctx);
    await svc.resolve(PRODUCT_ID, { sizeOptionId: null, colourOptionId: OPT.red }, ctx);
    expect(prisma.product.findUnique).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  describe('resolveForLine never throws', () => {
    it('missing product → LINE_PRODUCT_MISSING', async () => {
      const { svc } = setup();
      const r = await svc.resolveForLine({ productId: 'gone', description: 'Old tin' }, 'Order ORD-0001', new CatalogRequestContext());
      expect(r).toEqual({ skip: true, warning: { code: 'LINE_PRODUCT_MISSING', message: 'Order ORD-0001 line "Old tin": product no longer exists — skipped' } });
    });
    it('an option of another product → LINE_OPTION_MISMATCH', async () => {
      const other = { ...sardineRow(), id: 'p-other', variants: [{ ...sardineRow().variants[0], id: 'v-other', productId: 'p-other' }] };
      const { svc } = setup([sardineRow(), other]);
      const r = await svc.resolveForLine({ productId: PRODUCT_ID, variantId: 'v-other', description: 'x' }, 'Order ORD-1', new CatalogRequestContext());
      expect(r.skip && r.warning.code).toBe('LINE_OPTION_MISMATCH');
    });
    it('a sizeOptionId pointing at a colour → LINE_OPTION_KIND_MISMATCH', async () => {
      const { svc } = setup();
      const r = await svc.resolveForLine({ productId: PRODUCT_ID, sizeOptionId: OPT.red, description: 'x' }, 'Order ORD-1', new CatalogRequestContext());
      expect(r.skip && r.warning).toEqual({ code: 'LINE_OPTION_KIND_MISMATCH', message: 'Order ORD-1 line "x": "Red" is no longer a size — skipped' });
    });
    it('a missing option → LINE_OPTION_MISSING', async () => {
      const { svc } = setup();
      const r = await svc.resolveForLine({ productId: PRODUCT_ID, variantId: 'v-deleted', description: 'x' }, 'Order ORD-1', new CatalogRequestContext());
      expect(r.skip && r.warning.code).toBe('LINE_OPTION_MISSING');
    });
    it('an inactive product and option never skip; legacy variantId follows the current kind', async () => {
      const row = sardineRow();
      row.isActive = false;
      row.variants[1].isActive = false;
      const { svc } = setup([row]);
      const r = await svc.resolveForLine({ productId: PRODUCT_ID, variantId: OPT.red, description: 'x' }, 'Order ORD-1', new CatalogRequestContext());
      expect(r.skip).toBe(false);
      if (!r.skip) {
        expect(r.pair).toEqual({ sizeOptionId: null, colourOptionId: OPT.red });
        expect(r.legacy).toBe(true);
      }
    });
    it('a pre-release order job reads its order line\'s pair', async () => {
      const prisma = resolverPrisma([sardineRow()], { orderItem: { findMany: jest.fn(async () => [{ id: 'oi-1', variantId: OPT.red, sizeOptionId: null, colourOptionId: null }]) } });
      const svc = new BomResolverService(prisma as any);
      const r = await svc.resolveForLine({ productId: PRODUCT_ID, orderItemId: 'oi-1', variantId: null, description: 'job' }, 'Job', new CatalogRequestContext());
      expect(!r.skip && r.pair).toEqual({ sizeOptionId: null, colourOptionId: OPT.red });
    });
  });
});
