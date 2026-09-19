import { BadRequestException } from '@nestjs/common';
import { BOX_ID, boxRow } from '../catalog-core/__fixtures__/box-product';
import { M, OPT, PRODUCT_ID, sardineRow, fixtureMaterial, key } from '../catalog-core/__fixtures__/sardine-tin';
import { parseCreateJob, parseFail, parsePreview, parseReprint, parseUpdateJob } from './job-input';
import { JobMaterialsService } from './job-materials.service';
import { addJobRow, addOrder, addSpool, expectStatus, productionHarness, type ProductionHarness } from './__fixtures__/production-harness';

type H = ProductionHarness;
const RED_OPT = 'v-box-red';

const lines = (h: H, jobId: string) => h.db.t('jobMaterial').filter((l: any) => l.jobId === jobId);
const plates = (h: H, jobId: string) => h.db.t('jobPlate').filter((p: any) => p.jobId === jobId).sort((a: any, b: any) => a.sortOrder - b.sortOrder);
const jobRow = (h: H, id: string) => h.db.t('productionJob').find((j: any) => j.id === id);
const spool = (h: H, id: string) => h.db.t('spool').find((s: any) => s.id === id);
const identity = (h: H, jobId: string) =>
  Object.fromEntries(lines(h, jobId).map((l: any) => [`${l.plannedMaterialId}/${l.plannedSlicedMaterialId ?? '-'}`, l.gramsUsed]));

/** Box with ×12 (243 min / 112.8 g) and ×8 (170 min / 75.2 g) layouts, optional colour Red, optional part. */
function box(opts: { withRed?: boolean; parts?: boolean; only12?: boolean } = {}) {
  const row = boxRow({ withRed: opts.withRed });
  if (!opts.only12) {
    row.components[0].plateLayouts.push({
      id: 'box8', componentId: 'box', name: '×8', unitsPerPlate: 8, plateMinutes: 170, plateGrams: 75.2, colorChanges: 0,
      attachmentId: null, gcodeFilename: 'Box x8.gcode', isActive: true, sortOrder: 1, createdAt: new Date(0), updatedAt: new Date(0), slots: [],
    });
  }
  if (opts.parts) row.parts = [{ partId: 'pt1', quantity: 2, part: { id: 'pt1', name: 'Magnet', unitCost: 0.05, isActive: true, stockQty: 10 } }];
  const h = productionHarness([row]);
  for (const m of [M.red, M.blue]) if (!h.db.t('material').some((x: any) => x.id === m)) h.db.insert('material', fixtureMaterial(m));
  h.db.insert('material', { id: 'm-petg', name: 'PETG Black', type: 'PETG', color: 'Black', colorHex: '#000000', brand: null, costPerGram: 0.02 });
  for (const m of [M.black, M.red, M.blue]) addSpool(h.db, m, 5000, { id: `sp-${m}` });
  addSpool(h.db, 'm-petg', 5000, { id: 'sp-petg' });
  return h;
}

function sardine() {
  const h = productionHarness([sardineRow()]);
  h.db.insert('material', fixtureMaterial(M.crimson));
  for (const m of [M.black, M.silver, M.white, M.orange, M.red, M.blue, M.gold, M.crimson]) addSpool(h.db, m, 5000, { id: `sp-${m}` });
  return h;
}

// ------------------------------------------------------------------ J1

