import { SETTINGS } from '../catalog-core/__fixtures__/box-product';
import { PricingService } from '../catalog-core/pricing.service';
import { OrdersService } from '../orders/orders.service';
import { expectStatus } from '../production/__fixtures__/production-harness';
import { JobSchedulingService } from '../production/job-scheduling.service';
import { useTempUploadDir } from '../slice/__fixtures__/slice-harness';
import { HI, K1, M, mixedGcode, orderPlatesHarness, type OrderPlatesHarness } from './__fixtures__/order-plates-harness';
import { NOTHING_TO_CREATE } from './order-plate-jobs.service';

/**
 * Jobs from the sliced plates of an order (v2.19.0), and the jobs of one plate
 * acting as the one physical print they are.
 */

useTempUploadDir();

type Order = ReturnType<OrderPlatesHarness['order']>;

async function setup(quantity = 6, mutate?: Parameters<typeof orderPlatesHarness>[0]) {
  const x = orderPlatesHarness(mutate);
  await x.seedFiles();
  x.slicer.onModuleInit();
  return { x, o: x.order(quantity) };
}
/** A sliced MIXED plate of dresses and hats on the K1: 140 min, 28 g. */
async function sliced(x: OrderPlatesHarness, o: Order, asked = [4, 2], placed = asked) {
  const p = await x.plates.createPlate(o.id, { kind: 'MIXED', printerId: K1, items: [{ rowKey: o.key('dress'), units: asked[0] }, { rowKey: o.key('hat'), units: asked[1] }] });
  await x.plates.queueOne(p.id, {});
  x.ok(mixedGcode(placed, { minutes: 140, grams: 28 }), placed);
  await x.processor.tick();
  expect(x.plate(p.id).status).toBe('DONE');
  return x.plate(p.id);
}
const jobsOf = (x: OrderPlatesHarness, orderId: string) => x.db.t('productionJob').filter((j: any) => j.orderId === orderId);
const platesOfJob = (x: OrderPlatesHarness, jobId: string) => x.db.t('jobPlate').filter((p: any) => p.jobId === jobId);
const linesOf = (x: OrderPlatesHarness, jobId: string) => x.db.t('jobMaterial').filter((l: any) => l.jobId === jobId);
const statusOfOrder = (x: OrderPlatesHarness, id: string) => x.db.t('order').find((r: any) => r.id === id).status;

