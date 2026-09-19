import { BomResolverService } from './bom-resolver.service';
import { toProductConfig } from './catalog-config';
import { CatalogRequestContext } from './catalog-context';
import { costEngine } from './cost-engine';
import { colourCostWarnings, computeCostVersion } from './pricing-core';
import { PricingService, type LineInput } from './pricing.service';
import { BOX_ID, boxRow, SETTINGS } from './__fixtures__/box-product';
import { fixtureMaterial, M, OPT, PRODUCT_ID, resolverPrisma, sardineRow, SLOT, type FixtureRow } from './__fixtures__/sardine-tin';

const REGULAR_TIERS = [{ minQty: 25, unitPrice: 1.35 }, { minQty: 50, unitPrice: 1.2 }, { minQty: 100, unitPrice: 1.0 }];
const LARGE_TIERS = [{ minQty: 25, unitPrice: 2.5 }];

function keychainRow(): FixtureRow {
  const row = boxRow();
  row.id = 'p-key';
  row.name = 'Keychain';
  row.basePrice = 0.9;
  row.components[0].productId = 'p-key';
  const colour = (id: string, name: string, m: string) => ({
    id, productId: 'p-key', name, sku: null, kind: 'COLOUR', isActive: true, sortOrder: 0, basePrice: null, estimatedGrams: null, estimatedMinutes: null, createdAt: new Date(0),
    colourAssignments: [{ colourSlotId: 'slot-body', materialId: m, material: fixtureMaterial(m) }], sizeExclusions: [],
  });
  row.variants = [colour('k-red', 'Red', M.red), colour('k-blue', 'Blue', M.blue)];
  return row;
}

function setup(opts: { rows?: FixtureRow[]; tiers?: Record<string, any[]>; vtiers?: Record<string, any[]> } = {}) {
  const rows = opts.rows ?? [sardineRow()];
  const tiers = opts.tiers ?? { [PRODUCT_ID]: REGULAR_TIERS, 'p-key': [{ minQty: 25, unitPrice: 0.8 }] };
  const vtiers = opts.vtiers ?? { [OPT.large]: LARGE_TIERS };
  const prisma: any = resolverPrisma(rows, {
    priceTier: { findMany: jest.fn(async ({ where }: any) => tiers[where.productId] ?? []) },
    variantPriceTier: { findMany: jest.fn(async ({ where }: any) => vtiers[where.variantId] ?? []) },
  });
  const resolver = new BomResolverService(prisma);
  const costing: any = { loadSettings: jest.fn(async () => ({ ...SETTINGS })) };
  return { prisma, resolver, svc: new PricingService(prisma, resolver, costing), costing };
}

const R = (sizeOptionId: string | null, colourOptionId: string | null, quantity: number, extra: Partial<LineInput> = {}): LineInput =>
  ({ productId: PRODUCT_ID, sizeOptionId, colourOptionId, quantity, ...extra });

