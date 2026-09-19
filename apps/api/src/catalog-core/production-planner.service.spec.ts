import { BomResolverService } from './bom-resolver.service';
import { CatalogRequestContext } from './catalog-context';
import { ProductionPlannerService, type OptionPlan } from './production-planner.service';
import { BOX_ID, boxRow } from './__fixtures__/box-product';
import { plannerPrisma, type FakeJob, type FakeOrder } from './__fixtures__/planner-prisma';
import { fixtureMaterial, key, M, MATERIALS, OPT, PRODUCT_ID, sardineRow, type FixtureRow } from './__fixtures__/sardine-tin';

function setup(state: Parameters<typeof plannerPrisma>[0]) {
  const prisma = plannerPrisma(state);
  const resolver = new BomResolverService(prisma);
  return { prisma, resolver, svc: new ProductionPlannerService(prisma, resolver) };
}

/** Sardine with (C6, "0:<Red>") = 2 extras from an earlier Large Red job (§3.6.1). */
const sardineWithRedBoxes = (): FixtureRow => {
  const row = sardineRow();
  row.components.find((c: any) => c.id === 'c6').colourStock = [{ colourKey: key([0, M.red]), stockOnHand: 2 }];
  return row;
};

const round1 = (x: number) => Math.round(x * 10) / 10;
const rows = (plan: OptionPlan) =>
  plan.components.map((c) => ({
    id: c.componentId, onHand: c.stockOnHand, R: c.unitsRequired,
    plates: c.plates.map((p) => `${p.layout.unitsPerPlate}x${p.plateCount}`).join('+'),
    printed: c.unitsPrinted, surplus: c.surplus,
  }));
const needs = (plan: OptionPlan) =>
  Object.fromEntries(plan.filamentNeeds.map((n) => [`${MATERIALS[n.materialId].name}/${n.slicedMaterialId ? MATERIALS[n.slicedMaterialId].name : '—'}`, round1(n.grams)]));