describe('J1 create: pair, linkage, plates, lines (§3.7, §7.1 item 17)', () => {
  it('for the Red option: JobMaterial PLA Red, slicedMaterialId Black, planned Red / sliced Black', async () => {
    const h = box({ withRed: true, only12: true });
    const job: any = await h.jobs.create({ productId: BOX_ID, colourOptionId: RED_OPT, quantityToProduce: 12 });
    expect(lines(h, job.id)).toEqual([
      expect.objectContaining({ materialId: M.red, slicedMaterialId: M.black, plannedMaterialId: M.red, plannedSlicedMaterialId: M.black, gramsUsed: 112.8, spoolId: `sp-${M.red}` }),
    ]);
    expect(job.reservation).toEqual({ lines: 1, withSpool: 1, short: [] });
  });

  it('stores the pair and the variantId mirror; a legacy variantId body is mapped by kind', async () => {
    const h = box({ withRed: true });
    const legacy: any = await h.jobs.create({ productId: BOX_ID, variantId: RED_OPT, quantityToProduce: 1 });
    expect([legacy.sizeOptionId, legacy.colourOptionId, legacy.variantId]).toEqual([null, RED_OPT, RED_OPT]);
    const s = sardine();
    const large: any = await s.jobs.create({ variantId: OPT.large, quantityToProduce: 1 });
    expect([large.productId, large.sizeOptionId, large.colourOptionId, large.variantId]).toEqual([PRODUCT_ID, OPT.large, null, OPT.large]);
  });

  it('a size or colour of another product → 400; a colour id as sizeOptionId → 400', async () => {
    const h = sardine();
    const other = boxRow({ withRed: true });
    const { seedProduct } = await import('../products/__fixtures__/fake-catalog-db');
    seedProduct(h.db, other);
    await expectStatus(h.jobs.create({ productId: PRODUCT_ID, colourOptionId: RED_OPT, quantityToProduce: 1 }), 400, 'another product');
    await expectStatus(h.jobs.create({ productId: PRODUCT_ID, sizeOptionId: OPT.red, quantityToProduce: 1 }), 400, 'is a colour, not a size');
    expect(h.db.t('productionJob')).toHaveLength(0);
  });

  describe('linkage', () => {
    const setup = () => {
      const h = box({ withRed: true });
      const a = addOrder(h.db, [{ productId: BOX_ID, colourOptionId: RED_OPT, quantity: 10 }]);
      const b = addOrder(h.db, [{ productId: BOX_ID, quantity: 5 }]);
      return { h, a, b };
    };
    it('orderItemId of another order → 400', async () => {
      const { h, a, b } = setup();
      await expectStatus(h.jobs.create({ productId: BOX_ID, orderId: a.order.id, orderItemId: b.items[0].id, quantityToProduce: 5 }), 400, 'belongs to another order');
    });
    it('orderItemId with a different product or option → 400', async () => {
      const { h, a } = setup();
      await expectStatus(h.jobs.create({ productId: BOX_ID, orderId: a.order.id, orderItemId: a.items[0].id, quantityToProduce: 10 }), 400, "doesn't match the order line");
      await expectStatus(h.jobs.create({ orderId: a.order.id, orderItemId: a.items[0].id, quantityToProduce: 10 }), 400, "doesn't match the order line");
      const ok: any = await h.jobs.create({ productId: BOX_ID, colourOptionId: RED_OPT, orderId: a.order.id, orderItemId: a.items[0].id, quantityToProduce: 10 });
      expect(ok.orderItemId).toBe(a.items[0].id);
    });
    it('componentId → 400; stockMode with orderId → 400', async () => {
      const { h, a } = setup();
      await expectStatus(h.jobs.create({ productId: BOX_ID, componentId: 'box', quantityToProduce: 1 }), 400, "componentId is set by the order's production plan");
      await expectStatus(h.jobs.create({ productId: BOX_ID, orderId: a.order.id, stockMode: 'BUILD_STOCK', quantityToProduce: 1 }), 400, 'stockMode');
    });
  });

  it('suggested plates are stored as JobPlate rows with slots; gcodeFilename only for a single-plate job', async () => {
    const h = box();
    const one: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 12 });
    expect(one.gcodeFilename).toBe('Box x12.gcode');
    const three: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 30, gcodeFilename: 'ignored.gcode' });
    expect(three.gcodeFilename).toBeNull();
    expect(plates(h, three.id).map((p: any) => [p.layoutId, p.plateCount, p.unitsRequired])).toEqual([['box12', 2, 30], ['box8', 1, 30]]);
    expect(plates(h, three.id)[1].slots).toEqual([{ colorIndex: 0, materialId: M.black, slicedMaterialId: null, colourSlotId: 'slot-body', gramsPerPlate: 75.2 }]);
    expect(plates(h, three.id)[0].colourKey).toBe(`0:${M.black}`);
  });

  it('CANCEL grams: 30 boxes (12, 12, 8) → KEEP 300.8 g, CANCEL 282.0 g', async () => {
    const h = box();
    const keep: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 30 });
    const cancel: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 30, surplusPolicy: 'CANCEL_ON_PRINTER' });
    expect(lines(h, keep.id)[0].gramsUsed).toBe(300.8);
    expect(lines(h, cancel.id)[0].gramsUsed).toBe(282.0);
    expect(jobRow(h, cancel.id).surplusPolicy).toBe('CANCEL_ON_PRINTER');
  });

  it('plates that do not cover the units → 400; NO_USABLE_LAYOUT → 400 naming the component', async () => {
    const h = box();
    await expectStatus(h.jobs.create({ productId: BOX_ID, quantityToProduce: 30, plates: [{ componentId: 'box', layoutId: 'box12', plateCount: 2 }] }), 400, 'plates cover 24 units but 30 are needed');
    const bare = boxRow();
    bare.components[0].plateLayouts = [];
    bare.components[0].printMinutes = 0;
    const h2 = productionHarness([bare]);
    await expectStatus(h2.jobs.create({ productId: BOX_ID, quantityToProduce: 3 }), 400, '"Box" has no sliced data');
  });
});