describe('PricingService.resolveLines (§3.9 tier table)', () => {
  const staff = (lines: LineInput[], s = setup()) => s.svc.resolveLines(lines, { audience: 'STAFF' });
  const brief = (xs: any[]) => xs.map((x) => [x.priceSource, x.unitPrice, x.totalPrice]);

  it('Regular·Red 15 + Regular·Black 10 → both TIER 25 (decision 8)', async () => {
    const r = await staff([R(null, OPT.red, 15), R(null, null, 10)]);
    expect(brief(r)).toEqual([['TIER', 1.35, 20.25], ['TIER', 1.35, 13.5]]);
    expect(r[0]).toMatchObject({ tierQuantity: 25, tierLineCount: 2, tierSizeLabel: 'Regular', tierMinQty: 25, listUnitPrice: 1.5 });
  });
  it('Regular·Red 15 + Regular·Blue 5 + Regular·Black 4 → 24, no tier', async () => {
    expect(brief(await staff([R(null, OPT.red, 15), R(null, OPT.blue, 5), R(null, null, 4)]))).toEqual([['BASE', 1.5, 22.5], ['BASE', 1.5, 7.5], ['BASE', 1.5, 6]]);
  });
  it('Regular·Red 15 + Large·Red 15 → different sizes never count together', async () => {
    expect(brief(await staff([R(null, OPT.red, 15), R(OPT.large, OPT.red, 15)]))).toEqual([['BASE', 1.5, 22.5], ['SIZE', 2.8, 42]]);
  });
  it('Large·Red 20 + Large·Blue 5 + Regular·Red 30 → Large TIER 25 at 2.500, Regular TIER 25 at 1.350', async () => {
    const r = await staff([R(OPT.large, OPT.red, 20), R(OPT.large, OPT.blue, 5), R(null, OPT.red, 30)]);
    expect(brief(r)).toEqual([['TIER', 2.5, 50], ['TIER', 2.5, 12.5], ['TIER', 1.35, 40.5]]);
  });
  it('Regular·Red 60 → TIER 50 at 1.200 (Red uses Regular\'s tiers)', async () => {
    expect(brief(await staff([R(null, OPT.red, 60)]))).toEqual([['TIER', 1.2, 72]]);
  });
  it('an override line still counts: Red 30 at 1.000 MANUAL (tierMinQty 25) + Black 10 TIER 25', async () => {
    const r = await staff([R(null, OPT.red, 30, { priceOverride: true, unitPrice: 1, overrideReason: '  friend  ' }), R(null, null, 10)]);
    expect(r[0]).toMatchObject({ priceSource: 'MANUAL', unitPrice: 1, listUnitPrice: 1.5, tierMinQty: 25, priceOverrideReason: 'friend' });
    expect(brief([r[1]])).toEqual([['TIER', 1.35, 13.5]]);
  });
  it('staff types 1.100 on Regular·Red 60 → MANUAL, list 1.500, tierMinQty 50', async () => {
    const r = await staff([R(null, OPT.red, 60, { priceOverride: true, unitPrice: 1.1 })]);
    expect(r[0]).toMatchObject({ priceSource: 'MANUAL', unitPrice: 1.1, listUnitPrice: 1.5, tierMinQty: 50 });
  });
  it('without the override flag a client unitPrice is ignored', async () => {
    expect((await staff([R(null, null, 1, { unitPrice: 0.01 })]))[0].unitPrice).toBe(1.5);
  });
  it('colours-only keychain: Red 15 + Blue 10 → both TIER 25 at 0.800', async () => {
    const s = setup({ rows: [keychainRow()] });
    const r = await s.svc.resolveLines([{ productId: 'p-key', colourOptionId: 'k-red', quantity: 15 }, { productId: 'p-key', colourOptionId: 'k-blue', quantity: 10 }], { audience: 'STAFF' });
    expect(brief(r)).toEqual([['TIER', 0.8, 12], ['TIER', 0.8, 8]]);
  });
  it('size Small 5 + size Large 5, each with own tiers at 10 → no tier', async () => {
    const row = sardineRow();
    row.variants.push({ ...row.variants[0], id: 'v-small', name: 'Small', basePrice: 1.0 });
    const s = setup({ rows: [row], vtiers: { 'v-small': [{ minQty: 10, unitPrice: 0.9 }], [OPT.large]: [{ minQty: 10, unitPrice: 2.6 }] } });
    const r = await s.svc.resolveLines([R('v-small', null, 5), R(OPT.large, null, 5)], { audience: 'STAFF' });
    expect(brief(r)).toEqual([['SIZE', 1, 5], ['SIZE', 2.8, 14]]);
  });
  it('custom lines never count: custom 30 + Regular·Black 10 → BASE 1.500', async () => {
    const r = await staff([{ quantity: 30, unitPrice: 2, description: '<i>Engraving</i>' }, R(null, null, 10)]);
    expect(r[0]).toMatchObject({ productId: null, priceSource: 'MANUAL', listUnitPrice: null, tierMinQty: null, description: 'Engraving', totalPrice: 60 });
    expect(brief([r[1]])).toEqual([['BASE', 1.5, 15]]);
  });
  it('legacy size with basePrice null, qty 3: STAFF SIZE 1.500 with OPTION_NOT_SET_UP; CUSTOMER 400', async () => {
    const row = sardineRow();
    row.variants.push({ ...row.variants[0], id: 'v-legacy', name: 'Mini', basePrice: null });
    const s = setup({ rows: [row] });
    const r = await s.svc.resolveLines([R('v-legacy', null, 3)], { audience: 'STAFF' });
    expect(r[0]).toMatchObject({ priceSource: 'SIZE', unitPrice: 1.5, totalPrice: 4.5 });
    expect(r[0].warnings.map((w) => w.code)).toContain('OPTION_NOT_SET_UP');
    await expect(s.svc.resolveLines([R('v-legacy', null, 3)], { audience: 'CUSTOMER' })).rejects.toThrow(`Line 1: "Mini · Black" can't be ordered yet`);
  });
  it('customer shop (Regular, Red) 30 → BASE 1.500, no tier, label-only description', async () => {
    const r = await setup().svc.resolveLines([R(null, OPT.red, 30, { description: 'hack' })], { audience: 'CUSTOMER' });
    expect(r[0]).toMatchObject({ priceSource: 'BASE', unitPrice: 1.5, tierMinQty: null, listUnitPrice: 1.5, description: 'Sardine tin — Red', tierQuantity: null });
  });
  it('qty 3 × 1.350 = 4.050 exactly', async () => {
    const r = await staff([R(null, null, 3, { priceOverride: true, unitPrice: 1.35 })]);
    expect(r[0].totalPrice).toBe(4.05);
  });
});