describe('Sardine tin fixture (§3.6.1, §7.1 item 27)', () => {
  it('order line (Large, Red) × 30 with (C6, Red) = 2: onHand, fromStock, plates and surplus exactly', async () => {
    const { svc } = setup({ rows: [sardineWithRedBoxes()] });
    const plan = await svc.planOption({ productId: PRODUCT_ID, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 30, fromStock: { c6: 2 } });
    expect(rows(plan)).toEqual([
      { id: 'c6', onHand: 2, R: 28, plates: '4x7', printed: 28, surplus: 0 },
      { id: 'c7', onHand: 0, R: 30, plates: '6x5', printed: 30, surplus: 0 },
      { id: 'c8', onHand: 0, R: 90, plates: '24x4', printed: 96, surplus: 6 },
      { id: 'c9', onHand: 0, R: 30, plates: '10x3', printed: 30, surplus: 0 },
    ]);
    expect(plan.components[0].colourKey).toBe(key([0, M.red]));
  });

  it('job lines KEEP: 588.0 / 399.0 + 51.0 / 122.0 + 34.0 / 72.0 g', async () => {
    const { svc } = setup({ rows: [sardineWithRedBoxes()] });
    const plan = await svc.planOption({ productId: PRODUCT_ID, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 30, fromStock: { c6: 2 } });
    const perComponent = Object.fromEntries(plan.components.map((c) => [c.componentId, c.slots.map((s) => [MATERIALS[s.materialId].name, s.slicedMaterialId ? MATERIALS[s.slicedMaterialId].name : null, round1(s.grams)])]));
    expect(perComponent).toEqual({
      c6: [['PLA Red', 'PLA Black', 588.0]],
      c7: [['PLA Red', 'PLA Black', 399.0], ['PLA Silver', null, 51.0]],
      c8: [['PLA White', null, 122.0], ['Silk Orange', null, 34.0]],
      c9: [['PLA Silver', null, 72.0]],
    });
    expect(needs(plan)).toEqual({ 'PLA Red/PLA Black': 987.0, 'PLA Silver/—': 123.0, 'PLA White/—': 122.0, 'Silk Orange/—': 34.0 });
    expect(Object.keys(needs(plan)).some((k) => k.startsWith('PLA Gold'))).toBe(false);
  });

  it('CANCEL on the Fish row: 114.4 / 31.9 g', async () => {
    const { svc } = setup({ rows: [sardineWithRedBoxes()] });
    const plan = await svc.planOption({ productId: PRODUCT_ID, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 30, fromStock: { c6: 2 }, surplusPolicy: 'CANCEL_ON_PRINTER' });
    const fish = plan.components.find((c) => c.componentId === 'c8')!;
    expect(fish.slots.map((s) => round1(s.grams))).toEqual([114.4, 31.9]);
    expect(needs(plan)['PLA Red/PLA Black']).toBe(987.0);
  });

  it('J1 BUILD_STOCK KEEP (no stock taken): C6 ×4 × 8 (S = 2); aggregated lines 1071.0 / 123.0 / 122.0 / 34.0 g', async () => {
    const { svc } = setup({ rows: [sardineWithRedBoxes()] });
    const plan = await svc.planOption({ productId: PRODUCT_ID, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 30 });
    expect(rows(plan)[0]).toEqual({ id: 'c6', onHand: 2, R: 30, plates: '4x8', printed: 32, surplus: 2 });
    expect(needs(plan)).toEqual({ 'PLA Red/PLA Black': 1071.0, 'PLA Silver/—': 123.0, 'PLA White/—': 122.0, 'Silk Orange/—': 34.0 });
  });

  it('(Regular, Blue): five planned line identities, including two distinct White lines', async () => {
    const { svc } = setup({ rows: [sardineRow()] });
    const plan = await svc.planOption({ productId: PRODUCT_ID, sizeOptionId: null, colourOptionId: OPT.blue, quantity: 10 });
    expect(Object.keys(needs(plan)).sort()).toEqual(['PLA Blue/PLA Black', 'PLA Gold/PLA Black', 'PLA White/PLA Silver', 'PLA White/—', 'Silk Orange/—']);
    expect(plan.components[0].plates[0].layout.layoutId).toBe('l1'); // Regular layouts
  });

  it('before planning, freeFilament for another order counts this line at 672.0 g PLA Red for C6', async () => {
    const orders: FakeOrder[] = [
      { id: 'o107', orderNumber: 'ORD-0107', status: 'CONFIRMED', items: [{ id: 'oi-107', productId: PRODUCT_ID, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 30, description: 'Sardine tin — Large — Red' }] },
    ];
    const { svc } = setup({ rows: [sardineWithRedBoxes()], orders, spools: [{ id: 's1', materialId: M.red, currentWeight: 5000 }] });
    const free = await svc.freeFilament([M.red], { excludeOrderId: 'o-new' });
    expect(round1(free.materials.get(M.red)!.reserved)).toBe(672.0 + 399.0);
    const plan = await svc.planOption({ productId: PRODUCT_ID, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 30 });
    expect(round1(plan.components[0].slots[0].grams)).toBe(672.0);
    expect(round1(free.materials.get(M.red)!.free)).toBe(round1(5000 - 1071));
  });
});