// ------------------------------------------------------------ completion

describe('J6 completion through JobCompletionService (§3.6, §7.1 item 17)', () => {
  const creditOf = async (body: Record<string, unknown>, setup?: (h: H) => Record<string, unknown>) => {
    const h = box({ only12: true });
    const extra = setup?.(h) ?? {};
    const job: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 10, ...body, ...extra });
    const res: any = await h.jobs.completeJob(job.id);
    return { h, res, total: res.stockCredits.reduce((s: number, c: any) => s + c.delta, 0) };
  };

  it('order job KEEP → +S (2)', async () => {
    const { total } = await creditOf({}, (h) => {
      const o = addOrder(h.db, [{ productId: BOX_ID, quantity: 10 }]);
      return { orderId: o.order.id, orderItemId: o.items[0].id };
    });
    expect(total).toBe(2);
  });
  it('order job without orderItemId KEEP → +S', async () => {
    const { total } = await creditOf({}, (h) => ({ orderId: addOrder(h.db, [{ productId: BOX_ID, quantity: 10 }]).order.id }));
    expect(total).toBe(2);
  });
  it('BUILD_STOCK KEEP → R + S (12)', async () => {
    const { total, h } = await creditOf({ stockMode: 'BUILD_STOCK' });
    expect(total).toBe(12);
    expect(h.db.t('productComponent')[0].stockOnHand).toBe(12);
  });
  it('stockMode null KEEP → +S', async () => {
    expect((await creditOf({})).total).toBe(2);
  });
  it('TEST → 0', async () => {
    expect((await creditOf({ purpose: 'TEST', stockMode: 'BUILD_STOCK' })).total).toBe(0);
  });
  it('legacy order job (no plates) → 0', async () => {
    const h = box();
    const o = addOrder(h.db, [{ productId: BOX_ID, quantity: 4 }]);
    const legacy = addJobRow(h.db, { orderId: o.order.id, orderItemId: o.items[0].id, productId: BOX_ID, componentId: 'box', quantityToProduce: 4 });
    const res: any = await h.jobs.completeJob(legacy.id);
    expect(res.stockCredits).toEqual([]);
    expect(h.db.t('productComponent')[0].stockOnHand).toBe(0);
  });

  it('deducts every spool line in the completion transaction', async () => {
    const h = box();
    const job: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 30 });
    await h.jobs.completeJob(job.id);
    expect(spool(h, `sp-${M.black}`).currentWeight).toBeCloseTo(5000 - 300.8, 6);
  });

  it('two concurrent completions → one succeeds, the other 409; spools, stock and movements once', async () => {
    const h = box({ only12: true });
    const job: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 10, stockMode: 'BUILD_STOCK' });
    const [a, b] = await Promise.allSettled([h.jobs.completeJob(job.id), h.jobs.completeJob(job.id)]);
    const results = [a, b];
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.getStatus()).toBe(409);
    expect(spool(h, `sp-${M.black}`).currentWeight).toBeCloseTo(5000 - 112.8, 6);
    expect(h.db.t('productComponent')[0].stockOnHand).toBe(12);
    expect(h.db.t('componentStockMovement')).toHaveLength(1);
  });

  it('a completion racing a fail → exactly one wins', async () => {
    const h = box({ only12: true });
    const job: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 10 });
    const results = await Promise.allSettled([h.jobs.failJob(job.id, { failureReason: 'spaghetti', wasteGrams: 50 }), h.jobs.completeJob(job.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const status = jobRow(h, job.id).status;
    expect(status).toBe(results[0].status === 'fulfilled' ? 'FAILED' : 'COMPLETED');
    const deducted = 5000 - spool(h, `sp-${M.black}`).currentWeight;
    expect(deducted).toBeCloseTo(status === 'FAILED' ? 50 : 112.8, 6);
  });

  it('terminal guards: complete/fail a finished job → 409; PATCH a terminal job → 400; PATCH COMPLETED/FAILED → 400', async () => {
    const h = box({ only12: true });
    const job: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 10 });
    await h.jobs.completeJob(job.id);
    await expectStatus(h.jobs.completeJob(job.id), 409, 'already completed, failed or cancelled');
    await expectStatus(h.jobs.failJob(job.id, { failureReason: 'x' }), 409);
    await expectStatus(h.jobs.update(job.id, { status: 'PAUSED' }), 400, 'terminal state');
    const open: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 10 });
    await expectStatus(h.jobs.update(open.id, { status: 'COMPLETED' }), 400, '/complete');
    await expectStatus(h.jobs.update(open.id, { status: 'FAILED' }), 400, '/fail');
    await expectStatus(h.jobs.completeJob('missing'), 404);
  });

  it('parts: a whole-product job consumes parts (GREATEST 0) with a JobPart snapshot; an order-planned component job does not', async () => {
    const h = box({ parts: true, only12: true });
    const job: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 6 });
    await h.jobs.completeJob(job.id);
    expect(h.db.t('part')[0].stockQty).toBe(0); // 10 − 12 floored at 0
    expect(h.db.t('jobPart')).toEqual([expect.objectContaining({ jobId: job.id, partId: 'pt1', quantity: 12, unitCost: 0.05 })]);
    const comp = addJobRow(h.db, { productId: BOX_ID, componentId: 'box', quantityToProduce: 3 });
    await h.jobs.completeJob(comp.id);
    expect(h.db.t('jobPart')).toHaveLength(1);
  });

  it('printer hours and the recorded duration go through completion; cost runs after commit', async () => {
    const h = box({ only12: true });
    h.db.t('printer')[0].totalPrintHours = 1;
    const job: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 10 });
    await h.jobs.update(job.id, { printDuration: 7200 });
    await h.jobs.completeJob(job.id);
    expect(h.db.t('printer')[0].totalPrintHours).toBe(3);
    expect(h.costing.calculateJobCost).toHaveBeenCalled();
    expect(h.gateway.broadcastNotification).toHaveBeenCalledWith(expect.objectContaining({ title: 'Job Completed' }));
  });
});

