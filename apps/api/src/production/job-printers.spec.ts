import { BOX_ID, boxRow } from '../catalog-core/__fixtures__/box-product';
import { M } from '../catalog-core/__fixtures__/sardine-tin';
import { parsePreview } from './job-input';
import { addOrder, addSpool, expectStatus, productionHarness, type ProductionHarness } from './__fixtures__/production-harness';

/**
 * v2.18.2: plates sliced for different printers are never mixed in one job.
 * Box has its own single unit (34 min, no file), "×3 · Hi" and "×6 · Ender";
 * the product's default (pricing) printer is the K1.
 */

type H = ProductionHarness;
const HI = 'pr-hi';
const ENDER = 'pr-ender';
const MIXED = 'These plates are sliced for different printers (Ender and Hi). Choose one printer.';

const platesOf = (h: H, jobId: string) =>
  h.db.t('jobPlate').filter((p: any) => p.jobId === jobId).sort((a: any, b: any) => a.sortOrder - b.sortOrder).map((p: any) => [p.layoutId, p.plateCount]);
const jobRow = (h: H, id: string) => h.db.t('productionJob').find((j: any) => j.id === id);

function box(opts: { defaultPrinter?: string | null; plain?: boolean } = {}) {
  const row = boxRow();
  if (!opts.plain) {
    const layout = (id: string, units: number, minutes: number, printerId: string, sortOrder: number) => ({
      id, componentId: 'box', name: `×${units}`, unitsPerPlate: units, plateMinutes: minutes, plateGrams: units * 9.4, colorChanges: 0,
      attachmentId: `a-${id}`, gcodeFilename: `${id}.gcode`, isActive: true, sortOrder, createdAt: new Date(0), updatedAt: new Date(0), slots: [],
      source: 'SLICED', printerId,
    });
    row.components[0].plateLayouts = [layout('box3', 3, 30, HI, 0), layout('box6', 6, 54, ENDER, 1)];
  }
  if (opts.defaultPrinter !== undefined) {
    row.defaultPrinterId = opts.defaultPrinter;
    row.defaultPrinter = opts.defaultPrinter ? { id: opts.defaultPrinter, name: opts.defaultPrinter === HI ? 'Hi' : 'Ender', hourlyRate: 0.4, wattage: 200, markupMultiplier: 2.5 } : null;
  }
  const h = productionHarness([row]);
  for (const [id, name] of [[HI, 'Hi'], [ENDER, 'Ender']] as const) {
    if (!h.db.t('printer').some((p: any) => p.id === id)) h.db.insert('printer', { id, name, isActive: true, model: null });
  }
  addSpool(h.db, M.black, 50_000, { id: 'sp-black' });
  return h;
}