describe('create jobs', () => {
  it('one job per part on a sliced plate, built like a planned job, all carrying the plate', async () => {
    const { x, o } = await setup();
    const p = await sliced(x, o);
    const res = await x.jobs.createJobs(o.id, {}, 'user-1');
    expect(res).toMatchObject({ jobsCreated: 2, warnings: [] });
    const [dress, hat] = jobsOf(x, o.id);
    expect(res.jobIds).toEqual([dress.id, hat.id]);
    expect(dress).toMatchObject({
      name: 'Doll — dress (×4) · Plate 1 · K1', status: 'QUEUED', orderId: o.id, orderItemId: o.itemId, productId: 'p-doll', componentId: 'dress',
      sizeOptionId: null, colourOptionId: null, printerId: K1, quantityToProduce: 4, orderPlateId: p.id, purpose: 'CUSTOMER', surplusPolicy: 'KEEP_FOR_STOCK',
      gcodeFilename: p.gcodeFilename,
    });
    expect(p.gcodeFilename).toMatch(/ Plate 1 K1 [a-z0-9]{1,5}\.gcode$/);
    expect(hat).toMatchObject({ name: 'Doll — hat (×2) · Plate 1 · K1', componentId: 'hat', quantityToProduce: 2, orderPlateId: p.id, gcodeFilename: dress.gcodeFilename });

    // The plate row of each job: what the slicer placed, and the part's share of the plate.
    expect(platesOfJob(x, dress.id)).toEqual([expect.objectContaining({
      componentId: 'dress', layoutId: null, label: 'Plate 1 · K1', unitsPerPlate: 4, plateCount: 1, unitsRequired: 4, plateMinutes: 120, plateGrams: 24,
      attachmentId: p.attachmentId, gcodeFilename: p.gcodeFilename,
      slots: [{ colorIndex: 0, materialId: M.black, slicedMaterialId: null, colourSlotId: null, gramsPerPlate: 24 }],
    })]);
    expect(platesOfJob(x, hat.id)[0]).toMatchObject({ unitsPerPlate: 2, unitsRequired: 2, plateMinutes: 20, plateGrams: 4 });
    // Together the jobs are the plate.
    expect(platesOfJob(x, dress.id)[0].plateMinutes + platesOfJob(x, hat.id)[0].plateMinutes).toBe(140);
    expect(linesOf(x, dress.id)).toEqual([expect.objectContaining({ materialId: M.black, spoolId: `sp-${M.black}`, gramsUsed: 24, plannedMaterialId: M.black })]);
    expect(linesOf(x, hat.id)[0]).toMatchObject({ gramsUsed: 4, spoolId: `sp-${M.black}` });
    expect(statusOfOrder(x, o.id)).toBe('IN_PRODUCTION');

    const plan = await x.plates.getPlan(o.id);
    expect(plan.plates[0]).toMatchObject({ locked: true, jobIds: [dress.id, hat.id] });
    // The need keeps showing the units that are on jobs now: needed 6, on plates 4.
    expect(plan.needs.slice(0, 2).map((n) => [n.componentDescription, n.toProduce, n.planned])).toEqual([['dress', 6, 4], ['hat', 6, 2]]);
  });

  it('a plate is turned into jobs once; plates that are not sliced are left alone', async () => {
    const { x, o } = await setup();
    await sliced(x, o);
    const draft = await x.plates.createPlate(o.id, { kind: 'MIXED', printerId: HI, items: [{ rowKey: o.key('shoe'), units: 6 }] });
    expect((await x.jobs.createJobs(o.id, {})).jobsCreated).toBe(2);
    await expectStatus(x.jobs.createJobs(o.id, {}), 400, NOTHING_TO_CREATE);
    expect(jobsOf(x, o.id)).toHaveLength(2);
    expect(x.plate(draft.id).status).toBe('DRAFT');
  });

  it('a part the slicer left off the plate gets no job, and a warning says so', async () => {
    const { x, o } = await setup(40);
    const p = await sliced(x, o, [40, 40], [16, 0]);
    const res = await x.jobs.createJobs(o.id, {});
    expect(res.jobsCreated).toBe(1);
    expect(res.warnings).toEqual([{ code: 'PLATE_TOO_FULL', plateId: p.id, rowKey: o.key('hat'), message: 'Plate 1 · K1: no "hat" was placed, so no job was made for it' }]);
    expect(jobsOf(x, o.id)[0]).toMatchObject({ componentId: 'dress', quantityToProduce: 16 });
    expect(platesOfJob(x, jobsOf(x, o.id)[0].id)[0]).toMatchObject({ unitsPerPlate: 16, plateMinutes: 140, plateGrams: 28 });
  });

  it('a plate that holds more than the order needs: the job delivers what is needed, the rest is surplus; nothing needed is refused', async () => {
    const { x, o } = await setup(3);
    await sliced(x, o, [4, 2]);
    const res = await x.jobs.createJobs(o.id, {});
    expect(res.jobsCreated).toBe(2);
    const [dress, hat] = jobsOf(x, o.id);
    expect(dress).toMatchObject({ name: 'Doll — dress (×3) · Plate 1 · K1', quantityToProduce: 3 });
    expect(platesOfJob(x, dress.id)[0]).toMatchObject({ unitsPerPlate: 4, unitsRequired: 3 });
    expect(hat.quantityToProduce).toBe(2);

    // Another plate of dresses for an order whose dresses are all on a job.
    const extra = await x.plates.createPlate(o.id, { kind: 'MIXED', printerId: K1, items: [{ rowKey: o.key('dress'), units: 2 }] });
    await x.plates.queueOne(extra.id, {});
    x.ok(mixedGcode([2]), [2]);
    await x.processor.tick();
    await expectStatus(x.jobs.createJobs(o.id, {}), 400, 'Plate 2 · K1: the order needs no more "dress", so no job was made for it — take it off the plate or delete the plate');
    expect(jobsOf(x, o.id)).toHaveLength(2);
  });

  it('an existing file printed several times: the layout\'s own plate row, and no file name on the job', async () => {
    const { x, o } = await setup(25);
    const two = await x.plates.createPlate(o.id, { kind: 'LAYOUT', layoutId: 'stand10', plateCount: 2, items: [{ rowKey: o.key('stand'), units: 1 }] });
    const one = await x.plates.createPlate(o.id, { kind: 'LAYOUT', layoutId: 'stand10', printerId: HI, items: [{ rowKey: o.key('stand'), units: 1 }] });
    expect((await x.jobs.createJobs(o.id, {})).jobsCreated).toBe(2);
    const [a, b] = jobsOf(x, o.id);
    expect(a).toMatchObject({ orderPlateId: two.id, quantityToProduce: 20, printerId: K1, gcodeFilename: null, name: 'Doll — stand (×20) · Plate 1 · K1' });
    expect(platesOfJob(x, a.id)[0]).toMatchObject({ layoutId: 'stand10', unitsPerPlate: 10, plateCount: 2, unitsRequired: 20, plateMinutes: 100, plateGrams: 38, gcodeFilename: 'stand x10.gcode' });
    // 25 needed, 20 on the first job: the second plate delivers 5 of its 10.
    expect(b).toMatchObject({ orderPlateId: one.id, quantityToProduce: 5, printerId: HI, gcodeFilename: 'stand x10.gcode' });
    expect(platesOfJob(x, b.id)[0]).toMatchObject({ unitsPerPlate: 10, plateCount: 1, unitsRequired: 5 });
  });

  it('a project plate: a filament line per colour, with the grams its file reports', async () => {
    const { x, o } = await setup(4);
    const made = await x.plates.createPlate(o.id, { kind: 'PROJECT', items: [{ rowKey: o.key('face'), units: 4 }] });
    await x.plates.queueOne(made.id, {});
    x.ok(mixedGcode([4], { minutes: 90, grams: 17, toolGrams: [12, 5], name: (_k, n) => `face_id_${n}_copy_0` }));
    await x.processor.tick();
    await x.jobs.createJobs(o.id, {});
    const [job] = jobsOf(x, o.id);
    expect(job).toMatchObject({ componentId: 'face', printerId: HI, quantityToProduce: 4, orderPlateId: made.id });
    expect(platesOfJob(x, job.id)[0].slots).toEqual([
      expect.objectContaining({ colorIndex: 0, materialId: M.white, gramsPerPlate: 12 }),
      expect.objectContaining({ colorIndex: 1, materialId: M.orange, gramsPerPlate: 5 }),
    ]);
    expect(linesOf(x, job.id).map((l: any) => [l.materialId, l.gramsUsed, l.colorIndex])).toEqual([[M.white, 12, 0], [M.orange, 5, 1]]);
  });

  it('printed stock is allocated only for the rows these plates print', async () => {
    const { x, o } = await setup(6, (row) => {
      row.components.find((c: any) => c.id === 'dress').stockOnHand = 2;
      row.components.find((c: any) => c.id === 'shoe').stockOnHand = 6;
    });
    // Only hats are on the plate: neither the dresses' 2 nor the shoes' 6 are taken off the shelf.
    const hats = await x.plates.createPlate(o.id, { kind: 'MIXED', printerId: K1, items: [{ rowKey: o.key('hat'), units: 6 }] });
    await x.plates.queueOne(hats.id, {});
    x.ok(mixedGcode([6]), [6]);
    await x.processor.tick();
    expect((await x.jobs.createJobs(o.id, {})).jobsCreated).toBe(1);
    expect(x.db.t('componentStockMovement')).toEqual([]);
    expect([x.comp('dress').stockOnHand, x.comp('shoe').stockOnHand]).toEqual([2, 6]);
    // An order that stock covers has no plate to make jobs from: the sentence says where to go.
    await expectStatus(x.jobs.createJobs(o.id, {}), 400, 'If printed stock covers the whole order, use Plan Production instead');
    // A plate too many does not hold up the others: its part is left out with a warning.
    const extra = await x.plates.createPlate(o.id, { kind: 'MIXED', printerId: K1, items: [{ rowKey: o.key('hat'), units: 1 }, { rowKey: o.key('badge'), units: 2 }] });
    await x.plates.queueOne(extra.id, {});
    x.ok(mixedGcode([1, 2]), [1, 2]);
    await x.processor.tick();
    const res = await x.jobs.createJobs(o.id, {});
    expect(res.jobsCreated).toBe(1);
    expect(res.warnings).toEqual([expect.objectContaining({ code: 'OVER', plateId: extra.id, rowKey: o.key('hat') })]);
  });

  it('a row whose production-plan suggestion has a problem gets no allocation here (the rule of planWithSuggestions)', async () => {
    const { x, o } = await setup(6, (row) => {
      row.components.find((c: any) => c.id === 'dress').stockOnHand = 2;
    });
    await sliced(x, o, [4, 2]);
    const real = x.h.planning.computePlan.bind(x.h.planning);
    jest.spyOn(x.h.planning, 'computePlan').mockImplementation(async (id: string, opts?: any) => {
      const plan = await real(id, opts);
      plan.rows.find((r) => r.row.componentId === 'dress')!.problem = { code: 'NO_USABLE_LAYOUT', message: 'no sliced data' };
      return plan;
    });
    expect((await x.jobs.createJobs(o.id, {})).jobsCreated).toBe(2);
    expect(x.db.t('componentStockMovement')).toEqual([]);
    expect(x.comp('dress').stockOnHand).toBe(2);
  });

  it('an order line removed while a plate still holds it: that part is skipped with a warning, the rest gets its jobs', async () => {
    const { x, o } = await setup();
    const p = await sliced(x, o);
    p.items = [...p.items, { rowKey: 'gone-line:dress', orderItemId: 'gone-line', componentId: 'dress', units: 2, unitsSliced: 2, minutes: 10, grams: 2 }];
    const res = await x.jobs.createJobs(o.id, {});
    expect(res.jobsCreated).toBe(2);
    expect(res.warnings).toEqual([{
      code: 'BLOCKED', plateId: p.id, rowKey: 'gone-line:dress',
      message: 'Plate 1 · K1: a part on it is no longer in the order — take the part off the plate or delete the plate — no job was made for it',
    }]);
    expect(jobsOf(x, o.id).map((j: any) => j.componentId)).toEqual(['dress', 'hat']);
  });

  it('a one-slot project printed alone: its grams go to the part\'s only colour, whatever index the part gives it', async () => {
    const { x, o } = await setup(3, (row) => {
      const badge = row.components.find((c: any) => c.id === 'badge');
      // A single-colour part stored as one colour row at index 2 (as an import from a multi-slot printer leaves it).
      Object.assign(badge, { isMultiColor: false, materialId: null, material: null, materials: [{ colorIndex: 2, materialId: M.black, gramsUsed: 1.5, colourSlotId: null, colourFixed: true, material: { id: M.black, name: 'PLA Black', type: 'PLA', color: 'Black', colorHex: '#111111', brand: null, costPerGram: 0.01 } }] });
    });
    const made = await x.plates.createPlate(o.id, { kind: 'PROJECT', items: [{ rowKey: o.key('badge'), units: 3 }] });
    await x.plates.queueOne(made.id, {});
    x.ok(mixedGcode([3], { minutes: 30, grams: 5, toolGrams: [5], name: (_k, n) => `badge_id_${n}_copy_0` }));
    await x.processor.tick();
    expect(x.plate(made.id)).toMatchObject({ status: 'DONE', items: [expect.objectContaining({ slotGrams: { '0': 5 } })] });
    await x.jobs.createJobs(o.id, {});
    const [job] = jobsOf(x, o.id);
    expect(platesOfJob(x, job.id)[0].slots).toEqual([expect.objectContaining({ colorIndex: 2, materialId: M.black, gramsPerPlate: 5 })]);
    expect(linesOf(x, job.id)).toEqual([expect.objectContaining({ materialId: M.black, gramsUsed: 5 })]);
  });

  it('printed stock is allocated as the production plan suggests, once', async () => {
    const { x, o } = await setup(6, (row) => {
      row.components.find((c: any) => c.id === 'dress').stockOnHand = 2;
    });
    expect((await x.plates.getPlan(o.id)).needs[0]).toMatchObject({ componentDescription: 'dress', toProduce: 4 });
    await sliced(x, o, [4, 2]);
    await x.jobs.createJobs(o.id, {}, 'user-1');
    expect(x.comp('dress').stockOnHand).toBe(0);
    expect(x.db.t('componentStockMovement').filter((m: any) => m.reason === 'PLAN_ALLOCATE')).toEqual([
      expect.objectContaining({ componentId: 'dress', orderItemId: o.itemId, delta: -2 }),
    ]);
    // 2 from stock + 4 on a job: the dresses are covered, and a later call allocates nothing more.
    expect((await x.plates.getPlan(o.id)).needs[0]).toMatchObject({ toProduce: 4, planned: 4 });
    const hats = await x.plates.createPlate(o.id, { kind: 'MIXED', printerId: K1, items: [{ rowKey: o.key('hat'), units: 4 }] });
    await x.plates.queueOne(hats.id, {});
    x.ok(mixedGcode([4]), [4]);
    await x.processor.tick();
    expect((await x.jobs.createJobs(o.id, {})).jobsCreated).toBe(1);
    expect(x.db.t('componentStockMovement').filter((m: any) => m.reason === 'PLAN_ALLOCATE')).toHaveLength(1);
  });

  it('runs under the order\'s plan lock, refuses a body and an order that cannot be planned, and writes nothing when it refuses', async () => {
    const { x, o } = await setup();
    await sliced(x, o);
    await expectStatus(x.jobs.createJobs(o.id, { plateIds: ['x'] }), 400, 'plateIds should not exist');
    x.db.$queryRaw.mockClear();
    x.db.t('order').find((r: any) => r.id === o.id).status = 'CANCELLED';
    await expectStatus(x.jobs.createJobs(o.id, {}), 409, 'This order is cancelled');
    expect(x.db.$queryRaw.mock.calls[0][0].sql).toMatch(/plan:advisory/);
    expect(jobsOf(x, o.id)).toEqual([]);
    await expectStatus(x.jobs.createJobs('nope', {}), 404);
  });
});

