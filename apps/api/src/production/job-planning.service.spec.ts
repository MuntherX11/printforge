import { BOX_ID, boxRow } from '../catalog-core/__fixtures__/box-product';
import { M, OPT, PRODUCT_ID, fixtureComponent, fixtureMaterial, key, sardineRow } from '../catalog-core/__fixtures__/sardine-tin';
import { addJobRow, addOrder, addSpool, expectStatus, productionHarness, type ProductionHarness } from './__fixtures__/production-harness';

type H = ProductionHarness;

const r1 = (x: number) => Math.round(x * 10) / 10;
const jobsOf = (h: H, orderId: string) => h.db.t('productionJob').filter((j: any) => j.orderId === orderId);
const linesOf = (h: H, jobId: string) => h.db.t('jobMaterial').filter((l: any) => l.jobId === jobId);
const rowOf = (plan: any, componentId: string) => plan.rows.find((r: any) => r.componentId === componentId);

function sardine(mutate?: (row: any) => void) {
  const row = sardineRow();
  mutate?.(row);
  const h = productionHarness([row]);
  h.db.insert('material', fixtureMaterial(M.crimson));
  for (const m of [M.black, M.silver, M.white, M.orange, M.red, M.blue, M.gold, M.crimson]) addSpool(h.db, m, 5000, { id: `sp-${m}` });
  return h;
}

const withLargeRedStock = (n: number) => (row: any) => {
  row.components.find((c: any) => c.id === 'c6').colourStock = [{ colourKey: key([0, M.red]), stockOnHand: n }];
};

function box(opts: { stock?: number; extraRows?: any[] } = {}) {
  const row = boxRow();
  row.components[0].plateLayouts.push({
    id: 'box8', componentId: 'box', name: '×8', unitsPerPlate: 8, plateMinutes: 170, plateGrams: 75.2, colorChanges: 0,
    attachmentId: null, gcodeFilename: 'Box x8.gcode', isActive: true, sortOrder: 1, createdAt: new Date(0), updatedAt: new Date(0), slots: [],
  });
  row.components[0].stockOnHand = opts.stock ?? 0;
  const h = productionHarness([row, ...(opts.extraRows ?? [])]);
  addSpool(h.db, M.black, 5000, { id: 'sp-black' });
  return h;
}

// ---------------------------------------------------------- Sardine tin

