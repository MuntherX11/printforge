import { BOX_ID, boxRow } from '../catalog-core/__fixtures__/box-product';
import { fixtureMaterial, M } from '../catalog-core/__fixtures__/sardine-tin';
import { CrealityWsService } from '../moonraker-bridge/creality-ws.service';
import { MoonrakerService } from '../moonraker-bridge/moonraker.service';
import { cancelledOrderNote, cancelledOrderWarning, ORDER_CANCELLED_UNITS } from '../stock-ledger/job-completion.service';
import { ORDER_CANCELLED_NO_NEW_JOBS, ORDER_CANCELLED_NO_REQUEUE } from './job-transitions';
import { JobsService } from './jobs.service';
import { addJobRow, addOrder, addSpool, expectStatus, productionHarness, type ProductionHarness } from './__fixtures__/production-harness';

/**
 * v2.17.2 (C): a CANCELLED order never gains a QUEUED job (J1, J7, J8), its
 * customer never hears "order completed", and a job of it that still finishes
 * says which units were not stocked.
 */

type H = ProductionHarness;
const RED = 'v-box-red';

const jobRow = (h: H, id: string) => h.db.t('productionJob').find((j: any) => j.id === id);
const orderRow = (h: H, id: string) => h.db.t('order').find((o: any) => o.id === id);

function box() {
  const h = productionHarness([boxRow({ withRed: true })]);
  h.db.insert('material', fixtureMaterial(M.red));
  for (const m of [M.black, M.red]) addSpool(h.db, m, 5000, { id: `sp-${m}` });
  return h;
}

/** A Box order (one line of `quantity`) and a J1 job of `quantity` boxes for it, made while the order was CONFIRMED. */
async function orderWithJob(h: H, quantity = 12) {
  const { order, items: [line] } = addOrder(h.db, [{ productId: BOX_ID, quantity, description: 'Box' }], 'CONFIRMED');
  const job: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: quantity, orderId: order.id, orderItemId: line.id });
  return { order, line, job };
}

const cancel = (h: H, orderId: string) => { orderRow(h, orderId).status = 'CANCELLED'; };

describe('J1 / J7 / J8 on a cancelled order', () => {
  it('J1 → 409, nothing created; a CONFIRMED order still works and takes plan:<orderId> before the option locks', async () => {
    const h = box();
    const { order, items: [line] } = addOrder(h.db, [{ productId: BOX_ID, colourOptionId: RED, quantity: 12, description: 'Box — Red' }], 'CONFIRMED');
    const body = { productId: BOX_ID, colourOptionId: RED, quantityToProduce: 12, orderId: order.id, orderItemId: line.id };

    const made: any = await h.jobs.create(body);
    const calls = h.db.$queryRaw.mock.calls.map(([q]: any) => q.sql as string);
    const plan = calls.findIndex((s: string) => /plan:advisory/.test(s));
    expect(h.db.$queryRaw.mock.calls[plan][0].values).toEqual([`plan:${order.id}`]);
    expect(plan).toBeLessThan(calls.findIndex((s: string) => /lock:ProductVariant/.test(s)));
    expect(jobRow(h, made.id).status).toBe('QUEUED');

    cancel(h, order.id);
    await expectStatus(h.jobs.create(body), 409, ORDER_CANCELLED_NO_NEW_JOBS);
    expect(h.db.t('productionJob')).toHaveLength(1);
    expect(h.db.t('jobMaterial').filter((m: any) => m.jobId !== made.id)).toEqual([]);
  });

  it('J7 reprint of a FAILED job of a cancelled order → 409, nothing created', async () => {
    const h = box();
    const { order, job } = await orderWithJob(h);
    await h.jobs.failJob(job.id, { failureReason: 'spaghetti' });
    cancel(h, order.id);
    await expectStatus(h.jobs.reprintJob(job.id), 409, ORDER_CANCELLED_NO_NEW_JOBS);
    expect(h.db.t('productionJob')).toHaveLength(1);
  });

  it.each(['IN_PROGRESS', 'PAUSED'])('J8 back to QUEUED for a %s job of a cancelled order → 409, status unchanged', async (status) => {
    const h = box();
    const { order, job } = await orderWithJob(h);
    jobRow(h, job.id).status = status;
    cancel(h, order.id);
    await expectStatus(h.jobs.update(job.id, { status: 'QUEUED' }), 409, ORDER_CANCELLED_NO_REQUEUE);
    expect(jobRow(h, job.id).status).toBe(status);
  });

  it('J8 CANCELLED and resume still work on a cancelled order; QUEUED still works on a CONFIRMED one', async () => {
    const h = box();
    const a = await orderWithJob(h);
    const b = await orderWithJob(h);
    jobRow(h, a.job.id).status = 'PAUSED';
    jobRow(h, b.job.id).status = 'IN_PROGRESS';
    cancel(h, a.order.id);
    cancel(h, b.order.id);
    await h.jobs.update(a.job.id, { status: 'IN_PROGRESS' });
    await h.jobs.update(b.job.id, { status: 'CANCELLED' });
    expect([jobRow(h, a.job.id).status, jobRow(h, b.job.id).status]).toEqual(['IN_PROGRESS', 'CANCELLED']);

    const c = await orderWithJob(h);
    jobRow(h, c.job.id).status = 'PAUSED';
    await h.jobs.update(c.job.id, { status: 'QUEUED' });
    expect(jobRow(h, c.job.id).status).toBe('QUEUED');
  });
});