describe('jobs of one plate are one print', () => {
  async function shared(quantity = 6) {
    const { x, o } = await setup(quantity);
    await sliced(x, o);
    await x.jobs.createJobs(o.id, {});
    const [dress, hat] = jobsOf(x, o.id);
    return { x, o, dress, hat };
  }

  it('the job page and the job list say what else is on the plate', async () => {
    const { x, dress, hat } = await shared();
    expect(await x.h.jobs.findOne(dress.id)).toMatchObject({ orderPlateId: dress.orderPlateId, sharedWith: [{ id: hat.id, name: hat.name }] });
    const list: any = await x.h.jobs.findAll({ page: 1, limit: 50 } as any);
    expect(list.data.map((j: any) => [j.id, j.sharedWith.map((s: any) => s.id)]).sort()).toEqual([[dress.id, [hat.id]], [hat.id, [dress.id]]].sort());
    hat.status = 'CANCELLED';
    expect((await x.h.jobs.findOne(dress.id)).sharedWith).toEqual([]);
    // A job that came from no plate shares nothing.
    const plain = x.db.insert('productionJob', { name: 'Test print', status: 'QUEUED', purpose: 'TEST', quantityToProduce: 1 });
    expect(await x.h.jobs.findOne(plain.id)).toMatchObject({ orderPlateId: null, sharedWith: [] });
  });

  it('starting one starts the others; another change is the job\'s own', async () => {
    const { x, dress, hat } = await shared();
    await x.siblings.update(dress.id, { printerId: HI });
    expect(hat.printerId).toBe(K1);
    const res: any = await x.siblings.update(dress.id, { status: 'IN_PROGRESS' });
    expect(res.status).toBe('IN_PROGRESS');
    expect(res.warnings).toBeUndefined();
    expect([dress.status, hat.status]).toEqual(['IN_PROGRESS', 'IN_PROGRESS']);
    expect(hat.startedAt).toBeInstanceOf(Date);
    await x.siblings.update(dress.id, { status: 'PAUSED' });
    expect([dress.status, hat.status]).toEqual(['PAUSED', 'IN_PROGRESS']);
  });

  it('completing one completes the others that were in the same status: each takes its own share of the filament', async () => {
    const { x, dress, hat } = await shared();
    await x.siblings.update(dress.id, { status: 'IN_PROGRESS' });
    const res: any = await x.siblings.complete(dress.id, 'user-1');
    expect(res).toMatchObject({ id: dress.id, status: 'COMPLETED', warnings: [] });
    expect([dress.status, hat.status]).toEqual(['COMPLETED', 'COMPLETED']);
    expect(x.db.t('spool').find((s: any) => s.id === `sp-${M.black}`).currentWeight).toBe(5000 - 24 - 4);
  });

  it('the plate came off the printer: completing or failing one takes every sibling that is still open, whatever its status', async () => {
    const a = await shared();
    await a.x.siblings.update(a.dress.id, { status: 'IN_PROGRESS' });
    await a.x.h.jobs.update(a.hat.id, { status: 'PAUSED' });
    expect(await a.x.siblings.complete(a.dress.id)).toMatchObject({ status: 'COMPLETED', warnings: [] });
    expect(a.hat.status).toBe('COMPLETED');

    // Started by a bridge that knew only one of them: the other is still QUEUED.
    const b = await shared();
    b.dress.status = 'IN_PROGRESS';
    await b.x.siblings.fail(b.dress.id, { failureReason: 'Came loose' });
    expect([b.dress.status, b.hat.status]).toEqual(['FAILED', 'FAILED']);
  });

  it('a sibling that is already there (a bridge was quicker) is fine: no warning, and it is not done twice', async () => {
    const { x, dress, hat } = await shared();
    const real = x.h.jobs.completeJob.bind(x.h.jobs);
    jest.spyOn(x.h.jobs, 'completeJob').mockImplementation(async (id: string, user?: string | null) => {
      // The bridge completes the hat between the read of the siblings and their turn.
      if (id === hat.id) await real(hat.id, user);
      return real(id, user);
    });
    const res: any = await x.siblings.complete(dress.id);
    expect(res).toMatchObject({ status: 'COMPLETED', warnings: [] });
    expect(hat.status).toBe('COMPLETED');
    expect(x.db.t('spool').find((s: any) => s.id === `sp-${M.black}`).currentWeight).toBe(5000 - 24 - 4);
    // A sibling finished earlier is not touched at all.
    const again = await shared();
    again.hat.status = 'COMPLETED';
    expect(await again.x.siblings.complete(again.dress.id)).toMatchObject({ warnings: [] });
  });

  it('a reprint stays on the plate: it prints with the others and keeps the plate locked', async () => {
    const { x, o, dress, hat } = await shared();
    await x.siblings.fail(dress.id, {});
    // Every job failed: the plate is free again (it can be changed, sliced again, or turned into jobs once more).
    const free = (await x.plates.getPlan(o.id)).plates[0];
    expect(free).toMatchObject({ locked: false, jobIds: [] });
    const reprint: any = await x.h.jobs.reprintJob(dress.id);
    expect(reprint).toMatchObject({ orderPlateId: dress.orderPlateId, reprintOfId: dress.id, status: 'QUEUED' });
    expect((await x.plates.getPlan(o.id)).plates[0]).toMatchObject({ locked: true, jobIds: [reprint.id] });
    await expectStatus(x.plates.deletePlate(dress.orderPlateId), 409);
    const hatAgain: any = await x.h.jobs.reprintJob(hat.id);
    expect((await x.h.jobs.findOne(reprint.id)).sharedWith.map((s: any) => s.id).sort()).toEqual([dress.id, hat.id, hatAgain.id].sort());
    await x.siblings.update(reprint.id, { status: 'IN_PROGRESS' });
    expect(hatAgain.id && x.db.t('productionJob').find((j: any) => j.id === hatAgain.id).status).toBe('IN_PROGRESS');
  });

  it('the order page and the printer queue name the shared plate too', async () => {
    const { x, o, dress, hat } = await shared();
    const pricing = new PricingService(x.db as any, x.h.resolver, { loadSettings: jest.fn(async () => ({ ...SETTINGS })) } as any);
    const orders = new OrdersService(x.db as any, pricing, x.h.resolver, x.h.planner, x.h.stock, undefined, undefined, undefined, undefined as any, undefined);
    const order: any = await orders.findOne(o.id);
    expect(order.productionJobs.map((j: any) => [j.id, j.orderPlateId, j.sharedWith]).sort()).toEqual([
      [dress.id, dress.orderPlateId, [{ id: hat.id, name: hat.name }]],
      [hat.id, hat.orderPlateId, [{ id: dress.id, name: dress.name }]],
    ].sort());

    const loose = x.db.insert('productionJob', { name: 'Loose', status: 'QUEUED', printerId: null, quantityToProduce: 1, colorChanges: 0, orderPlateId: null });
    const queue: any = await new JobSchedulingService(x.db as any).getQueue();
    const onK1 = queue.printers.find((p: any) => p.id === K1).productionJobs;
    expect(onK1.map((j: any) => [j.id, j.sharedWith.map((s: any) => s.id)]).sort()).toEqual([[dress.id, [hat.id]], [hat.id, [dress.id]]].sort());
    expect(queue.unassigned).toEqual([expect.objectContaining({ id: loose.id, sharedWith: [] })]);
  });

  it('a sibling that cannot follow never undoes the first job: it is a warning', async () => {
    const { x, dress, hat } = await shared();
    const real = x.h.jobs.completeJob.bind(x.h.jobs);
    jest.spyOn(x.h.jobs, 'completeJob').mockImplementation(async (id: string, user?: string | null) => {
      if (id === hat.id) throw new Error('Printed stock changed');
      return real(id, user);
    });
    const res: any = await x.siblings.complete(dress.id);
    expect(res.status).toBe('COMPLETED');
    expect(dress.status).toBe('COMPLETED');
    expect(hat.status).toBe('QUEUED');
    expect(res.warnings).toEqual([{ code: 'SIBLING_JOB', message: `"${hat.name}" is on the same plate but could not be completed: Printed stock changed — open it and do it by hand` }]);
  });

  it('failing one fails the others; the wasted grams are the plate\'s, shared out by the jobs\' planned grams', async () => {
    const { x, dress, hat } = await shared();
    const res: any = await x.siblings.fail(dress.id, { failureReason: 'Spaghetti', wasteGrams: 14 });
    expect(res).toMatchObject({ id: dress.id, status: 'FAILED', wasteGrams: 12 });
    expect(hat).toMatchObject({ status: 'FAILED', failureReason: 'Spaghetti', wasteGrams: 2 });
    // 14 g off the spool once, not once per job.
    expect(x.db.t('spool').find((s: any) => s.id === `sp-${M.black}`).currentWeight).toBe(5000 - 14);
    await expectStatus(x.siblings.fail(dress.id, { wasteGrams: -1 }), 400);
  });

  it('a job that shares no plate goes through as before', async () => {
    const { x, dress, hat } = await shared();
    hat.orderPlateId = null;
    dress.orderPlateId = null;
    await x.siblings.update(dress.id, { status: 'IN_PROGRESS' });
    expect(hat.status).toBe('QUEUED');
    await x.siblings.fail(dress.id, { wasteGrams: 5 });
    expect([dress.status, dress.wasteGrams, hat.status]).toEqual(['FAILED', 5, 'QUEUED']);
    await expectStatus(x.siblings.complete('nope'), 404);
  });
});
