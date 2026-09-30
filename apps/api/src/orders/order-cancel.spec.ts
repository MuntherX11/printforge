import { BOX_ID, boxRow } from '../catalog-core/__fixtures__/box-product';
import { M, key } from '../catalog-core/__fixtures__/sardine-tin';
import { MoonrakerService } from '../moonraker-bridge/moonraker.service';
import { addJobRow, addOrder, addSpool, expectStatus } from '../production/__fixtures__/production-harness';
import { CUSTOMER_ID, ordersHarness, type OrdersHarness } from './__fixtures__/orders-harness';
import { OrdersController } from './orders.controller';

/** v2.17.2 (C): cancelling an order (S9) also cancels its QUEUED production jobs. */

type H = OrdersHarness;

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));
const statusOf = (h: H, id: string) => h.db.t('productionJob').find((j: any) => j.id === id).status;
const orderRow = (h: H, id: string) => h.db.t('order').find((o: any) => o.id === id);
const boxStock = (h: H) => h.db.t('productComponent').find((c: any) => c.id === 'box').stockOnHand;
const lists = (o: any) => ({ stockReleased: o.stockReleased, jobsCancelled: o.jobsCancelled, jobsStillRunning: o.jobsStillRunning });
const EMPTY = { stockReleased: [], jobsCancelled: [], jobsStillRunning: [] };

function box() {
  const h = ordersHarness([boxRow()]);
  addSpool(h.db, M.black, 5000, { id: 'sp-black' });
  return h;
}

const allocate = (h: H, orderItemId: string, units: number) =>
  h.db.insert('componentStockMovement', { componentId: 'box', colourKey: key([0, M.black]), baseColumn: true, delta: -units, balanceAfter: 0, reason: 'PLAN_ALLOCATE', orderItemId });

/** A CONFIRMED Box order: 2 QUEUED jobs (one on pr-1), 1 IN_PROGRESS, 1 PAUSED, 1 COMPLETED, 1 old CANCELLED; −2 Box allocated. */
function cancellable(h: H) {
  const { order, items: [it] } = addOrder(h.db, [{ productId: BOX_ID, quantity: 3, description: 'Box' }], 'CONFIRMED');
  const mk = (status: string, name: string, s: number, extra: Record<string, unknown> = {}) =>
    addJobRow(h.db, { orderId: order.id, orderItemId: it.id, productId: BOX_ID, componentId: 'box', status, name, createdAt: at(s), ...extra });
  const jobs = {
    q1: mk('QUEUED', 'Box q1', 1, { printerId: 'pr-1' }),
    q2: mk('QUEUED', 'Box q2', 2),
    printing: mk('IN_PROGRESS', 'Box printing', 3, { printerId: 'pr-1' }),
    paused: mk('PAUSED', 'Box paused', 4),
    done: mk('COMPLETED', 'Box done', 5),
    old: mk('CANCELLED', 'Box old', 0),
  };
  allocate(h, it.id, 2);
  return { order, it, jobs };
}

const statuses = (h: H, jobs: Record<string, { id: string }>) => Object.fromEntries(Object.entries(jobs).map(([k, j]) => [k, statusOf(h, j.id)]));
const BEFORE = { q1: 'QUEUED', q2: 'QUEUED', printing: 'IN_PROGRESS', paused: 'PAUSED', done: 'COMPLETED', old: 'CANCELLED' };

