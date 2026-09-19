import { BOX_ID, boxRow } from '../catalog-core/__fixtures__/box-product';
import { fixtureMaterial, M } from '../catalog-core/__fixtures__/sardine-tin';
import { CrealityWsService } from '../moonraker-bridge/creality-ws.service';
import { MoonrakerService } from '../moonraker-bridge/moonraker.service';
import { JobMaterialsService } from '../production/job-materials.service';
import { addJobRow, addOrder, addSpool, productionHarness } from '../production/__fixtures__/production-harness';

/**
 * §3.6 "Job completion, every path" and §7.1 item 25: the manual route and both
 * printer bridges go through JobCompletionService, with identical effects.
 */

type H = ReturnType<typeof productionHarness>;
const RED = 'v-box-red';

function setup(opts: { only12?: boolean; parts?: boolean } = {}) {
  const row = boxRow({ withRed: true });
  if (!opts.only12) {
    row.components[0].plateLayouts.push({
      id: 'box8', componentId: 'box', name: '×8', unitsPerPlate: 8, plateMinutes: 170, plateGrams: 75.2, colorChanges: 0,
      attachmentId: null, gcodeFilename: 'Box x8.gcode', isActive: true, sortOrder: 1, createdAt: new Date(0), updatedAt: new Date(0), slots: [],
    });
  }
  if (opts.parts) row.parts = [{ partId: 'pt1', quantity: 1, part: { id: 'pt1', name: 'Magnet', unitCost: 0.05, isActive: true, stockQty: 50 } }];
  const h = productionHarness([row]);
  h.db.insert('material', fixtureMaterial(M.blue));
  h.db.t('printer')[0].totalPrintHours = 0;
  for (const m of [M.black, M.red, M.blue]) addSpool(h.db, m, 5000, { id: `sp-${m}` });
  const notifications = { create: jest.fn(async () => ({})) };
  const moonraker = new MoonrakerService(h.db as any, notifications as any, h.completion);
  const creality = new CrealityWsService(h.db as any, notifications as any, h.completion);
  return { h, moonraker, creality, notifications };
}

const moonSnap = (filename: string, seconds = 3600) => ({
  hostname: 'k1', printerState: 'ready', progress: 1, heaterBed: null, extruder: null,
  printStats: { filename, total_duration: seconds, print_duration: seconds, filament_used: 0, state: 'complete', message: '' },
});
const crealitySnap = (fileName: string, seconds = 3600) => ({
  printerId: 'pr-1', printerName: 'K1', state: 'idle', progress: 100, fileName, printLeftTime: 0, printJobTime: seconds,
  nozzleTemp: 0, targetNozzleTemp: 0, bedTemp: 0, targetBedTemp: 0, rawState: 'completed',
});

/** A (Standard, Red) KEEP order job for 10 boxes on one ×12 plate. */
async function orderJob(h: H) {
  const { order, items } = addOrder(h.db, [{ productId: BOX_ID, colourOptionId: RED, quantity: 10 }]);
  return (await h.jobs.create({ productId: BOX_ID, colourOptionId: RED, orderId: order.id, orderItemId: items[0].id, quantityToProduce: 10 })) as any;
}

const jobRow = (h: H, id: string) => h.db.t('productionJob').find((j: any) => j.id === id);

function effects(h: H, jobId: string) {
  const j = jobRow(h, jobId);
  const strip = ({ id: _i, createdAt: _c, updatedAt: _u, jobId: _j, ...rest }: any) => rest;
  return {
    job: { status: j.status, printDuration: j.printDuration },
    spools: h.db.t('spool').map((s: any) => [s.id, Math.round(s.currentWeight * 1000) / 1000]),
    parts: h.db.t('part').map((p: any) => [p.id, p.stockQty]),
    jobParts: h.db.t('jobPart').map(strip),
    printerHours: h.db.t('printer')[0].totalPrintHours,
    column: h.db.t('productComponent')[0].stockOnHand,
    rows: h.db.t('componentColourStock').map((r: any) => [r.colourKey, r.stockOnHand]),
    movements: h.db.t('componentStockMovement').map(strip),
  };
}

