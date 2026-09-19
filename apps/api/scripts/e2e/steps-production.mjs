/** Steps 7–12: planning with plates, stock credit and allocation, colour swap, job PATCH allowlist (spec §7.2). */
import { check, eq, near } from './client.mjs';
import { componentOf, job, order, plan, planAndCreate, platesOf, product, spoolWeight, staffOrder, sumGrams } from './setup.mjs';

const blackSpools = (ctx) => [{ materialId: ctx.ids.black, spoolId: ctx.ids.blackSpool }];

async function step7(ctx) {
  const { admin, ids } = ctx;
  const p = await plan(ctx, ids.order1);
  eq(p.rows.length, 1, 'J4 rows');
  const row = p.rows[0];
  eq(platesOf(row.suggestedPlates), ['12x2', '8x1'], 'suggested plates (12, 12, 8)');
  eq(row.surplus, 2, 'surplus');
  const body = { planVersion: p.planVersion, rows: [{ rowKey: row.rowKey, surplusPolicy: 'KEEP_FOR_STOCK', printerId: ids.printer, spools: blackSpools(ctx) }] };
  const created = await admin.ok('POST', `/jobs/plan/${ids.order1}`, body);
  eq(created.jobsCreated, 1, 'jobsCreated');
  await admin.post(`/jobs/plan/${ids.order1}`, body, { expect: 409 });

  const j = await job(ctx, created.jobs[0].id);
  ids.job1 = j.id;
  eq(platesOf(j.plates), ['12x2', '8x1'], 'JobPlate rows');
  near(sumGrams(j.materials), 300.8, 'JobMaterial grams');
  eq(j.gcodeFilename, null, 'gcodeFilename of a 3-plate job');
  check(j.materials.every((m) => m.spoolId === ids.blackSpool), 'lines use the test spool');

  const before = await spoolWeight(ctx, ids.blackSpool);
  const done = await admin.ok('POST', `/jobs/${j.id}/complete`);
  const credit = (done.stockCredits ?? []).filter((c) => c.componentId === ids.box).reduce((s, c) => s + c.delta, 0);
  eq(credit, 2, 'stockCredits for Box');
  eq(componentOf(await product(ctx, ids.product), 'Box').stockOnHand, 2, 'Box stockOnHand after completion');
  const after = await spoolWeight(ctx, ids.blackSpool);
  near(before - after, 300.8, 'spool deducted', 0.01);
  await admin.post(`/jobs/${j.id}/complete`, undefined, { expect: 409 });
  near(await spoolWeight(ctx, ids.blackSpool), after, 'spool not deducted twice', 0.001);
}

async function step8(ctx) {
  const { ids } = ctx;
  const o = await staffOrder(ctx, [{ productId: ids.product, quantity: 30 }]);
  ids.order2 = o.id;
  const p = await plan(ctx, o.id);
  const row = p.rows[0];
  eq([row.onHand, row.fromStock, row.toProduce], [2, 2, 28], 'onHand/fromStock/toProduce');
  eq(platesOf(row.suggestedPlates), ['12x1', '8x2'], 'suggested plates (12 + 8 + 8)');
  const { created } = await planAndCreate(ctx, o.id, { spools: blackSpools(ctx) });
  eq(created.jobsCreated, 1, 'jobsCreated');
  ids.job2 = created.jobs[0].id;
  near(sumGrams((await job(ctx, ids.job2)).materials), 263.2, 'JobMaterial grams');
  eq(componentOf(await product(ctx, ids.product), 'Box').stockOnHand, 0, 'Box stock after allocation');
  const alloc = (await order(ctx, o.id)).stockAllocations.filter((a) => a.componentId === ids.box).reduce((s, a) => s + a.units, 0);
  eq(alloc, 2, 'PLAN_ALLOCATE units on the order');
  eq((await plan(ctx, o.id)).rows[0].remaining, 0, 'second plan: remaining');
}

async function step9(ctx) {
  const { admin, ids } = ctx;
  const o = await staffOrder(ctx, [{ productId: ids.product, colourOptionId: ids.redOption, quantity: 12 }]);
  ids.orderRed = o.id;
  const { created } = await planAndCreate(ctx, o.id, { surplusPolicy: 'CANCEL_ON_PRINTER', spools: [{ materialId: ids.red, spoolId: ids.redSpool }] });
  eq(created.jobsCreated, 1, 'jobsCreated');
  const j = await job(ctx, created.jobs[0].id);
  eq(j.materials.map((m) => [m.materialId, m.slicedMaterialId]), [[ids.red, ids.black]], 'line is PLA Red, sliced for Black');
  const done = await admin.ok('POST', `/jobs/${j.id}/complete`);
  eq((done.stockCredits ?? []).reduce((s, c) => s + c.delta, 0), 0, 'order job with CANCEL credits nothing');
  const box = componentOf(await product(ctx, ids.product), 'Box');
  eq(box.stockOnHand, 0, 'Box column unchanged');
}