describe('PricingService.resolveLines — validation, list price, floor', () => {
  it('the list price ignores colour; the floor is the pair\'s own cost (Red can be BELOW_COST where Black is not)', async () => {
    const s = setup();
    const [red, black] = await s.svc.resolveLines([R(null, OPT.red, 1), R(null, null, 1)], { audience: 'STAFF' });
    expect(red.listUnitPrice).toBe(black.listUnitPrice);
    expect(red.floor!).toBeGreaterThan(black.floor!);
    const between = Math.round(((red.floor! + black.floor!) / 2) * 1000) / 1000;
    const r = await s.svc.resolveLines([R(null, OPT.red, 1, { priceOverride: true, unitPrice: between }), R(null, null, 1, { priceOverride: true, unitPrice: between })], { audience: 'STAFF' });
    expect(r[0].warnings.map((w) => w.code)).toContain('BELOW_COST');
    expect(r[1].warnings.map((w) => w.code)).not.toContain('BELOW_COST');
    expect(r[1].warnings.map((w) => w.code)).toContain('THIN_MARGIN');
  });
  it('ABOVE_LIST when the price exceeds the list price', async () => {
    const r = await setup().svc.resolveLines([R(null, null, 1, { priceOverride: true, unitPrice: 2 })], { audience: 'STAFF' });
    expect(r[0].warnings.map((w) => w.code)).toEqual(['ABOVE_LIST']);
  });
  it('priceSource BASE for the standard size, SIZE for a size; OrderItem mirror = size ?? colour', async () => {
    const r = await setup().svc.resolveLines([R(null, OPT.red, 1), R(OPT.large, OPT.red, 1), R(OPT.large, null, 1)], { audience: 'STAFF' });
    expect(r.map((x) => [x.priceSource, x.variantId])).toEqual([['BASE', OPT.red], ['SIZE', OPT.large], ['SIZE', OPT.large]]);
    expect(r[1].description).toBe('Sardine tin — Large — Red');
  });
  it('legacy request { productId, variantId: <colour> } → stored colourOptionId', async () => {
    const r = await setup().svc.resolveLines([{ productId: PRODUCT_ID, variantId: OPT.red, quantity: 2 }], { audience: 'STAFF' });
    expect(r[0]).toMatchObject({ sizeOptionId: null, colourOptionId: OPT.red, variantId: OPT.red });
  });
  it('customer { variantId } only → product taken from the option', async () => {
    const r = await setup().svc.resolveLines([{ variantId: OPT.large, quantity: 1 }], { audience: 'CUSTOMER' });
    expect(r[0]).toMatchObject({ productId: PRODUCT_ID, sizeOptionId: OPT.large, unitPrice: 2.8 });
  });
  it('size or colour without productId → 400; unknown product → 400', async () => {
    const s = setup();
    await expect(s.svc.resolveLines([{ sizeOptionId: OPT.large, quantity: 1 }], { audience: 'STAFF' })).rejects.toThrow('Line 1: choose the product for this size or colour');
    await expect(s.svc.resolveLines([{ productId: 'nope', quantity: 1 }], { audience: 'STAFF' })).rejects.toThrow('Line 1: product not found');
  });
  it('custom line needs a price and a description', async () => {
    const s = setup();
    await expect(s.svc.resolveLines([{ quantity: 1, description: 'x' }], { audience: 'STAFF' })).rejects.toThrow(/Line 1: price/);
    await expect(s.svc.resolveLines([{ quantity: 1, unitPrice: 1 }], { audience: 'STAFF' })).rejects.toThrow('Line 1: description is required');
  });
  it('no price → 400', async () => {
    const row = sardineRow();
    row.variants[0].basePrice = 0;
    await expect(setup({ rows: [row], vtiers: {} }).svc.resolveLines([R(OPT.large, null, 1)], { audience: 'STAFF' })).rejects.toThrow(`Line 1: "Large · Black" has no price — enter a price to override`);
  });
  it('inactive product, size and colour rejected; allowInactive for conversion', async () => {
    const row = sardineRow();
    row.variants[0].isActive = false;
    row.variants[1].isActive = false;
    const s = setup({ rows: [row] });
    await expect(s.svc.resolveLines([R(OPT.large, null, 1)], { audience: 'STAFF' })).rejects.toThrow('Line 1: size "Large" is no longer available');
    await expect(s.svc.resolveLines([R(null, OPT.red, 1)], { audience: 'STAFF' })).rejects.toThrow('Line 1: colour "Red" is no longer available');
    await expect(s.svc.resolveLines([R(OPT.large, OPT.red, 1)], { audience: 'STAFF', allowInactive: true })).resolves.toHaveLength(1);
    const off = sardineRow();
    off.isActive = false;
    await expect(setup({ rows: [off] }).svc.resolveLines([R(null, null, 1)], { audience: 'STAFF' })).rejects.toThrow('Line 1: "Sardine tin" is inactive');
  });
  it('ownership and kind mismatch → 400 with the line prefix', async () => {
    const s = setup();
    await expect(s.svc.resolveLines([R(null, null, 1), R(OPT.red, null, 1)], { audience: 'STAFF' })).rejects.toThrow('Line 2: "Red" is a colour, not a size');
    await expect(s.svc.resolveLines([R('v-foreign', null, 1)], { audience: 'STAFF' })).rejects.toThrow('Line 1: that size belongs to another product');
  });
  it.each([0, 100001, 2.5, NaN, Infinity, 'abc', -1, null])('quantity %p → 400', async (q) => {
    await expect(setup().svc.resolveLines([R(null, null, q as any)], { audience: 'STAFF' })).rejects.toThrow('Line 1: quantity must be a whole number from 1 to 100000');
  });
  it('quantity bounds 1 and 100000 accepted', async () => {
    const r = await setup().svc.resolveLines([R(null, null, 1), R(OPT.large, null, 100000)], { audience: 'STAFF' });
    expect(r.map((x) => x.quantity)).toEqual([1, 100000]);
  });
  it('thin_margin_percent comes from the loaded settings (20 when invalid, see costing spec)', async () => {
    const s = setup();
    s.costing.loadSettings.mockResolvedValue({ ...SETTINGS, thinMarginPercent: 99 });
    const r = await s.svc.resolveLines([R(null, null, 1)], { audience: 'STAFF' });
    expect(r[0].warnings.map((w) => w.code)).toContain('THIN_MARGIN');
  });
});