describe('S9 cancel also cancels the order\'s QUEUED jobs (v2.17.2)', () => {
  it('cancels the QUEUED jobs, lists the started ones, releases printed stock as in v2.17.1', async () => {
    const h = box();
    const { order, jobs } = cancellable(h);
    const out: any = await h.orders.update(order.id, { status: 'CANCELLED' });
    expect(out.status).toBe('CANCELLED');
    expect(out.jobsCancelled).toEqual([{ id: jobs.q1.id, name: 'Box q1', printerName: 'K1' }, { id: jobs.q2.id, name: 'Box q2', printerName: null }]);
    expect(out.jobsStillRunning).toEqual([
      { id: jobs.printing.id, name: 'Box printing', status: 'IN_PROGRESS', printerName: 'K1' },
      { id: jobs.paused.id, name: 'Box paused', status: 'PAUSED', printerName: null },
    ]);
    expect(out.stockReleased).toEqual([{ componentDescription: 'Box', colourLabel: 'PLA Black', units: 2 }]);
    expect(statuses(h, jobs)).toEqual({ ...BEFORE, q1: 'CANCELLED', q2: 'CANCELLED' });
    expect(boxStock(h)).toBe(2);
  });

  it('the cancelled jobs stop reserving filament (per spool and per material); the running one still does', async () => {
    const h = box();
    const { order, items: [custom] } = addOrder(h.db, [{ description: 'Custom stand', quantity: 2 }], 'CONFIRMED');
    for (const [status, grams] of [['QUEUED', 100], ['QUEUED', 20], ['IN_PROGRESS', 5]] as const) {
      const j = addJobRow(h.db, { orderId: order.id, orderItemId: custom.id, status, name: status });
      h.db.insert('jobMaterial', { jobId: j.id, materialId: M.black, spoolId: 'sp-black', gramsUsed: grams, colorIndex: 0, costPerGram: 0.01 });
    }
    const reserved = async () => ({
      spool: (await h.planner.reservedBySpool()).get('sp-black'),
      material: (await h.planner.freeFilament([M.black])).materials.get(M.black)?.reserved,
    });
    expect(await reserved()).toEqual({ spool: 125, material: 125 });
    await h.orders.update(order.id, { status: 'CANCELLED' });
    expect(await reserved()).toEqual({ spool: 5, material: 5 });
  });

  it.each([
    ['the stock release', (h: H) => jest.spyOn(h.stock, 'releaseForOrder').mockRejectedValueOnce(new Error('db down'))],
    ['the audit insert', (h: H) => jest.spyOn(h.db.auditLog, 'createMany').mockRejectedValueOnce(new Error('db down'))],
  ])('%s failing rolls the order, the jobs, the stock and the audit rows back together', async (_what, fail) => {
    const h = box();
    const { order, jobs } = cancellable(h);
    fail(h);
    await expect(h.orders.update(order.id, { status: 'CANCELLED' }, 'user-1')).rejects.toThrow('db down');
    expect(orderRow(h, order.id).status).toBe('CONFIRMED');
    expect(statuses(h, jobs)).toEqual(BEFORE);
    expect(boxStock(h)).toBe(0);
    expect(h.db.t('componentStockMovement').filter((m: any) => m.reason === 'PLAN_RELEASE')).toEqual([]);
    expect(h.db.t('auditLog')).toEqual([]);
  });

  it('a repeat cancel, a non-cancel update and a repeat cancel with notes → empty lists; only the notes are saved', async () => {
    const h = box();
    const { order } = cancellable(h);
    await h.orders.update(order.id, { status: 'CANCELLED' });
    const flip = jest.spyOn(h.db.order, 'updateMany');
    expect(lists(await h.orders.update(order.id, { status: 'CANCELLED' }))).toEqual(EMPTY);
    expect(flip).toHaveBeenCalledTimes(1); // the guarded flip, matching nothing; no notes to save
    expect(lists(await h.orders.update(order.id, { notes: 'call first' }))).toEqual(EMPTY);
    const again: any = await h.orders.update(order.id, { status: 'CANCELLED', notes: 'x' });
    expect(lists(again)).toEqual(EMPTY);
    expect([again.notes, orderRow(h, order.id).notes, orderRow(h, order.id).status]).toEqual(['x', 'x', 'CANCELLED']);
    const { order: other } = addOrder(h.db, [{ description: 'Custom', quantity: 1 }], 'CONFIRMED');
    expect(lists(await h.orders.update(other.id, { status: 'READY' }))).toEqual(EMPTY);
  });

  it('a cancel racing a re-open decides under the plan lock: the re-planned job is cancelled and its stock released', async () => {
    const h = box();
    const { order, items: [it] } = addOrder(h.db, [{ productId: BOX_ID, quantity: 3, description: 'Box' }], 'CANCELLED');
    const inner = h.db.$queryRaw;
    let replanned: any = null;
    h.db.$queryRaw = jest.fn(async (q: any) => {
      if (!replanned && /plan:advisory/.test(q.sql)) {
        // Committed while this request waited for the lock: re-opened, then J5 queued a job and took 2 Box.
        orderRow(h, order.id).status = 'CONFIRMED';
        replanned = addJobRow(h.db, { orderId: order.id, orderItemId: it.id, productId: BOX_ID, componentId: 'box', status: 'QUEUED', name: 'Box replanned' });
        allocate(h, it.id, 2);
      }
      return inner(q);
    });
    const out: any = await h.orders.update(order.id, { status: 'CANCELLED' });
    expect(out.jobsCancelled).toEqual([{ id: replanned.id, name: 'Box replanned', printerName: null }]);
    expect(out.stockReleased).toEqual([{ componentDescription: 'Box', colourLabel: 'PLA Black', units: 2 }]);
    expect([orderRow(h, order.id).status, statusOf(h, replanned.id), boxStock(h)]).toEqual(['CANCELLED', 'CANCELLED', 2]);
  });

  it('lock order: plan lock < order flip < every line FOR UPDATE in id order < job rows FOR UPDATE < job update < first stock-movement read', async () => {
    const h = box();
    const { order } = addOrder(h.db, [
      { id: 'line-b', productId: BOX_ID, quantity: 3, description: 'Box' },
      { id: 'line-a', productId: BOX_ID, quantity: 1, description: 'Box' },
    ], 'CONFIRMED');
    addJobRow(h.db, { orderId: order.id, orderItemId: 'line-b', status: 'QUEUED', name: 'q' });
    const flip = jest.spyOn(h.db.order, 'updateMany');
    const jobFlip = jest.spyOn(h.db.productionJob, 'updateMany');
    const movements = jest.spyOn(h.db.componentStockMovement, 'findMany');
    await h.orders.update(order.id, { status: 'CANCELLED' });
    const raw = h.db.$queryRaw.mock;
    const calls = raw.calls.map(([q]: any) => q);
    const where = (re: RegExp) => calls.map((q: any, i: number) => (re.test(q.sql) ? i : -1)).filter((i: number) => i >= 0);
    const [plan] = where(/plan:advisory/);
    const lines = where(/stock:lockLine/);
    const [jobLock] = where(/lock:ProductionJob:UPDATE/);
    expect(calls[plan].values).toEqual([`plan:${order.id}`]);
    expect(lines.slice(0, 2).map((i: number) => calls[i].values[0])).toEqual(['line-a', 'line-b']);
    const seq = [
      raw.invocationCallOrder[plan], flip.mock.invocationCallOrder[0], raw.invocationCallOrder[lines[0]], raw.invocationCallOrder[lines[1]],
      raw.invocationCallOrder[jobLock], jobFlip.mock.invocationCallOrder[0], movements.mock.invocationCallOrder[0],
    ];
    expect([...seq].sort((a, b) => a - b)).toEqual(seq);
  });

  it('attributes the release to the user and writes one Job.cancelled audit row per cancelled job (none for running jobs)', async () => {
    const h = box();
    const { order, jobs } = cancellable(h);
    await new OrdersController(h.orders).update(order.id, { status: 'CANCELLED' }, { user: { id: 'user-1' } });
    expect(h.db.t('componentStockMovement').filter((m: any) => m.reason === 'PLAN_RELEASE').map((m: any) => m.userId)).toEqual(['user-1']);
    const details = { via: 'ORDER_CANCELLED', orderId: order.id };
    expect(h.db.t('auditLog').map(({ userId, action, entityType, entityId, details: d }: any) => ({ userId, action, entityType, entityId, details: d }))).toEqual([
      { userId: 'user-1', action: 'Job.cancelled', entityType: 'Job', entityId: jobs.q1.id, details },
      { userId: 'user-1', action: 'Job.cancelled', entityType: 'Job', entityId: jobs.q2.id, details },
    ]);
  });

  it('a queued job J8 cancels while S9 waits for the job row locks is neither reported nor audited as this cancel\'s', async () => {
    const h = box();
    const { order, jobs } = cancellable(h);
    const inner = h.db.$queryRaw;
    h.db.$queryRaw = jest.fn(async (q: any) => {
      // Committed first: q1 cancelled on its own job page (J8).
      if (/lock:ProductionJob:UPDATE/.test(q.sql)) h.db.t('productionJob').find((j: any) => j.id === jobs.q1.id).status = 'CANCELLED';
      return inner(q);
    });
    const out: any = await new OrdersController(h.orders).update(order.id, { status: 'CANCELLED' }, { user: { id: 'user-1' } });
    expect(out.jobsCancelled).toEqual([{ id: jobs.q2.id, name: 'Box q2', printerName: null }]);
    expect(h.db.t('auditLog').map((a: any) => a.entityId)).toEqual([jobs.q2.id]);
    expect(statuses(h, jobs)).toEqual({ ...BEFORE, q1: 'CANCELLED', q2: 'CANCELLED' });
  });

  it('without a user: the jobs are still cancelled, no audit rows', async () => {
    const h = box();
    const { order, jobs } = cancellable(h);
    await h.orders.update(order.id, { status: 'CANCELLED' });
    expect(statusOf(h, jobs.q1.id)).toBe('CANCELLED');
    expect(h.db.t('auditLog')).toEqual([]);
    expect(h.db.t('componentStockMovement').filter((m: any) => m.reason === 'PLAN_RELEASE').map((m: any) => m.userId)).toEqual([null]);
  });

  it('after the cancel, bridge start and complete events for the cancelled job change nothing', async () => {
    const h = box();
    const { order, items: [it] } = addOrder(h.db, [{ productId: BOX_ID, quantity: 12, description: 'Box' }], 'CONFIRMED');
    const job: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 12, orderId: order.id, orderItemId: it.id });
    expect([job.gcodeFilename, job.printerId]).toEqual(['Box x12.gcode', 'pr-1']);
    await h.orders.update(order.id, { status: 'CANCELLED' });
    const moves = h.db.t('componentStockMovement').length;
    const notifications = { create: jest.fn(async () => ({})) };
    const moonraker = new MoonrakerService(h.db as any, notifications as any, h.completion);
    const snap = (state: string) => ({
      hostname: 'k1', printerState: state, progress: 1, heaterBed: null, extruder: null,
      printStats: { filename: 'Box x12.gcode', total_duration: 3600, print_duration: 3600, filament_used: 0, state, message: '' },
    });
    await moonraker.handleJobStarted('pr-1', snap('printing') as any);
    await moonraker.handleJobCompleted('pr-1', snap('complete') as any);
    expect(statusOf(h, job.id)).toBe('CANCELLED');
    expect(h.db.t('spool').find((s: any) => s.id === 'sp-black').currentWeight).toBe(5000);
    expect(h.db.t('componentStockMovement')).toHaveLength(moves);
    expect(notifications.create).not.toHaveBeenCalled();
    expect(await h.completion.complete(job.id, { source: 'MOONRAKER' })).toBeNull();
    await expectStatus(h.completion.complete(job.id, { source: 'MANUAL' }), 409);
  });

  it('a cancel while the Plan dialog is open still makes J5 return 409', async () => {
    const h = box();
    const { order } = addOrder(h.db, [{ productId: BOX_ID, quantity: 5, description: 'Box' }], 'CONFIRMED');
    const plan: any = await h.planning.previewPlan(order.id);
    await h.orders.update(order.id, { status: 'CANCELLED' });
    await expectStatus(h.planning.createFromPlan(order.id, { planVersion: plan.planVersion }), 409, 'This order is cancelled');
    expect(h.db.t('productionJob')).toHaveLength(0);
  });
});