describe('J2 preview: the suggestion follows the printer', () => {
  it('Printer = Hi, 20 units → 7 plates of ×3, never the Ender ×6; the layouts say their printer', async () => {
    const h = box();
    const p: any = await h.jobs.preview({ productId: BOX_ID, quantity: 20, printerId: HI });
    expect(p.components[0].plates).toEqual([{ layoutId: 'box3', label: 'Box ×3', unitsPerPlate: 3, plateCount: 7, printerId: HI, printerName: 'Hi' }]);
    expect([p.planPrinterId, p.planPrinterName]).toEqual([HI, 'Hi']);
    expect(p.layoutsByComponent.box.map((l: any) => [l.layoutId, l.printerId ?? null, l.printerName ?? null])).toEqual([
      ['box6', ENDER, 'Ender'], ['box3', HI, 'Hi'], [null, null, null],
    ]);
    const ender: any = await h.jobs.preview({ productId: BOX_ID, quantity: 20, printerId: ENDER });
    expect(ender.components[0].plates.map((x: any) => [x.layoutId, x.plateCount])).toEqual([['box6', 4]]);
  });

  it('no printer → one printer\'s plates, the best group, and `printer` preselects it', async () => {
    const h = box();
    for (const body of [{ printerId: null }, {}]) {
      const p: any = await h.jobs.preview({ productId: BOX_ID, quantity: 20, ...body });
      expect(p.components[0].plates.map((x: any) => [x.layoutId, x.plateCount])).toEqual([['box6', 4]]);
      expect([p.planPrinterId, p.planPrinterName]).toEqual([ENDER, 'Ender']);
      expect(p.printer).toMatchObject({ printerId: ENDER, printerName: 'Ender', fromFile: true });
    }
  });

  it('printer not chosen and the default printer has the plates → the default printer', async () => {
    const h = box({ defaultPrinter: HI });
    const p: any = await h.jobs.preview({ productId: BOX_ID, quantity: 20 });
    expect(p.components[0].plates.map((x: any) => [x.layoutId, x.plateCount])).toEqual([['box3', 7]]);
    expect(p.planPrinterId).toBe(HI);
    // "No printer" chosen by hand: the default printer is not preferred any more.
    const none: any = await h.jobs.preview({ productId: BOX_ID, quantity: 20, printerId: null });
    expect(none.planPrinterId).toBe(ENDER);
  });

  it('a printer with no plate for the part → the single unit and a warning naming the printer', async () => {
    const h = box();
    const p: any = await h.jobs.preview({ productId: BOX_ID, quantity: 2, printerId: 'pr-1' });
    expect(p.components[0].plates).toEqual([{ layoutId: null, label: 'Box single', unitsPerPlate: 1, plateCount: 2 }]);
    expect(p.warnings).toContainEqual({ code: 'NO_GCODE_ON_FILE', componentId: 'box', message: 'No plate sliced for K1 for "Box"' });
    expect(p.planPrinterId).toBeNull();
  });

  it('plates edited by hand that no longer fit the printer → 400 with the problem; an unknown printer → 400', async () => {
    const h = box();
    const ender = [{ componentId: 'box', layoutId: 'box6', plateCount: 4 }];
    await expectStatus(h.jobs.preview({ productId: BOX_ID, quantity: 20, printerId: HI, plates: ender }), 400, '"Box": plate ×6 is sliced for Ender, not Hi');
    const ok: any = await h.jobs.preview({ productId: BOX_ID, quantity: 20, printerId: ENDER, plates: ender });
    expect(ok.planPrinterId).toBe(ENDER);
    const mixed = [{ componentId: 'box', layoutId: 'box6', plateCount: 3 }, { componentId: 'box', layoutId: 'box3', plateCount: 1 }];
    await expectStatus(h.jobs.preview({ productId: BOX_ID, quantity: 20, printerId: null, plates: mixed }), 400, MIXED);
    await expectStatus(h.jobs.preview({ productId: BOX_ID, quantity: 20, printerId: 'pr-gone' }), 400, 'Printer not found');
  });

  it('parsePreview: null = "No printer", absent or empty = not chosen', () => {
    expect(parsePreview({ productId: 'p', quantity: 1, printerId: null }).printerId).toBeNull();
    expect(parsePreview({ productId: 'p', quantity: 1, printerId: '' }).printerId).toBeUndefined();
    expect(parsePreview({ productId: 'p', quantity: 1 }).printerId).toBeUndefined();
    expect(parsePreview({ productId: 'p', quantity: 1, printerId: 'pr-hi' }).printerId).toBe('pr-hi');
  });
});

describe('J1 create: a job has one printer', () => {
  it('suggested plates are the job printer\'s', async () => {
    const h = box();
    const hi: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 20, printerId: HI });
    expect(platesOf(h, hi.id)).toEqual([['box3', 7]]);
    expect(jobRow(h, hi.id).printerId).toBe(HI);
  });

  it('a chosen plate sliced for another printer → 400 and no job', async () => {
    const h = box();
    const err = await expectStatus(
      h.jobs.create({ productId: BOX_ID, quantityToProduce: 20, printerId: HI, plates: [{ componentId: 'box', layoutId: 'box6', plateCount: 4 }] }),
      400,
    );
    expect(err.message).toBe('"Box": plate ×6 is sliced for Ender, not Hi');
    expect(h.db.t('productionJob')).toHaveLength(0);
  });

  it('no printer and plates of two printers → 400; one printer\'s plates are accepted', async () => {
    const h = box();
    const mixed = [{ componentId: 'box', layoutId: 'box6', plateCount: 3 }, { componentId: 'box', layoutId: 'box3', plateCount: 1 }];
    const err = await expectStatus(h.jobs.create({ productId: BOX_ID, quantityToProduce: 20, printerId: null, plates: mixed }), 400);
    expect(err.message).toBe(MIXED);
    await expectStatus(h.jobs.create({ productId: BOX_ID, quantityToProduce: 20, plates: mixed }), 400, MIXED);
    expect(h.db.t('productionJob')).toHaveLength(0);
    const ok: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 20, printerId: null, plates: [{ componentId: 'box', layoutId: 'box6', plateCount: 4 }] });
    expect(platesOf(h, ok.id)).toEqual([['box6', 4]]);
    expect(jobRow(h, ok.id).printerId).toBeNull();
  });

  it('printer not sent → the job goes to the printer its suggested plates were sliced for', async () => {
    const h = box();
    const job: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 20 });
    expect(platesOf(h, job.id)).toEqual([['box6', 4]]);
    expect(jobRow(h, job.id).printerId).toBe(ENDER);
  });

  it('a printer that can print nothing of the part → 400 naming the printer', async () => {
    const row = boxRow();
    row.components[0].plateLayouts = [{
      id: 'box1', componentId: 'box', name: '×1', unitsPerPlate: 1, plateMinutes: 30, plateGrams: 9.4, colorChanges: 0, attachmentId: 'a-box1',
      gcodeFilename: 'box1.gcode', isActive: true, sortOrder: 0, createdAt: new Date(0), updatedAt: new Date(0), slots: [], printerId: ENDER,
    }];
    const h = productionHarness([row]);
    h.db.insert('printer', { id: ENDER, name: 'Ender', isActive: true, model: null });
    h.db.insert('printer', { id: HI, name: 'Hi', isActive: true, model: null });
    addSpool(h.db, M.black, 5000, { id: 'sp-black' });
    const err = await expectStatus(h.jobs.create({ productId: BOX_ID, quantityToProduce: 2, printerId: HI }), 400);
    expect(err.message).toBe('No plate sliced for Hi for "Box"');
  });
});