describe('ProductionPlannerService.freeFilament (§3.7)', () => {
  const boxLine = (id: string, qty: number, over: object = {}) => ({ id, productId: BOX_ID, quantity: qty, description: 'Box', ...over });
  const boxJob = (over: Partial<FakeJob>): FakeJob => ({ id: 'j', status: 'QUEUED', productId: BOX_ID, plates: [{ componentId: 'box', unitsRequired: 12 }], materials: [{ materialId: M.black, gramsUsed: 112.8 }], ...over });

  it('nets other orders\' remaining units (planOption) plus their active job lines and unlinked jobs; excludes the current order', async () => {
    const { svc } = setup({
      rows: [boxRow()],
      orders: [
        { id: 'o1', orderNumber: 'ORD-1', status: 'CONFIRMED', items: [boxLine('oi-1', 24)] },
        { id: 'o2', orderNumber: 'ORD-2', status: 'CONFIRMED', items: [boxLine('oi-2', 100)] },
      ],
      jobs: [
        boxJob({ id: 'j1', orderId: 'o1', orderItemId: 'oi-1' }), // 12 of 24 planned
        { id: 'j-free', status: 'IN_PROGRESS', materials: [{ materialId: M.black, gramsUsed: 50 }] }, // no order
        boxJob({ id: 'j-self', orderId: 'o2', orderItemId: 'oi-2', materials: [{ materialId: M.black, gramsUsed: 1000 }] }),
      ],
      spools: [{ id: 's', materialId: M.black, currentWeight: 1000 }],
    });
    const free = await svc.freeFilament([M.black], { excludeOrderId: 'o2' });
    // remaining 12 → one ×12 plate (112.8) + j1's line (112.8) + unlinked job (50)
    expect(round1(free.materials.get(M.black)!.reserved)).toBe(275.6);
    expect(round1(free.materials.get(M.black)!.free)).toBe(724.4);
  });

  it('an IN_PRODUCTION order whose Box job is COMPLETED no longer reserves; units allocated from stock reserve nothing', async () => {
    const { svc } = setup({
      rows: [boxRow()],
      orders: [
        { id: 'o1', orderNumber: 'ORD-1', status: 'IN_PRODUCTION', items: [boxLine('oi-1', 12)] },
        { id: 'o3', orderNumber: 'ORD-3', status: 'CONFIRMED', items: [boxLine('oi-3', 5)] },
      ],
      jobs: [boxJob({ id: 'j1', status: 'COMPLETED', orderId: 'o1', orderItemId: 'oi-1' })],
      movements: [{ orderItemId: 'oi-3', componentId: 'box', colourKey: key([0, M.black]), delta: -5, reason: 'PLAN_ALLOCATE' }],
    });
    const free = await svc.freeFilament([M.black]);
    expect(free.materials.get(M.black)!.reserved).toBe(0);
  });

  it('an orphan line (missing product) is skipped with a warning; readiness still returns', async () => {
    const { svc } = setup({
      rows: [boxRow()],
      orders: [{ id: 'o1', orderNumber: 'ORD-9', status: 'CONFIRMED', items: [{ id: 'oi-x', productId: 'p-gone', quantity: 3, description: 'Old thing' }, boxLine('oi-1', 12)] }],
      spools: [{ id: 's', materialId: M.black, currentWeight: 500, material: fixtureMaterial(M.black) }],
    });
    const r = await svc.readiness(BOX_ID, { sizeOptionId: null, colourOptionId: null }, 12);
    expect(r.warnings).toEqual(expect.arrayContaining([{ code: 'LINE_PRODUCT_MISSING', message: 'Order ORD-9 line "Old thing": product no longer exists — skipped' }]));
    expect(r.filament[0]).toMatchObject({ materialId: M.black, gramsNeeded: 112.8, reserved: 113, totalStock: 500 });
  });

  it('a line whose size gained components after a job was planned on the old ones reserves only that job\'s active lines (JOBS_ON_OLD_COMPONENTS)', async () => {
    const { svc } = setup({
      rows: [boxRow()],
      orders: [{ id: 'o1', orderNumber: 'ORD-1', status: 'CONFIRMED', items: [boxLine('oi-1', 24)] }],
      jobs: [boxJob({ id: 'j-old', orderId: 'o1', orderItemId: 'oi-1', plates: [{ componentId: 'old-box', unitsRequired: 24 }], materials: [{ materialId: M.black, gramsUsed: 80 }] })],
    });
    const free = await svc.freeFilament([M.black]);
    expect(free.materials.get(M.black)!.reserved).toBe(80);
    expect(free.warnings.map((w) => w.code)).toEqual(['JOBS_ON_OLD_COMPONENTS']);
  });

  it('a PENDING order\'s jobs (planned from its page) are counted once; a CONFIRMED line\'s jobs are not double-counted', async () => {
    const { svc } = setup({
      rows: [boxRow()],
      orders: [
        { id: 'op', orderNumber: 'ORD-P', status: 'PENDING', items: [boxLine('oi-p', 12)] },
        { id: 'oc', orderNumber: 'ORD-C', status: 'CONFIRMED', items: [boxLine('oi-c', 12)] },
      ],
      jobs: [
        boxJob({ id: 'jp', orderId: 'op', orderItemId: 'oi-p', materials: [{ materialId: M.black, gramsUsed: 100 }] }),
        boxJob({ id: 'jc', orderId: 'oc', orderItemId: 'oi-c', materials: [{ materialId: M.black, gramsUsed: 112.8 }] }),
      ],
    });
    const free = await svc.freeFilament([M.black]);
    expect(round1(free.materials.get(M.black)!.reserved)).toBe(212.8);
  });
});