// ------------------------------------------------------------------ J8 / J9

describe('J8 PATCH allowlist and J9 fail', () => {
  it('ignores linkage, quantity, purpose, option and policy keys; applies status and printDuration', async () => {
    const h = box({ only12: true });
    const o = addOrder(h.db, [{ productId: BOX_ID, quantity: 10 }]);
    const job: any = await h.jobs.create({ productId: BOX_ID, orderId: o.order.id, orderItemId: o.items[0].id, quantityToProduce: 10 });
    const before = { ...jobRow(h, job.id) };
    await h.jobs.update(job.id, { orderItemId: null, quantityToProduce: 99, purpose: 'TEST', variantId: 'x', surplusPolicy: 'KEEP_FOR_STOCK' });
    const after = jobRow(h, job.id);
    for (const k of ['orderItemId', 'quantityToProduce', 'purpose', 'variantId', 'surplusPolicy', 'status']) expect(after[k]).toEqual(before[k]);
    await h.jobs.update(job.id, { status: 'PAUSED', printDuration: 600 });
    expect(jobRow(h, job.id)).toMatchObject({ status: 'PAUSED', printDuration: 600 });
    await h.jobs.update(job.id, { status: 'IN_PROGRESS' });
    expect(jobRow(h, job.id).startedAt).toBeInstanceOf(Date);
  });

  it('J9: wasteGrams 100001 → 400 and the job stays active; a failure deducts proportional waste and never credits stock', async () => {
    const h = box({ only12: true });
    const job: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 10, stockMode: 'BUILD_STOCK' });
    await expectStatus(h.jobs.failJob(job.id, { failureReason: 'x', wasteGrams: 100_001 }), 400, 'wasteGrams');
    expect(jobRow(h, job.id).status).toBe('QUEUED');
    await h.jobs.failJob(job.id, { failureReason: 'layer shift', wasteGrams: 40 });
    expect(jobRow(h, job.id)).toMatchObject({ status: 'FAILED', wasteGrams: 40, failureReason: 'layer shift' });
    expect(spool(h, `sp-${M.black}`).currentWeight).toBeCloseTo(4960, 6);
    expect(h.db.t('componentStockMovement')).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ J7

describe('J7 reprint', () => {
  it('copies the pair, variantId, purpose, policy, stockMode, plates and slicedMaterialId', async () => {
    const h = box({ withRed: true });
    const job: any = await h.jobs.create({ productId: BOX_ID, colourOptionId: RED_OPT, quantityToProduce: 30, stockMode: 'BUILD_STOCK', surplusPolicy: 'CANCEL_ON_PRINTER' });
    await h.jobs.failJob(job.id, { failureReason: 'x' });
    const re: any = await h.jobs.reprintJob(job.id, {});
    expect(re).toMatchObject({ sizeOptionId: null, colourOptionId: RED_OPT, variantId: RED_OPT, purpose: 'CUSTOMER', surplusPolicy: 'CANCEL_ON_PRINTER', stockMode: 'BUILD_STOCK', reprintOfId: job.id });
    expect(plates(h, re.id).map((p: any) => [p.layoutId, p.plateCount, p.unitsRequired])).toEqual([['box12', 2, 30], ['box8', 1, 30]]);
    expect(lines(h, re.id)).toEqual([expect.objectContaining({ materialId: M.red, slicedMaterialId: M.black, plannedMaterialId: M.red, gramsUsed: 282.0 })]);
  });

  it('a subset reprint of the ×8 plate of a 12+12+8 job for 30 → unitsRequired 6, one ×8 plate by policy, the line copied (including a swap)', async () => {
    for (const [policy, grams] of [['KEEP_FOR_STOCK', 75.2], ['CANCEL_ON_PRINTER', 56.4]] as const) {
      const h = box();
      const job: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 30, surplusPolicy: policy });
      const line = lines(h, job.id)[0];
      await new JobMaterialsService(h.db as any).swapColour(line.id, { materialId: M.blue });
      await h.jobs.failJob(job.id, { failureReason: 'x' });
      const eight = plates(h, job.id).find((p: any) => p.layoutId === 'box8');
      await expectStatus(h.jobs.reprintJob(job.id, { plates: [{ jobPlateId: eight.id, plateCount: 2 }] }), 400, 'at most 1');
      const re: any = await h.jobs.reprintJob(job.id, { plates: [{ jobPlateId: eight.id, plateCount: 1 }] });
      expect(plates(h, re.id).map((p: any) => [p.layoutId, p.plateCount, p.unitsRequired])).toEqual([['box8', 1, 6]]);
      expect(re.gcodeFilename).toBe('Box x8.gcode');
      expect(lines(h, re.id)).toEqual([expect.objectContaining({ materialId: M.blue, spoolId: `sp-${M.blue}`, slicedMaterialId: M.black, plannedMaterialId: M.black, gramsUsed: grams })]);
    }
  });

  it('only FAILED jobs can be reprinted', async () => {
    const h = box();
    const job: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 3 });
    await expectStatus(h.jobs.reprintJob(job.id, {}), 400, 'Only failed jobs');
  });
});