describe('P20 readiness and J4/J5', () => {
  it('readiness prefers the default printer when it has the plates, and says which printer the plan is for', async () => {
    const hi = box({ defaultPrinter: HI });
    const r: any = await hi.planner.readiness(BOX_ID, { sizeOptionId: null, colourOptionId: null }, 20);
    expect(r.components[0].plates.map((x: any) => [x.layoutId, x.plateCount, x.printerName])).toEqual([['box3', 7, 'Hi']]);
    expect([r.planPrinterId, r.planPrinterName]).toEqual([HI, 'Hi']);
    // The K1 (default) has no plate for the Box: the best printer group instead, never a mix.
    const k1: any = await box().planner.readiness(BOX_ID, { sizeOptionId: null, colourOptionId: null }, 20);
    expect(k1.components[0].plates.map((x: any) => [x.layoutId, x.plateCount])).toEqual([['box6', 4]]);
    expect(k1.planPrinterName).toBe('Ender');
  });

  it('a product with no printer on its layouts: the same plates as before and no printer keys', async () => {
    const h = box({ plain: true });
    const r: any = await h.planner.readiness(BOX_ID, { sizeOptionId: null, colourOptionId: null }, 13);
    expect(r.components[0].plates).toEqual([
      { layoutId: 'box12', label: 'Box ×12', unitsPerPlate: 12, plateCount: 1 },
      { layoutId: null, label: 'Box single', unitsPerPlate: 1, plateCount: 1 },
    ]);
    expect([r.planPrinterId, r.planPrinterName]).toEqual([null, null]);
    const p: any = await h.jobs.preview({ productId: BOX_ID, quantity: 13, printerId: HI });
    expect(p.components[0].plates).toEqual(r.components[0].plates);
    expect(p.layoutsByComponent.box.every((l: any) => !('printerId' in l))).toBe(true);
  });

  it('J4: the row is planned for one printer and defaults to it; J5 refuses plates of another printer', async () => {
    const h = box();
    const { order, items } = addOrder(h.db, [{ productId: BOX_ID, quantity: 20, description: 'Box' }]);
    const plan: any = await h.planning.previewPlan(order.id);
    const row = plan.rows[0];
    expect(row.suggestedPlates).toEqual([{ layoutId: 'box6', label: 'Box ×6', unitsPerPlate: 6, plateCount: 4, printerId: ENDER, printerName: 'Ender' }]);
    expect([row.printerId, row.printerName]).toEqual([ENDER, 'Ender']);
    expect(row.layouts.map((l: any) => [l.layoutId, l.printerName ?? null])).toEqual([['box6', 'Ender'], ['box3', 'Hi'], [null, null]]);

    const rowKey = `${items[0].id}:box`;
    await expectStatus(
      h.planning.createFromPlan(order.id, { planVersion: plan.planVersion, rows: [{ rowKey, printerId: HI, plates: [{ layoutId: 'box6', plateCount: 4 }] }] }),
      400, '"Box": plate ×6 is sliced for Ender, not Hi',
    );
    await expectStatus(
      h.planning.createFromPlan(order.id, { planVersion: plan.planVersion, rows: [{ rowKey, printerId: null, plates: [{ layoutId: 'box6', plateCount: 3 }, { layoutId: 'box3', plateCount: 1 }] }] }),
      400, MIXED,
    );
    expect(h.db.t('productionJob')).toHaveLength(0);

    // The row's printer changed to the Hi with no plates chosen: its plates are suggested for the Hi.
    const res = await h.planning.createFromPlan(order.id, { planVersion: plan.planVersion, rows: [{ rowKey, printerId: HI }] });
    expect(res.jobsCreated).toBe(1);
    expect(jobRow(h, res.jobs[0].id).printerId).toBe(HI);
    expect(platesOf(h, res.jobs[0].id)).toEqual([['box3', 7]]);
  });

  it('J5 with the suggestion as it is: the job is on the printer of its plates', async () => {
    const h = box();
    const { order } = addOrder(h.db, [{ productId: BOX_ID, quantity: 20, description: 'Box' }]);
    const plan: any = await h.planning.previewPlan(order.id);
    const res = await h.planning.createFromPlan(order.id, { planVersion: plan.planVersion });
    expect(jobRow(h, res.jobs[0].id).printerId).toBe(ENDER);
    expect(platesOf(h, res.jobs[0].id)).toEqual([['box6', 4]]);
  });
});