describe('ProductionPlannerService.readiness', () => {
  it('the Red option: the Red line says it was sliced for Black; both answers are given separately', async () => {
    const row = boxRow({ withRed: true });
    const { svc } = setup({
      rows: [row],
      spools: [
        { id: 'sr', materialId: M.red, currentWeight: 300, material: fixtureMaterial(M.red), printforgeId: 'PF-1', location: { id: 'l', name: 'Shelf A' } },
      ],
      jobs: [{ id: 'other', status: 'QUEUED', materials: [{ materialId: M.red, gramsUsed: 250, spoolId: 'sr' }] }],
    });
    const r = await svc.readiness(BOX_ID, { sizeOptionId: null, colourOptionId: 'v-box-red' }, 10);
    expect(r.option).toMatchObject({ colourOptionId: 'v-box-red', label: 'Red' });
    expect(r.components[0]).toMatchObject({ unitsRequired: 10, plates: [{ unitsPerPlate: 12, plateCount: 1 }], surplus: 2, colourKey: key([0, M.red]), colourLabel: 'PLA Red' });
    const f = r.filament[0];
    expect(f).toMatchObject({ materialId: M.red, slicedMaterialId: M.black, gramsNeeded: 112.8, totalStock: 300, reserved: 250, free: 50, hasEnough: false });
    expect(f.suggestedSpool).toEqual({ id: 'sr', pfid: 'PF-1', location: 'Shelf A', effectiveRemaining: 50 });
    expect(f.spoolHasEnough).toBe(false);
    expect(r.ready).toBe(false);
    expect(r.productionReady).toBe(true);
  });

  it('KEEP vs CANCEL needs', async () => {
    const { svc } = setup({ rows: [boxRow()] });
    const keep = await svc.planOption({ productId: BOX_ID, sizeOptionId: null, colourOptionId: null, quantity: 10 });
    const cancel = await svc.planOption({ productId: BOX_ID, sizeOptionId: null, colourOptionId: null, quantity: 10, surplusPolicy: 'CANCEL_ON_PRINTER' });
    expect(round1(keep.filamentNeeds[0].grams)).toBe(112.8);
    expect(round1(cancel.filamentNeeds[0].grams)).toBe(94.0);
  });

  it('a component without layouts → NO_USABLE_LAYOUT, not a crash', async () => {
    const row = boxRow();
    row.components[0].printMinutes = 0;
    row.components[0].plateLayouts = [];
    const { svc } = setup({ rows: [row] });
    const plan = await svc.planOption({ productId: BOX_ID, sizeOptionId: null, colourOptionId: null, quantity: 3 }, new CatalogRequestContext());
    expect(plan.problems.map((p) => p.code)).toEqual(['NO_USABLE_LAYOUT']);
  });
});