describe('Sardine tin J4/J5 (§3.6.1, §7.1 item 27)', () => {
  it('J4 rows for (Large, Red) ×30 with (C6, "0:<Red>") = 2: onHand, fromStock, toProduce, plates and surplus', async () => {
    const h = sardine(withLargeRedStock(2));
    const { order } = addOrder(h.db, [{ productId: PRODUCT_ID, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 30, description: 'Sardine tin — Large — Red' }]);
    const plan: any = await h.planning.previewPlan(order.id);
    const table = plan.rows.map((r: any) => [
      r.componentId, r.needed, r.onHand, r.colourKey, r.fromStock, r.toProduce,
      r.suggestedPlates.map((p: any) => `${p.unitsPerPlate}x${p.plateCount}`).join('+'), r.unitsPrinted, r.surplus,
    ]);
    expect(table).toEqual([
      ['c6', 30, 2, key([0, M.red]), 2, 28, '4x7', 28, 0],
      ['c7', 30, 0, key([0, M.red], [1, M.silver]), 0, 30, '6x5', 30, 0],
      ['c8', 90, 0, key([0, M.white], [1, M.orange]), 0, 90, '24x4', 96, 6],
      ['c9', 30, 0, key([0, M.silver]), 0, 30, '10x3', 30, 0],
    ]);
    expect(plan.rows[0].rowKey).toBe(`${plan.rows[0].orderItemId}:c6`);
    expect(plan.rows[0].optionLabel).toBe('Large · Red');
    expect(plan.rows[0].warnings.map((w: any) => w.code)).toContain('COLOUR_SLOT_UNUSED');
    expect(plan.planVersion).toMatch(/^[0-9a-f]{16}$/);
  });

  it('J5 KEEP: 4 jobs named with the pair, lines 588.0 / 399.0 + 51.0 / 122.0 + 34.0 / 72.0 g, PLAN_ALLOCATE −2 on the Red bucket, gcodeFilename null, variantId = Large', async () => {
    const h = sardine(withLargeRedStock(2));
    const { order, items } = addOrder(h.db, [{ productId: PRODUCT_ID, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 30 }]);
    const plan: any = await h.planning.previewPlan(order.id);
    const res = await h.planning.createFromPlan(order.id, { planVersion: plan.planVersion });
    expect(res.jobsCreated).toBe(4);
    expect(res.allocations).toEqual([{ rowKey: `${items[0].id}:c6`, fromStock: 2 }]);
    const jobs = jobsOf(h, order.id);
    expect(jobs.map((j: any) => j.name)).toEqual([
      'Sardine tin — Large — Red — Large Box (×28)',
      'Sardine tin — Large — Red — Large Lid (×30)',
      'Sardine tin — Large — Red — Large Fish (×90)',
      'Sardine tin — Large — Red — Large Key (×30)',
    ]);
    for (const j of jobs) {
      expect(j).toMatchObject({ orderItemId: items[0].id, sizeOptionId: OPT.large, colourOptionId: OPT.red, variantId: OPT.large, gcodeFilename: null, surplusPolicy: 'KEEP_FOR_STOCK' });
    }
    const grams = jobs.map((j: any) => linesOf(h, j.id).map((l: any) => [l.materialId, l.slicedMaterialId, l.gramsUsed]));
    expect(grams).toEqual([
      [[M.red, M.black, 588.0]],
      [[M.red, M.black, 399.0], [M.silver, null, 51.0]],
      [[M.white, null, 122.0], [M.orange, null, 34.0]],
      [[M.silver, null, 72.0]],
    ]);
    expect(h.db.t('componentStockMovement')).toEqual([
      expect.objectContaining({ componentId: 'c6', colourKey: key([0, M.red]), delta: -2, reason: 'PLAN_ALLOCATE', orderItemId: items[0].id, baseColumn: false }),
    ]);
    expect(h.db.t('order')[0].status).toBe('IN_PRODUCTION');
    expect(h.db.locks).toEqual([{ table: 'ProductVariant', mode: 'SHARE', ids: [OPT.large, OPT.red] }]);

    // Second preview: everything planned.
    const again: any = await h.planning.previewPlan(order.id);
    expect(again.rows.map((r: any) => [r.alreadyPlanned, r.allocatedFromStock, r.remaining])).toEqual([[28, 2, 0], [30, 0, 0], [90, 0, 0], [30, 0, 0]]);

    // Completion of the fish job credits the 6 extras to its base column.
    const fish = jobs[2];
    const done: any = await h.jobs.completeJob(fish.id);
    expect(done.stockCredits).toEqual([{ componentId: 'c8', colourKey: key([0, M.white], [1, M.orange]), delta: 6, balanceAfter: 6 }]);
  });

  it('J5 with CANCEL on the Fish row: 114.4 / 31.9 g', async () => {
    const h = sardine();
    const { order, items } = addOrder(h.db, [{ productId: PRODUCT_ID, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 30 }]);
    const plan: any = await h.planning.previewPlan(order.id);
    await h.planning.createFromPlan(order.id, { planVersion: plan.planVersion, rows: [{ rowKey: `${items[0].id}:c8`, surplusPolicy: 'CANCEL_ON_PRINTER' }] });
    const fish = jobsOf(h, order.id).find((j: any) => j.componentId === 'c8');
    expect(linesOf(h, fish.id).map((l: any) => l.gramsUsed)).toEqual([114.4, 31.9]);
    expect(fish.surplusPolicy).toBe('CANCEL_ON_PRINTER');
  });
});

// ---------------------------------------------------------- rows (item 18)