// ------------------------------------------------------------------ cost

describe('calculateCost', () => {
  it('a plate job uses plate minutes when printDuration is null, and no purge', async () => {
    const h = box();
    const job: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 30 });
    await h.jobs.calculateCost(job.id);
    const arg = h.costing.calculateJobCost.mock.calls.at(-1)[0];
    expect(arg.printDuration).toBe((2 * 243 + 170) * 60);
    expect(arg.colorChanges).toBe(0);
    expect(arg.purgeWasteGrams).toBe(0);
  });

  it('a legacy job is unchanged', async () => {
    const h = box();
    const legacy = addJobRow(h.db, { productId: BOX_ID, colorChanges: 3, printDuration: null });
    await h.jobs.calculateCost(legacy.id);
    const arg = h.costing.calculateJobCost.mock.calls.at(-1)[0];
    expect(arg.colorChanges).toBe(3);
    expect(arg.printDuration).toBeNull();
  });
});

// ------------------------------------------------------------- swapColour

describe('swapColour regression (job-materials.service.ts untouched)', () => {
  it('keeps grams, records slicedMaterialId, blocks another plastic and terminal jobs', async () => {
    const h = box({ only12: true });
    const swap = new JobMaterialsService(h.db as any);
    const job: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 12 });
    const line = lines(h, job.id)[0];
    const out: any = await swap.swapColour(line.id, { materialId: M.red });
    expect(out).toMatchObject({ materialId: M.red, gramsUsed: 112.8, slicedMaterialId: M.black, plannedMaterialId: M.black });
    await expect(swap.swapColour(line.id, { materialId: 'm-petg' })).rejects.toThrow(BadRequestException);
    await h.jobs.completeJob(job.id);
    await expect(swap.swapColour(line.id, { materialId: M.blue })).rejects.toThrow('completed');
  });
});