describe('quote conversion placeholders check the order under its plan lock (v2.17.2)', () => {
  function customQuote(h: H) {
    const q = h.db.insert('quote', {
      quoteNumber: 'Q-0001', customerId: CUSTOMER_ID, status: 'SENT', validUntil: null, notes: null, subtotal: 10, tax: 0, total: 10,
      gcodeMetadata: null, stlMetadata: null, source: 'MANUAL',
    });
    h.db.insert('quoteItem', {
      quoteId: q.id, productId: null, sizeOptionId: null, colourOptionId: null, description: 'Custom stand', quantity: 2, unitPrice: 5, totalPrice: 10,
      listUnitPrice: null, priceSource: 'MANUAL', tierMinQty: null, priceOverrideReason: null, estimatedCost: null, marginPercent: null,
    });
    return q;
  }

  it('an order cancelled before the plan lock is taken gets no placeholders; jobsCreated counts 0', async () => {
    const h = box();
    const q = customQuote(h);
    const inner = h.db.$queryRaw;
    let fired = false;
    h.db.$queryRaw = jest.fn(async (sql: any) => {
      if (!fired && /plan:advisory/.test(sql.sql)) {
        fired = true;
        orderRow(h, String(sql.values[0]).slice('plan:'.length)).status = 'CANCELLED';
      }
      return inner(sql);
    });
    const out: any = await h.quotes.convertToOrder(q.id, {});
    expect(fired).toBe(true);
    expect(out.planning.jobsCreated).toBe(0);
    expect(h.db.t('productionJob')).toHaveLength(0);
  });

  it('otherwise the placeholders are created as before', async () => {
    const h = box();
    const out: any = await h.quotes.convertToOrder(customQuote(h).id, {});
    expect(out.planning.jobsCreated).toBe(2);
    expect(h.db.t('productionJob').map((j: any) => [j.name, j.status, j.orderId])).toEqual([
      ['Custom stand (1/2)', 'QUEUED', out.id],
      ['Custom stand (2/2)', 'QUEUED', out.id],
    ]);
  });
});