describe('J6 on a cancelled order', () => {
  function withNotifications(h: H) {
    h.db.insert('customer', { id: 'cust-1', name: 'Ali', email: 'ali@example.com', phone: '+96890000000' });
    const email = { notifyCustomerOrderCompleted: jest.fn(async () => undefined) };
    const whatsapp = { sendOrderCompleted: jest.fn(async () => undefined) };
    const settings = { get: jest.fn(async (_k: string, fallback: string) => fallback) };
    const jobs = new JobsService(
      h.db as any, h.costing, h.gateway, h.planning, {} as any, h.completion, h.resolver, h.planner, email as any, whatsapp as any, settings as any,
    );
    return { jobs, email, whatsapp };
  }

  it('completing the last running job of a cancelled order does not tell the customer the order is complete', async () => {
    const h = box();
    const { jobs, email, whatsapp } = withNotifications(h);
    const { order, job } = await orderWithJob(h);
    orderRow(h, order.id).customerId = 'cust-1';
    await h.jobs.update(job.id, { status: 'IN_PROGRESS' });
    cancel(h, order.id);
    await jobs.completeJob(job.id);
    expect(jobRow(h, job.id).status).toBe('COMPLETED');
    expect(email.notifyCustomerOrderCompleted).not.toHaveBeenCalled();
    expect(whatsapp.sendOrderCompleted).not.toHaveBeenCalled();
  });

  it('a non-cancelled order whose jobs are all terminal notifies once per channel', async () => {
    const h = box();
    const { jobs, email, whatsapp } = withNotifications(h);
    const { order, job } = await orderWithJob(h);
    orderRow(h, order.id).customerId = 'cust-1';
    await jobs.completeJob(job.id);
    expect(email.notifyCustomerOrderCompleted).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendOrderCompleted).toHaveBeenCalledTimes(1);
  });

  it('a CUSTOMER job of a cancelled order warns about the R units not stocked; the credit stays surplus-only', async () => {
    const h = box();
    const { order, job } = await orderWithJob(h);
    await h.jobs.update(job.id, { status: 'IN_PROGRESS' });
    cancel(h, order.id);
    const done: any = await h.jobs.completeJob(job.id);
    expect(done.stockCredits).toEqual([]);
    expect(done.warnings).toEqual([{
      code: ORDER_CANCELLED_UNITS,
      message: `Order ${order.orderNumber} was cancelled — the 12 units this job printed for it were not added to printed stock. Add them by hand if you keep them`,
    }]);
    expect(h.db.t('productComponent')[0].stockOnHand).toBe(0);
  });

  it('KEEP_FOR_STOCK with U = 14 for R = 12 → +2 surplus credited, and the warning for 12', async () => {
    const h = box();
    const { order, job } = await orderWithJob(h);
    const plate = h.db.t('jobPlate').find((p: any) => p.jobId === job.id);
    Object.assign(plate, { unitsPerPlate: 14 });
    cancel(h, order.id);
    const done: any = await h.jobs.completeJob(job.id);
    expect(done.stockCredits.map((c: any) => c.delta)).toEqual([2]);
    expect(done.warnings.map((w: any) => [w.code, /the 12 units/.test(w.message)])).toEqual([[ORDER_CANCELLED_UNITS, true]]);
  });

  it('no such warning for a non-cancelled order or a TEST job', async () => {
    const h = box();
    const { job } = await orderWithJob(h);
    expect((await h.jobs.completeJob(job.id) as any).warnings).toEqual([]);
    const { order } = await orderWithJob(h);
    cancel(h, order.id);
    const test = addJobRow(h.db, { orderId: order.id, purpose: 'TEST', componentId: 'box', productId: BOX_ID, quantityToProduce: 5, status: 'IN_PROGRESS' });
    expect((await h.jobs.completeJob(test.id) as any).warnings).toEqual([]);
  });

  it('cancelledOrderWarning: R per component from its first plate; a job without plates counts its component quantity; 1 unit reads singular', () => {
    const order = { status: 'CANCELLED', orderNumber: 'ORD-9' };
    const plates = [
      { componentId: 'a', unitsRequired: 10 }, { componentId: 'a', unitsRequired: 10 }, { componentId: 'b', unitsRequired: 3 }, { componentId: null, unitsRequired: 7 },
    ];
    const base = { purpose: 'CUSTOMER', componentId: null, quantityToProduce: 99, order, plates };
    expect(cancelledOrderWarning(base)?.message).toContain('the 13 units');
    expect(cancelledOrderWarning({ ...base, plates: [], componentId: 'a', quantityToProduce: 1 })?.message)
      .toBe('Order ORD-9 was cancelled — the 1 unit this job printed for it was not added to printed stock. Add it by hand if you keep it');
    expect(cancelledOrderWarning({ ...base, plates: [] })).toBeNull(); // placeholder / whole-product legacy job
    expect(cancelledOrderWarning({ ...base, order: { ...order, status: 'CONFIRMED' } })).toBeNull();
    expect(cancelledOrderWarning({ ...base, order: null })).toBeNull();
    expect(cancelledOrderNote([{ code: 'OTHER', message: 'x' }])).toBe('');
  });
});