// ---------------------------------------------------------- Sardine tin

describe('Sardine tin J1 (§3.6.1, §7.1 item 27)', () => {
  it('(Large, Red) ×30 BUILD_STOCK KEEP: lines 1071.0 / 123.0 / 122.0 / 34.0 g; completion credits +32, +30, +96, +30', async () => {
    const h = sardine();
    const job: any = await h.jobs.create({ productId: PRODUCT_ID, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantityToProduce: 30, stockMode: 'BUILD_STOCK' });
    expect([job.sizeOptionId, job.colourOptionId, job.variantId, job.gcodeFilename]).toEqual([OPT.large, OPT.red, OPT.large, null]);
    expect(identity(h, job.id)).toEqual({
      [`${M.red}/${M.black}`]: 1071.0,
      [`${M.silver}/-`]: 123.0,
      [`${M.white}/-`]: 122.0,
      [`${M.orange}/-`]: 34.0,
    });
    expect(plates(h, job.id).map((p: any) => [p.componentId, p.unitsPerPlate, p.plateCount, p.unitsRequired])).toEqual([
      ['c6', 4, 8, 30], ['c7', 6, 5, 30], ['c8', 24, 4, 90], ['c9', 10, 3, 30],
    ]);
    const done: any = await h.jobs.completeJob(job.id);
    expect(Object.fromEntries(done.stockCredits.map((c: any) => [`${c.componentId} ${c.colourKey}`, c.delta]))).toEqual({
      [`c6 ${key([0, M.red])}`]: 32,
      [`c7 ${key([0, M.red], [1, M.silver])}`]: 30,
      [`c8 ${key([0, M.white], [1, M.orange])}`]: 96,
      [`c9 ${key([0, M.silver])}`]: 30,
    });
    const comp = (id: string) => h.db.t('productComponent').find((c: any) => c.id === id);
    expect([comp('c8').stockOnHand, comp('c9').stockOnHand]).toEqual([96, 30]);
  });

  it('a swap of the Red / sliced Black line to Crimson keeps slicedMaterialId Black and credits the Crimson keys; Red buckets untouched', async () => {
    const h = sardine();
    const job: any = await h.jobs.create({ productId: PRODUCT_ID, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantityToProduce: 30, stockMode: 'BUILD_STOCK' });
    const redLine = lines(h, job.id).find((l: any) => l.plannedMaterialId === M.red);
    const swapped: any = await new JobMaterialsService(h.db as any).swapColour(redLine.id, { materialId: M.crimson });
    expect(swapped).toMatchObject({ materialId: M.crimson, slicedMaterialId: M.black, plannedMaterialId: M.red, gramsUsed: 1071.0 });
    const done: any = await h.jobs.completeJob(job.id);
    const keys = done.stockCredits.map((c: any) => `${c.componentId} ${c.colourKey}`);
    expect(keys).toEqual(expect.arrayContaining([`c6 ${key([0, M.crimson])}`, `c7 ${key([0, M.crimson], [1, M.silver])}`]));
    expect(h.db.t('componentColourStock').filter((r: any) => r.colourKey.includes(M.red))).toEqual([]);
  });

  it('(Regular, Blue): five planned line identities, including two distinct White lines', async () => {
    const h = sardine();
    const job: any = await h.jobs.create({ productId: PRODUCT_ID, colourOptionId: OPT.blue, quantityToProduce: 10 });
    expect(Object.keys(identity(h, job.id)).sort()).toEqual([
      `${M.blue}/${M.black}`, `${M.gold}/${M.black}`, `${M.orange}/-`, `${M.white}/-`, `${M.white}/${M.silver}`,
    ].sort());
  });
});