describe('tiersFor', () => {
  it('standard → PriceTier; size → VariantPriceTier only; colour → 400', async () => {
    const s = setup();
    expect(await s.svc.tiersFor(PRODUCT_ID, null)).toEqual(REGULAR_TIERS);
    expect(await s.svc.tiersFor(PRODUCT_ID, OPT.large)).toEqual(LARGE_TIERS);
    await expect(s.svc.tiersFor(PRODUCT_ID, OPT.red)).rejects.toThrow("Colours share their size's tiers — set tiers on the size");
  });
});

describe('recalcPricing (§3.8 price application)', () => {
  it('writes the standard size and every size from the standard colour, never a colour', async () => {
    const s = setup();
    const res = await s.svc.recalcPricing(PRODUCT_ID);
    const std = (await s.svc.optionCost(PRODUCT_ID, null, null)).computedPrice;
    const large = (await s.svc.optionCost(PRODUCT_ID, OPT.large, null)).computedPrice;
    expect(s.prisma.product.update).toHaveBeenCalledWith({ where: { id: PRODUCT_ID }, data: expect.objectContaining({ basePrice: std }) });
    expect(s.prisma.productVariant.update).toHaveBeenCalledTimes(1);
    expect(s.prisma.productVariant.update).toHaveBeenCalledWith({ where: { id: OPT.large }, data: expect.objectContaining({ basePrice: large }) });
    expect(res.map((r) => r.sizeOptionId)).toEqual([null, OPT.large]);
  });
  it('never writes a price from an incomplete BOM (e.g. an import created a zero-cost filament)', async () => {
    const row = sardineRow();
    row.components[0].material.costPerGram = 0;
    const s = setup({ rows: [row] });
    await s.svc.recalcPricing(PRODUCT_ID);
    const data = s.prisma.product.update.mock.calls[0][0].data;
    expect(data.basePrice).toBeUndefined();
    expect(data.estimatedGrams).toBeGreaterThan(0);
  });
  it('a zero-cost filament assigned only by a colour does not block the size price', async () => {
    const row = sardineRow();
    row.variants[1].colourAssignments[1].material.costPerGram = 0;
    const s = setup({ rows: [row] });
    await s.svc.recalcPricing(PRODUCT_ID);
    expect(s.prisma.product.update.mock.calls[0][0].data.basePrice).toBeGreaterThan(0);
  });
  it('keeps a legacy SIZE\'s values (no components of its own)', async () => {
    const row = sardineRow();
    row.components = row.components.filter((c: any) => c.variantId === null);
    const s = setup({ rows: [row] });
    await s.svc.recalcPricing(PRODUCT_ID);
    expect(s.prisma.productVariant.update).not.toHaveBeenCalled();
  });
  it('colour slot, link, assignment and kind changes change costVersion and cellCosts but not the price', async () => {
    const base = sardineRow();
    const variants = [
      (r: FixtureRow) => { r.variants[1].colourAssignments[0] = { colourSlotId: SLOT.tin, materialId: M.gold, material: fixtureMaterial(M.gold) }; },
      (r: FixtureRow) => { r.colourSlots[0].name = 'Body'; },
      (r: FixtureRow) => { r.components[3].colourSlotId = null; r.components[3].colourFixed = true; },
      (r: FixtureRow) => { r.variants[2].kind = 'SIZE'; r.variants[2].colourAssignments = []; },
    ];
    const v0 = computeCostVersion(toProductConfig(base), SETTINGS);
    const p0 = (await setup({ rows: [base] }).svc.recalcPricing(PRODUCT_ID))[0].price;
    for (const mutate of variants) {
      const row = sardineRow();
      mutate(row);
      expect(computeCostVersion(toProductConfig(row), SETTINGS)).not.toBe(v0);
      expect((await setup({ rows: [row] }).svc.recalcPricing(PRODUCT_ID))[0].price).toBe(p0);
    }
    const crimson = sardineRow();
    variants[0](crimson);
    const cells0 = (await setup({ rows: [base] }).svc.cellCosts(PRODUCT_ID)).cells;
    const cells1 = (await setup({ rows: [crimson] }).svc.cellCosts(PRODUCT_ID)).cells;
    expect(cells1).not.toEqual(cells0);
  });
});