describe('bridge notification for a job of a cancelled order', () => {
  const moonSnap = { hostname: 'k1', printerState: 'ready', progress: 1, heaterBed: null, extruder: null, printStats: { filename: 'Box x12.gcode', total_duration: 3600, print_duration: 3600, filament_used: 0, state: 'complete', message: '' } };
  const crealitySnap = { printerId: 'pr-1', printerName: 'K1', state: 'idle', progress: 100, fileName: 'Box x12.gcode', printLeftTime: 0, printJobTime: 3600, nozzleTemp: 0, targetNozzleTemp: 0, bedTemp: 0, targetBedTemp: 0, rawState: 'completed' };

  it.each(['moonraker', 'creality'] as const)('%s appends the warning for a cancelled order; the text is unchanged otherwise', async (which) => {
    const h = box();
    const notifications = { create: jest.fn(async () => ({})) };
    const complete = async (jobId: string) => {
      await h.jobs.update(jobId, { status: 'IN_PROGRESS' });
      if (which === 'moonraker') await new MoonrakerService(h.db as any, notifications as any, h.completion).handleJobCompleted('pr-1', moonSnap as any);
      else await new CrealityWsService(h.db as any, notifications as any, h.completion).handleJobCompleted('pr-1', crealitySnap as any);
      const calls: any[] = notifications.create.mock.calls;
      return calls[calls.length - 1][0].message as string;
    };
    const plain = which === 'moonraker' ? 'finished on K1. Duration: 60min, Filament: 0.0g' : 'finished on K1. Duration: 60min';

    const normal = await orderWithJob(h);
    expect(await complete(normal.job.id)).toBe(`"${normal.job.name}" ${plain}`);

    const { order, job } = await orderWithJob(h);
    cancel(h, order.id);
    expect(await complete(job.id)).toBe(
      `"${job.name}" ${plain} — Order ${order.orderNumber} was cancelled — the 12 units this job printed for it were not added to printed stock. Add them by hand if you keep them`,
    );
  });
});