describe('JobCompletionService (§3.6, §7.1 item 25)', () => {
  it('manual, Moonraker and Creality produce identical DB effects for the same job', async () => {
    const out: any[] = [];
    for (const path of ['MANUAL', 'MOONRAKER', 'CREALITY'] as const) {
      const { h, moonraker, creality } = setup({ only12: true, parts: true });
      const job = await orderJob(h);
      expect(job.gcodeFilename).toBe('Box x12.gcode');
      await h.jobs.update(job.id, { status: 'IN_PROGRESS', printDuration: 3600 });
      if (path === 'MANUAL') await h.jobs.completeJob(job.id);
      if (path === 'MOONRAKER') await moonraker.handleJobCompleted('pr-1', moonSnap('Box x12.gcode') as any);
      if (path === 'CREALITY') await creality.handleJobCompleted('pr-1', crealitySnap('Box x12.gcode') as any);
      out.push(effects(h, job.id));
    }
    expect(out[0].job.status).toBe('COMPLETED');
    expect(out[0].printerHours).toBe(1);
    expect(out[0].rows).toEqual([[`0:${M.red}`, 2]]);
    expect(out[0].parts).toEqual([['pt1', 40]]);
    expect(out[1]).toEqual(out[0]);
    expect(out[2]).toEqual(out[0]);
  });

  it('a bridge completion of a KEEP order job (one ×12 plate for 10) credits +2 to the colour actually printed', async () => {
    const { h, moonraker, notifications } = setup({ only12: true });
    const job = await orderJob(h);
    const line = h.db.t('jobMaterial').find((l: any) => l.jobId === job.id);
    await new JobMaterialsService(h.db as any).swapColour(line.id, { materialId: M.blue });
    await moonraker.handleJobCompleted('pr-1', moonSnap('Box x12.gcode') as any);
    expect(jobRow(h, job.id).status).toBe('COMPLETED');
    expect(h.db.t('componentColourStock').map((r: any) => [r.colourKey, r.stockOnHand])).toEqual([[`0:${M.blue}`, 2]]);
    expect(h.db.t('spool').find((s: any) => s.id === `sp-${M.blue}`).currentWeight).toBeCloseTo(5000 - 112.8, 6);
    expect(jobRow(h, job.id).machineCost).toBeCloseTo(0.4, 6);
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'JOB_COMPLETED', entityId: job.id }));
  });

  it('a 3-plate job (gcodeFilename null) is never matched by handleJobCompleted / handleJobStarted; it stays active', async () => {
    const { h, moonraker, creality } = setup();
    const job: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 30 });
    expect(job.gcodeFilename).toBeNull();
    await moonraker.handleJobStarted('pr-1', { ...moonSnap('Box x12.gcode'), printStats: { ...moonSnap('Box x12.gcode').printStats, state: 'printing' } } as any);
    await creality.handleJobStarted('pr-1', crealitySnap('Box x12.gcode') as any);
    await moonraker.handleJobCompleted('pr-1', moonSnap('Box x12.gcode') as any);
    await creality.handleJobCompleted('pr-1', crealitySnap('Box x12.gcode') as any);
    expect(jobRow(h, job.id).status).toBe('QUEUED');
    expect(h.db.t('spool').find((s: any) => s.id === `sp-${M.black}`).currentWeight).toBe(5000);
  });

  it('a placeholder job (no file) is never matched by handleJobStarted', async () => {
    const { h, moonraker } = setup();
    const { order, items } = addOrder(h.db, [{ productId: BOX_ID, quantity: 1 }]);
    const ph = addJobRow(h.db, { orderId: order.id, orderItemId: items[0].id, printerId: 'pr-1' });
    await moonraker.handleJobStarted('pr-1', moonSnap('Box x12.gcode') as any);
    expect(jobRow(h, ph.id).status).toBe('QUEUED');
  });

  it.each(['moonraker', 'creality'] as const)('%s handleJobStarted with two QUEUED single-plate jobs of the same file flips only the oldest', async (which) => {
    const { h, moonraker, creality } = setup({ only12: true });
    const a: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 12 });
    const b: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 12 });
    jobRow(h, a.id).createdAt = new Date(2000);
    jobRow(h, b.id).createdAt = new Date(1000);
    if (which === 'moonraker') await moonraker.handleJobStarted('pr-1', moonSnap('Box x12.gcode') as any);
    else await creality.handleJobStarted('pr-1', crealitySnap('Box x12.gcode') as any);
    expect([jobRow(h, a.id).status, jobRow(h, b.id).status]).toEqual(['QUEUED', 'IN_PROGRESS']);
  });

  it('the completion lookup prefers IN_PROGRESS over QUEUED, then the oldest', async () => {
    const { h, creality } = setup({ only12: true });
    const older: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 12 });
    const running: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 12 });
    jobRow(h, older.id).createdAt = new Date(1000);
    jobRow(h, running.id).createdAt = new Date(2000);
    await h.jobs.update(running.id, { status: 'IN_PROGRESS' });
    await creality.handleJobCompleted('pr-1', crealitySnap('Box x12.gcode') as any);
    expect([jobRow(h, older.id).status, jobRow(h, running.id).status]).toEqual(['QUEUED', 'COMPLETED']);
  });

  it('a bridge completion after a manual completion → no second deduction, skipped and logged', async () => {
    const { h, moonraker, notifications } = setup({ only12: true });
    const job: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 12, printerId: 'pr-1' });
    await h.jobs.completeJob(job.id);
    const after = effects(h, job.id);
    const direct = await h.completion.complete(job.id, { source: 'MOONRAKER' });
    expect(direct).toBeNull();
    await moonraker.handleJobCompleted('pr-1', moonSnap('Box x12.gcode') as any);
    expect(effects(h, job.id)).toEqual(after);
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('a duplicate bridge event deducts once', async () => {
    const { h, creality } = setup({ only12: true });
    const job: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 12 });
    await h.jobs.update(job.id, { status: 'IN_PROGRESS' });
    await Promise.all([
      creality.handleJobCompleted('pr-1', crealitySnap('Box x12.gcode') as any),
      creality.handleJobCompleted('pr-1', crealitySnap('Box x12.gcode') as any),
    ]);
    expect(h.db.t('spool').find((s: any) => s.id === `sp-${M.black}`).currentWeight).toBeCloseTo(5000 - 112.8, 6);
  });
});