describe('cell costs and option costs (§4.1.2)', () => {
  it('Box example: (Standard, Red) cost 0.394, price 0.930, margin 57.6 %, delta 5.9 — no 0.985 anywhere', async () => {
    const s = setup({ rows: [boxRow({ withRed: true })], tiers: {} });
    const { cells, warnings } = await s.svc.cellCosts(BOX_ID);
    const red = cells.find((c) => c.colourOptionId === 'v-box-red')!;
    expect(red).toMatchObject({ costPerUnit: 0.394, price: 0.93, marginPct: 57.6, deltaVsStandardPct: 5.9, excluded: false, active: true });
    const std = cells.find((c) => c.colourOptionId === null)!;
    expect(std).toMatchObject({ costPerUnit: 0.372, marginPct: 60 });
    expect(warnings).toEqual([]); // +5.9 % is under the 10 % threshold
    const oc = await s.svc.optionCost(BOX_ID, null, 'v-box-red');
    expect(oc).toMatchObject({ computedPrice: null, priceUpToDate: true, marginPct: 57.6, storedPrice: 0.93 });
    expect(JSON.stringify(oc)).not.toContain('0.985');
    expect(JSON.stringify(red)).not.toContain('0.985');
    const stdCost = await s.svc.optionCost(BOX_ID, null, null);
    expect(stdCost).toMatchObject({ computedPrice: 0.93, priceUpToDate: true, marginPct: 60 });
  });

  it('COLOUR_COSTS_MORE: "Silk" at 0.020/g → 29.0 %; the standard colour never warns', async () => {
    const row = boxRow({ withRed: true });
    row.variants.push({ ...row.variants[0], id: 'v-silk', name: 'Silk', colourAssignments: [{ colourSlotId: 'slot-body', materialId: M.gold, material: fixtureMaterial(M.gold) }] });
    const { warnings } = await setup({ rows: [row], tiers: {} }).svc.cellCosts(BOX_ID);
    expect(warnings).toEqual([{ code: 'COLOUR_COSTS_MORE', message: '"Silk" costs 29.0 % more than the standard colour on Standard (cost 0.480, price 0.930, margin 48.4 %)' }]);
  });

  it('COLOUR_COSTS_MORE threshold is strictly > 10 %; excluded or inactive cells never warn', () => {
    const cell = (d: number, over: object = {}) => ({
      sizeOptionId: null, colourOptionId: 'c', sizeLabel: 'Standard', colourLabel: 'X', active: true, excluded: false, offeredToCustomers: true,
      complete: true, costPerUnit: 0.5, price: 0.93, marginPct: 46.2, deltaVsStandardPct: d, problems: [], warnings: [], ...over,
    });
    expect(colourCostWarnings([cell(10.0)])).toEqual([]);
    expect(colourCostWarnings([cell(10.1)]).map((w) => w.code)).toEqual(['COLOUR_COSTS_MORE']);
    expect(colourCostWarnings([cell(29, { excluded: true }), cell(29, { active: false }), cell(29, { colourOptionId: null })])).toEqual([]);
  });

  it('Sardine cells: every size × colour, with excluded and offered flags', async () => {
    const row = sardineRow();
    row.variants[2].sizeExclusions = [{ sizeKey: OPT.large }];
    const { cells } = await setup({ rows: [row] }).svc.cellCosts(PRODUCT_ID);
    expect(cells).toHaveLength(6);
    const lb = cells.find((c) => c.sizeOptionId === OPT.large && c.colourOptionId === OPT.blue)!;
    expect(lb).toMatchObject({ excluded: true, offeredToCustomers: false, price: 2.8 });
    const lr = cells.find((c) => c.sizeOptionId === OPT.large && c.colourOptionId === OPT.red)!;
    expect(lr).toMatchObject({ excluded: false, offeredToCustomers: true });
  });
});