// -------------------------------------------------- pre-release order jobs

describe('pre-release order jobs (§3.2, §7.1 item 30)', () => {
  it('reads the pair of its order line: J3 shows the colour, substituted is judged against (Standard, V), J7 writes it and passes the J1 linkage rule', async () => {
    const h = box({ withRed: true, only12: true });
    const o = addOrder(h.db, [{ productId: BOX_ID, variantId: RED_OPT, quantity: 4 }]);
    const item = o.items[0];
    const job = addJobRow(h.db, { orderId: o.order.id, orderItemId: item.id, productId: BOX_ID, componentId: 'box', quantityToProduce: 4, status: 'FAILED' });
    h.db.insert('jobMaterial', { jobId: job.id, materialId: M.red, spoolId: null, gramsUsed: 37.6, costPerGram: 0.012, colorIndex: 0, slicedMaterialId: null, plannedMaterialId: null, plannedSlicedMaterialId: null });
    h.db.insert('jobMaterial', { jobId: job.id, materialId: M.black, spoolId: null, gramsUsed: 1, costPerGram: 0.01, colorIndex: 0, slicedMaterialId: null, plannedMaterialId: null, plannedSlicedMaterialId: null });

    const detail: any = await h.jobs.findOne(job.id);
    expect(detail.colour).toEqual({ id: RED_OPT, name: 'Red' });
    expect(detail.size).toBeNull();
    expect(detail.filamentPlan.map((f: any) => [f.materialId, f.substituted])).toEqual([[M.red, false], [M.black, true]]);

    const re: any = await h.jobs.reprintJob(job.id, {});
    expect([re.sizeOptionId, re.colourOptionId]).toEqual([null, RED_OPT]);
    expect(lines(h, re.id).map((l: any) => l.materialId)).toEqual([M.red, M.black]);
    // The same pair passes J1's linkage rule against the line.
    const again: any = await h.jobs.create({ productId: BOX_ID, colourOptionId: re.colourOptionId, orderId: o.order.id, orderItemId: item.id, quantityToProduce: 4 });
    expect(again.colourOptionId).toBe(RED_OPT);
  });

  it('J3 for a plate job: pair, optionLabel, plates, surplusByComponent, optionColour / swapped flags', async () => {
    const h = box({ withRed: true });
    const job: any = await h.jobs.create({ productId: BOX_ID, colourOptionId: RED_OPT, quantityToProduce: 30, stockMode: 'BUILD_STOCK' });
    const d: any = await h.jobs.findOne(job.id);
    expect(d.optionLabel).toBe('Red');
    expect(d.plates.map((p: any) => [p.componentDescription, p.plateCount])).toEqual([['Box', 2], ['Box', 1]]);
    expect(d.surplusByComponent).toEqual([{ componentId: 'box', description: 'Box', unitsRequired: 30, unitsPrinted: 32, surplus: 2, creditOnComplete: 32 }]);
    expect(d.filamentPlan[0]).toMatchObject({ optionColour: true, swapped: false, substituted: false });
  });
});