async function step10(ctx) {
  const { admin, ids } = ctx;
  const path = `/products/${ids.product}/components/${ids.box}/stock`;
  const set = await admin.ok('PUT', path, { colourKey: null, stockOnHand: 2, expectedStockOnHand: 0 });
  eq(set.stockOnHand, 2, 'stock set');
  await admin.put(path, { colourKey: null, stockOnHand: 2, expectedStockOnHand: 0 }, { expect: 409 });

  const o = await staffOrder(ctx, [{ productId: ids.product, quantity: 2 }]);
  const statusBefore = (await order(ctx, o.id)).status;
  const { created } = await planAndCreate(ctx, o.id, { fromStock: 2, toProduce: 0 });
  eq(created.jobsCreated, 0, 'stock-only submit creates no job');
  eq(componentOf(await product(ctx, ids.product), 'Box').stockOnHand, 0, 'stock after stock-only plan');
  eq((await order(ctx, o.id)).status, statusBefore, 'order status unchanged');
  const cancelled = await admin.ok('PATCH', `/orders/${o.id}`, { status: 'CANCELLED' });
  const released = (cancelled.stockReleased ?? []).filter((r) => r.componentDescription === 'Box').reduce((s, r) => s + r.units, 0);
  eq(released, 2, 'stockReleased Box');
  eq(componentOf(await product(ctx, ids.product), 'Box').stockOnHand, 2, 'stock after cancel');
}

async function step11(ctx) {
  const { admin, ids } = ctx;
  const created = await admin.ok('POST', '/jobs', {
    name: `${ctx.ts} build stock`, productId: ids.product, colourOptionId: ids.redOption, quantityToProduce: 12,
    stockMode: 'BUILD_STOCK', surplusPolicy: 'KEEP_FOR_STOCK', printerId: ids.printer,
  });
  const j = await job(ctx, created.id);
  const redLine = j.materials.find((m) => m.materialId === ids.red);
  check(redLine, 'the build-stock job has a PLA Red line');
  await admin.ok('PATCH', `/jobs/materials/${redLine.id}/colour`, { materialId: ids.blue, spoolId: ids.blueSpool });
  const done = await admin.ok('POST', `/jobs/${j.id}/complete`);
  const blueKey = `0:${ids.blue}`;
  const blue = (done.stockCredits ?? []).filter((c) => c.componentId === ids.box && c.colourKey === blueKey).reduce((s, c) => s + c.delta, 0);
  eq(blue, 12, 'credit under the Blue key');
  const box = componentOf(await product(ctx, ids.product), 'Box');
  eq(box.stockOnHand, 2, 'base column unchanged');
  eq(box.colourStock.find((s) => s.colourKey === blueKey)?.stockOnHand, 12, 'Blue key balance');
  eq(box.colourStock.find((s) => s.colourKey === `0:${ids.red}`)?.stockOnHand ?? 0, 0, 'Red key unchanged');
}

async function step12(ctx) {
  const { admin, ids } = ctx;
  const before = await job(ctx, ids.job2);
  eq(before.status, 'QUEUED', 'job 2 is QUEUED');
  await admin.ok('PATCH', `/jobs/${ids.job2}`, { orderItemId: null, quantityToProduce: 99 });
  const after = await job(ctx, ids.job2);
  eq([after.orderItemId, after.quantityToProduce], [before.orderItemId, before.quantityToProduce], 'orderItemId and quantityToProduce unchanged');
}

export const stepsProduction = [
  [7, 'plan 12+12+8 KEEP, 409 on resubmit, complete credits +2, spool deducted once', step7],
  [8, 'second order takes 2 from stock, plates 12+8+8, PLAN_ALLOCATE −2', step8],
  [9, 'Red order CANCEL: PLA Red line sliced for Black, no stock credit', step9],
  [10, 'stock only: set 2, 409 on stale, stock-only plan, cancel releases 2', step10],
  [11, 'build stock with a Red→Blue swap credits the Blue key', step11],
  [12, 'job PATCH ignores orderItemId and quantityToProduce', step12],
];