describe('J4/J5 rows (§4.4.1, §7.1 item 18)', () => {
  it('Regular ×5 and Large ×3 of one product → distinct rows; Large·Red ×5 and Large·Blue ×5 read different colour buckets', async () => {
    const h = sardine();
    const a = addOrder(h.db, [{ productId: PRODUCT_ID, quantity: 5 }, { productId: PRODUCT_ID, sizeOptionId: OPT.large, quantity: 3 }]);
    const plan: any = await h.planning.previewPlan(a.order.id);
    expect(plan.rows).toHaveLength(9);
    expect(new Set(plan.rows.map((r: any) => r.rowKey)).size).toBe(9);
    const b = addOrder(h.db, [
      { productId: PRODUCT_ID, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 5 },
      { productId: PRODUCT_ID, sizeOptionId: OPT.large, colourOptionId: OPT.blue, quantity: 5 },
    ]);
    const p2: any = await h.planning.previewPlan(b.order.id);
    const boxes = p2.rows.filter((r: any) => r.componentId === 'c6').map((r: any) => r.colourKey);
    expect(boxes).toEqual([key([0, M.red]), key([0, M.blue])]);
  });

  it('two colours with the same assignment read one bucket (Band: Gold + White for Red and Blue)', async () => {
    const h = sardine((row) => { row.components.find((c: any) => c.id === 'c5').colourStock = [{ colourKey: key([0, M.gold], [1, M.white]), stockOnHand: 3 }]; });
    const { order } = addOrder(h.db, [{ productId: PRODUCT_ID, colourOptionId: OPT.red, quantity: 2 }, { productId: PRODUCT_ID, colourOptionId: OPT.blue, quantity: 2 }]);
    const plan: any = await h.planning.previewPlan(order.id);
    const bands = plan.rows.filter((r: any) => r.componentId === 'c5');
    expect(bands.map((r: any) => [r.colourKey, r.onHand])).toEqual([[key([0, M.gold], [1, M.white]), 3], [key([0, M.gold], [1, M.white]), 3]]);
  });

  it('fromStock allocation writes a movement and decrements; stock-only submit creates no job and leaves the order status', async () => {
    const h = box({ stock: 2 });
    const { order, items } = addOrder(h.db, [{ productId: BOX_ID, quantity: 2 }]);
    const plan: any = await h.planning.previewPlan(order.id);
    expect(plan.rows[0]).toMatchObject({ fromStock: 2, toProduce: 0 });
    const res = await h.planning.createFromPlan(order.id, { planVersion: plan.planVersion });
    expect(res).toMatchObject({ jobsCreated: 0, allocations: [{ rowKey: `${items[0].id}:box`, fromStock: 2 }] });
    expect(h.db.t('productComponent')[0].stockOnHand).toBe(0);
    expect(h.db.t('componentStockMovement')).toEqual([expect.objectContaining({ delta: -2, baseColumn: true, reason: 'PLAN_ALLOCATE', balanceAfter: 0 })]);
    expect(h.db.t('order')[0].status).toBe('CONFIRMED');
  });

  it('fromStock > onHand → 400; a stock change between J4 and J5 → 409; plates must cover toProduce', async () => {
    const h = box({ stock: 2 });
    const { order, items } = addOrder(h.db, [{ productId: BOX_ID, quantity: 30 }]);
    const rowKey = `${items[0].id}:box`;
    const plan: any = await h.planning.previewPlan(order.id);
    await expectStatus(h.planning.createFromPlan(order.id, { planVersion: plan.planVersion, rows: [{ rowKey, fromStock: 3, toProduce: 0 }] }), 400, 'only 2 in printed stock');
    await expectStatus(h.planning.createFromPlan(order.id, { planVersion: plan.planVersion, rows: [{ rowKey, fromStock: 2, toProduce: 28, plates: [{ layoutId: 'box12', plateCount: 2 }] }] }), 400, 'plates cover 24 units but 28 are needed');
    await expectStatus(h.planning.createFromPlan(order.id, { planVersion: plan.planVersion, rows: [{ rowKey, fromStock: 2, toProduce: 29 }] }), 400, 'remain to plan');
    await expectStatus(h.planning.createFromPlan(order.id, { planVersion: plan.planVersion, rows: [{ rowKey: 'nope:box' }] }), 400, 'Unknown plan row');
    h.db.t('productComponent')[0].stockOnHand = 1;
    await expectStatus(h.planning.createFromPlan(order.id, { planVersion: plan.planVersion }), 409, 'The plan changed');
    expect(h.db.t('productionJob')).toHaveLength(0);
  });

  it('the legacy overrides body → 400 Reload the production plan', async () => {
    const h = box();
    const { order } = addOrder(h.db, [{ productId: BOX_ID, quantity: 3 }]);
    await expectStatus(h.planning.createFromPlan(order.id, { overrides: [{ componentId: 'box', toProduce: 3 }] }), 400, 'Reload the production plan');
  });

  it('two concurrent J5 submits with the same planVersion → one creates jobs, the other 409; filament reserved once', async () => {
    const h = sardine();
    const { order } = addOrder(h.db, [{ productId: PRODUCT_ID, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 30 }]);
    const plan: any = await h.planning.previewPlan(order.id);
    const results = await Promise.allSettled([
      h.planning.createFromPlan(order.id, { planVersion: plan.planVersion }),
      h.planning.createFromPlan(order.id, { planVersion: plan.planVersion }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.getStatus()).toBe(409);
    expect(jobsOf(h, order.id)).toHaveLength(4);
    expect(h.db.t('jobMaterial')).toHaveLength(6);
  });

  it('spools per filament line: White and Orange of a multicolour row each get their own spool; wrong, inactive or unknown → 400', async () => {
    const h = sardine();
    addSpool(h.db, M.white, 800, { id: 'sp-w2' });
    addSpool(h.db, M.orange, 800, { id: 'sp-o2' });
    addSpool(h.db, M.white, 800, { id: 'sp-w-off', isActive: false });
    const { order, items } = addOrder(h.db, [{ productId: PRODUCT_ID, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 30 }]);
    const rowKey = `${items[0].id}:c8`;
    const plan: any = await h.planning.previewPlan(order.id);
    const submit = (spools: any[]) => h.planning.createFromPlan(order.id, { planVersion: plan.planVersion, rows: [{ rowKey, spools }] });
    await expectStatus(submit([{ materialId: M.white, spoolId: `sp-${M.orange}` }]), 400, 'Spool does not belong to the selected material');
    await expectStatus(submit([{ materialId: M.white, spoolId: 'sp-w-off' }]), 400, 'inactive');
    await expectStatus(submit([{ materialId: M.red, spoolId: `sp-${M.red}` }]), 400, 'Unknown filament for "Large Fish"');
    await expectStatus(submit([{ materialId: M.white, spoolId: 'missing' }]), 404, 'Spool not found');
    await submit([{ materialId: M.white, spoolId: 'sp-w2' }, { materialId: M.orange, spoolId: 'sp-o2' }]);
    const fish = jobsOf(h, order.id).find((j: any) => j.componentId === 'c8');
    expect(linesOf(h, fish.id).map((l: any) => [l.materialId, l.spoolId])).toEqual([[M.white, 'sp-w2'], [M.orange, 'sp-o2']]);
  });

  it('alreadyPlanned counts a J1 product job for the line via JobPlate.unitsRequired, and a FAILED job with a subset reprint via its finished plates', async () => {
    const h = box();
    const { order, items } = addOrder(h.db, [{ productId: BOX_ID, quantity: 30 }]);
    const job: any = await h.jobs.create({ productId: BOX_ID, orderId: order.id, orderItemId: items[0].id, quantityToProduce: 30 });
    let plan: any = await h.planning.previewPlan(order.id);
    expect(plan.rows[0]).toMatchObject({ alreadyPlanned: 30, remaining: 0 });
    await h.jobs.failJob(job.id, { failureReason: 'x' });
    plan = await h.planning.previewPlan(order.id);
    expect(plan.rows[0]).toMatchObject({ alreadyPlanned: 0, remaining: 30 });
    const eight = h.db.t('jobPlate').find((p: any) => p.jobId === job.id && p.layoutId === 'box8');
    await h.jobs.reprintJob(job.id, { plates: [{ jobPlateId: eight.id, plateCount: 1 }] });
    plan = await h.planning.previewPlan(order.id);
    expect(plan.rows[0]).toMatchObject({ alreadyPlanned: 30, remaining: 0 }); // 24 finished + 6 reprinted
  });

  it('an open job on a component no longer in the BOM → JOBS_ON_OLD_COMPONENTS and suggestions 0', async () => {
    const h = box({ stock: 0 });
    const { order, items } = addOrder(h.db, [{ productId: BOX_ID, quantity: 10 }]);
    addJobRow(h.db, { orderId: order.id, orderItemId: items[0].id, productId: BOX_ID, componentId: 'old-lid', quantityToProduce: 10 });
    const plan: any = await h.planning.previewPlan(order.id);
    expect(plan.rows[0]).toMatchObject({ remaining: 10, fromStock: 0, toProduce: 0 });
    expect(plan.rows[0].warnings.map((w: any) => w.code)).toContain('JOBS_ON_OLD_COMPONENTS');
  });

  it('an orphan line (missing product) → no rows for it and a warning; the other lines are planned. A line whose option belongs to another product → LINE_OPTION_MISMATCH', async () => {
    const h = box();
    const { order } = addOrder(h.db, [
      { productId: 'gone', quantity: 2, description: 'Old thing' },
      { productId: BOX_ID, variantId: OPT.red, quantity: 2, description: 'Box — Red?' },
      { productId: BOX_ID, quantity: 3 },
    ]);
    h.db.insert('productVariant', { id: OPT.red, productId: PRODUCT_ID, kind: 'COLOUR', name: 'Red', isActive: true, sortOrder: 0 });
    const plan: any = await h.planning.previewPlan(order.id);
    expect(plan.rows).toHaveLength(1);
    expect(plan.warnings.map((w: any) => w.code)).toEqual(['LINE_PRODUCT_MISSING', 'LINE_OPTION_MISMATCH']);
    const res = await h.planning.createFromPlan(order.id, { planVersion: plan.planVersion });
    expect(res.jobsCreated).toBe(1);
  });

  it('bounds: fromStock 1000001 → 400 before any lock is taken; more rows than J4 has → 400; 13 spools → 400', async () => {
    const h = box();
    const { order, items } = addOrder(h.db, [{ productId: BOX_ID, quantity: 3 }]);
    const rowKey = `${items[0].id}:box`;
    h.db.$queryRaw.mockClear();
    await expectStatus(h.planning.createFromPlan(order.id, { planVersion: 'x', rows: [{ rowKey, fromStock: 1_000_001 }] }), 400, 'fromStock');
    await expectStatus(h.planning.createFromPlan(order.id, { planVersion: 'x', rows: [{ rowKey, toProduce: -1 }] }), 400, 'toProduce');
    await expectStatus(h.planning.createFromPlan(order.id, { planVersion: 'x', rows: [{ rowKey, fromStock: 2.5 }] }), 400, 'fromStock');
    await expectStatus(h.planning.createFromPlan(order.id, { planVersion: 'x', rows: [{ rowKey, spools: Array.from({ length: 13 }, () => ({ materialId: 'a', spoolId: 'b' })) }] }), 400, 'spools');
    await expectStatus(h.planning.createFromPlan(order.id, { planVersion: 'x', rows: [{ rowKey, plates: [{ layoutId: null, plateCount: 10_001 }] }] }), 400, 'plateCount');
    expect(h.db.$queryRaw.mock.calls.some(([q]: any) => /plan:advisory/.test(q.sql))).toBe(false);
    const plan: any = await h.planning.previewPlan(order.id);
    await expectStatus(h.planning.createFromPlan(order.id, { planVersion: plan.planVersion, rows: [{ rowKey }, { rowKey }] }), 400, 'More plan rows');
  });
});

// -------------------------------------------- plan version (item 34)

describe('planVersion and colour changes (§7.1 item 34)', () => {
  const setup = () => {
    const h = sardine();
    const { order, items } = addOrder(h.db, [{ productId: PRODUCT_ID, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 30 }]);
    return { h, order, item: items[0] };
  };

  it('an O5 change of the line\'s colour between J4 and J5 → 409 (every onHand is 0: the resolved filaments are in the hash)', async () => {
    const { h, order } = setup();
    const plan: any = await h.planning.previewPlan(order.id);
    expect(plan.rows.every((r: any) => r.onHand === 0)).toBe(true);
    h.db.t('colourOptionSlot').find((a: any) => a.variantId === OPT.red && a.colourSlotId === 'slot-tin').materialId = M.crimson;
    await expectStatus(h.planning.createFromPlan(order.id, { planVersion: plan.planVersion }), 409);
  });

  it('an O7 reclassification between J4 and J5 → 409', async () => {
    const h = sardine();
    const { order } = addOrder(h.db, [{ productId: PRODUCT_ID, variantId: OPT.large, quantity: 3 }]);
    const plan: any = await h.planning.previewPlan(order.id);
    expect(plan.rows.map((r: any) => r.componentId)).toEqual(['c6', 'c7', 'c8', 'c9']);
    h.db.t('productVariant').find((v: any) => v.id === OPT.large).kind = 'COLOUR';
    await expectStatus(h.planning.createFromPlan(order.id, { planVersion: plan.planVersion }), 409);
  });

  it('an S11 split between J4 and J5 → 409', async () => {
    const { h, order, item } = setup();
    const plan: any = await h.planning.previewPlan(order.id);
    const row = h.db.t('orderItem').find((i: any) => i.id === item.id);
    row.quantity = 20;
    await expectStatus(h.planning.createFromPlan(order.id, { planVersion: plan.planVersion }), 409);
  });

  it('a line with a Red allocation and a job planned in PLA Red, after O5 changes Tin to Crimson → its rows carry LINE_COLOUR_CHANGED', async () => {
    const h = sardine(withLargeRedStock(2));
    const { order } = addOrder(h.db, [{ productId: PRODUCT_ID, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 30 }]);
    const plan: any = await h.planning.previewPlan(order.id);
    await h.planning.createFromPlan(order.id, { planVersion: plan.planVersion });
    h.db.t('colourOptionSlot').find((a: any) => a.variantId === OPT.red && a.colourSlotId === 'slot-tin').materialId = M.crimson;
    h.db.t('orderItem')[0].quantity = 40;
    const after: any = await h.planning.previewPlan(order.id);
    const warn = (c: string) => rowOf(after, c).warnings.filter((w: any) => w.code === 'LINE_COLOUR_CHANGED').map((w: any) => w.message);
    expect(warn('c6')).toEqual(['30 units of "Large Box" were planned in PLA Red — the rest would print in PLA Crimson']);
    expect(warn('c7')).toEqual(['30 units of "Large Lid" were planned in PLA Red + PLA Silver — the rest would print in PLA Crimson + PLA Silver']);
    expect(warn('c8')).toEqual([]);
  });
});

// ------------------------------------ placeholders, planWithSuggestions (item 38)

describe('placeholder jobs and planWithSuggestions (§3.7, §7.1 item 38)', () => {
  it('3 placeholder jobs on a Box ×3 line: alreadyPlanned 3, remaining 0, PLACEHOLDER_JOBS, never JOBS_ON_OLD_COMPONENTS; after J8 cancels them remaining 3', async () => {
    const h = box();
    const { order, items } = addOrder(h.db, [{ productId: BOX_ID, quantity: 3 }]);
    const ph = [1, 2, 3].map(() => addJobRow(h.db, { orderId: order.id, orderItemId: items[0].id, productId: null, componentId: null, quantityToProduce: 1 }));
    let plan: any = await h.planning.previewPlan(order.id);
    expect(plan.rows[0]).toMatchObject({ alreadyPlanned: 3, remaining: 0, toProduce: 0 });
    const codes = plan.rows[0].warnings.map((w: any) => w.code);
    expect(codes).toContain('PLACEHOLDER_JOBS');
    expect(codes).not.toContain('JOBS_ON_OLD_COMPONENTS');
    for (const j of ph) await h.jobs.update(j.id, { status: 'CANCELLED' });
    plan = await h.planning.previewPlan(order.id);
    expect(plan.rows[0]).toMatchObject({ alreadyPlanned: 0, remaining: 3, toProduce: 3 });
  });

  it('completing a placeholder credits 0, deducts no spool and consumes no parts', async () => {
    const row = boxRow();
    row.parts = [{ partId: 'pt1', quantity: 1, part: { id: 'pt1', name: 'Magnet', unitCost: 0.05, isActive: true, stockQty: 10 } }];
    const h = productionHarness([row]);
    addSpool(h.db, M.black, 1000, { id: 'sp-black' });
    const { order, items } = addOrder(h.db, [{ productId: BOX_ID, quantity: 1 }]);
    const ph = addJobRow(h.db, { orderId: order.id, orderItemId: items[0].id, quantityToProduce: 1 });
    const res: any = await h.jobs.completeJob(ph.id);
    expect(res.stockCredits).toEqual([]);
    expect(h.db.t('spool')[0].currentWeight).toBe(1000);
    expect(h.db.t('part')[0].stockQty).toBe(10);
    expect(h.db.t('componentStockMovement')).toHaveLength(0);
  });

  it('planWithSuggestions on a 2-line order: the planned product gets its jobs and allocation, the unplannable one JOBS_NOT_PLANNED; a second call creates nothing', async () => {
    const bare = fixtureComponent('bare', null, 'Bare part', 1, 0, 0, [[0, M.black, 0, null]], [], { gcodeFilename: null });
    bare.productId = 'p-bare';
    const bareRow = { ...boxRow(), id: 'p-bare', name: 'Bare', colourSlots: [], variants: [], components: [bare] };
    const h = box({ stock: 2, extraRows: [bareRow] });
    h.db.t('productComponent').find((c: any) => c.id === 'box').stockConfirmedAt = new Date();
    const { order, items } = addOrder(h.db, [{ productId: BOX_ID, quantity: 30 }, { productId: 'p-bare', quantity: 4, description: 'Bare ×4' }]);
    const res = await h.planning.planWithSuggestions(order.id);
    expect(res.jobsCreated).toBe(1);
    const job = jobsOf(h, order.id)[0];
    expect(job).toMatchObject({ orderItemId: items[0].id, componentId: 'box', quantityToProduce: 28 });
    expect(h.db.t('jobPlate').filter((p: any) => p.jobId === job.id).map((p: any) => [p.unitsPerPlate, p.plateCount])).toEqual([[12, 1], [8, 2]]);
    expect(linesOf(h, job.id).map((l: any) => l.gramsUsed)).toEqual([r1(112.8 + 2 * 75.2)]);
    expect(res.allocations).toEqual([{ rowKey: `${items[0].id}:box`, fromStock: 2 }]);
    expect(res.warnings).toEqual([expect.objectContaining({ code: 'JOBS_NOT_PLANNED', message: expect.stringContaining('"Bare part" has no sliced data') })]);

    const again = await h.planning.planWithSuggestions(order.id);
    expect(again.jobsCreated).toBe(0);
    expect(again.allocations).toEqual([]);
    expect(jobsOf(h, order.id)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ J2

describe('J2 preview', () => {
  it('fills creditOnComplete per §3.6 (no order), lists layouts per component and the resolver warnings', async () => {
    const h = box();
    const build: any = await h.jobs.preview({ productId: BOX_ID, quantity: 10, stockMode: 'BUILD_STOCK' });
    expect(build.components[0]).toMatchObject({ unitsRequired: 10, unitsPrinted: 12, surplus: 2, creditOnComplete: 12 });
    expect(build.layoutsByComponent.box.map((l: any) => l.unitsPerPlate)).toEqual([12, 8, 1]);
    const direct: any = await h.jobs.preview({ productId: BOX_ID, quantity: 10, surplusPolicy: 'CANCEL_ON_PRINTER' });
    expect(direct.components[0].creditOnComplete).toBe(0);

    const s = sardine();
    const large: any = await s.jobs.preview({ productId: PRODUCT_ID, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 30, stockMode: 'BUILD_STOCK' });
    expect(large.warnings.map((w: any) => w.code)).toContain('COLOUR_SLOT_UNUSED');
    expect(large.components.map((c: any) => c.creditOnComplete)).toEqual([32, 30, 96, 30]);
    await expectStatus(s.jobs.preview({ productId: PRODUCT_ID, sizeOptionId: OPT.red, quantity: 1 }), 400, 'is a colour, not a size');
  });
});