// ------------------------------------------------------------ bounds §4.7

function rejects(fn: () => unknown, field: string) {
  let err: any;
  try { fn(); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(BadRequestException);
  expect(err.message).toContain(field);
}

function bounds(name: string, make: (v: unknown) => unknown, field: string, lo: number, hi: number) {
  describe(name, () => {
    it('accepts both bounds; rejects one past each, NaN, Infinity and a string, naming the field', () => {
      expect(() => make(lo)).not.toThrow();
      expect(() => make(hi)).not.toThrow();
      for (const bad of [lo - 1, hi + 1, NaN, Infinity, 'abc']) rejects(() => make(bad), field);
    });
  });
}

describe('J-route bounds (§4.7, §7.1 item 37)', () => {
  bounds('J1 quantityToProduce', (v) => parseCreateJob({ productId: 'p', quantityToProduce: v }), 'quantityToProduce', 1, 100_000);
  bounds('J1 plates[].plateCount', (v) => parseCreateJob({ productId: 'p', plates: [{ componentId: 'c', layoutId: null, plateCount: v }] }), 'plateCount', 1, 10_000);
  bounds('J2 quantity', (v) => parsePreview({ productId: 'p', quantity: v }), 'quantity', 1, 100_000);
  bounds('J2 plates[].plateCount', (v) => parsePreview({ productId: 'p', quantity: 1, plates: [{ componentId: 'c', layoutId: null, plateCount: v }] }), 'plateCount', 1, 10_000);
  bounds('J7 plates[].plateCount', (v) => parseReprint({ plates: [{ jobPlateId: 'x', plateCount: v }] }), 'plateCount', 1, 10_000);
  bounds('J8 printDuration', (v) => parseUpdateJob({ printDuration: v }), 'printDuration', 0, 10_000_000);
  bounds('J8 filamentUsedMm', (v) => parseUpdateJob({ filamentUsedMm: v }), 'filamentUsedMm', 0, 1_000_000_000);
  bounds('J9 wasteGrams', (v) => parseFail({ wasteGrams: v }), 'wasteGrams', 0, 100_000);

  it('plates: ≤200 entries (J1, J2, J7)', () => {
    const many = (n: number) => Array.from({ length: n }, () => ({ componentId: 'c', layoutId: null, plateCount: 1 }));
    expect(() => parseCreateJob({ productId: 'p', plates: many(200) })).not.toThrow();
    rejects(() => parseCreateJob({ productId: 'p', plates: many(201) }), 'plates');
    rejects(() => parsePreview({ productId: 'p', quantity: 1, plates: many(201) }), 'plates');
    rejects(() => parseReprint({ plates: Array.from({ length: 201 }, () => ({ jobPlateId: 'x', plateCount: 1 })) }), 'plates');
  });

  it('J9 failureReason ≤500; J8 status allowlist', () => {
    expect(() => parseFail({ failureReason: 'x'.repeat(500) })).not.toThrow();
    rejects(() => parseFail({ failureReason: 'x'.repeat(501) }), 'failureReason');
    rejects(() => parseUpdateJob({ status: 'BOGUS' }), 'status');
  });
});