describe('bulkFloor (§3.9)', () => {
  it('Box band 25–49: worst 0.270 at 25 on the standard colour', async () => {
    const f = await setup({ rows: [boxRow()], tiers: { [BOX_ID]: [{ minQty: 25, unitPrice: 1.35 }] } }).svc.bulkFloor(BOX_ID, null, [25, 50]);
    expect(f.bands[0]).toMatchObject({ minQty: 25, maxQty: 49, worstUnitCost: 0.27, worstAtQty: 25, unitCostAtMin: 0.27 });
    expect(f.unitCostAtOne).toBe(0.372);
  });

  it('with colours: worstColour is the most expensive; a zero-cost colour is skipped with COLOUR_COST_UNKNOWN; quantityBasis once per N', async () => {
    const row = boxRow({ withRed: true });
    const zero = { ...fixtureMaterial(M.grey), costPerGram: 0 };
    row.variants.push({ ...row.variants[0], id: 'v-free', name: 'Free', colourAssignments: [{ colourSlotId: 'slot-body', materialId: M.grey, material: zero }] });
    const s = setup({ rows: [row], tiers: {} });
    const spy = jest.spyOn(costEngine, 'quantityBasis');
    const ctx = new CatalogRequestContext();
    const f = await s.svc.bulkFloor(BOX_ID, null, [25, 50], ctx);
    expect(f.bands[0].worstColour).toEqual({ colourOptionId: 'v-box-red', label: 'Red' });
    expect(f.bands[0].worstUnitCost).toBeGreaterThan(f.bands[0].standardWorstUnitCost);
    expect(f.problems.map((p) => p.code)).toEqual(['COLOUR_COST_UNKNOWN']);
    expect(f.problems[0].message).toBe(`"Free" cost can't be computed — Filament "PLA Grey" has no cost per gram — set it on the Filaments page`);
    // band 1: 25..49 (25 points); band 2 (last): 50..73 (P = 12) → 24 points
    expect(spy).toHaveBeenCalledTimes(49);
    expect(ctx.planCache.tablesBuilt).toBe(1);
    spy.mockRestore();
  });

  it('excluded colours are skipped', async () => {
    const row = boxRow({ withRed: true });
    row.variants[0].sizeExclusions = [{ sizeKey: 'standard' }];
    const f = await setup({ rows: [row], tiers: {} }).svc.bulkFloor(BOX_ID, null, [25]);
    expect(f.colours.map((c) => c.label)).toEqual(['Standard']);
  });

  it('a colour → 400', async () => {
    await expect(setup().svc.bulkFloor(PRODUCT_ID, OPT.red, [25])).rejects.toThrow("Colours share their size's tiers — set tiers on the size");
  });
});
