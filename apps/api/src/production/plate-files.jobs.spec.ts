import { BOX_ID, boxRow } from '../catalog-core/__fixtures__/box-product';
import { addOrder, productionHarness } from './__fixtures__/production-harness';

/**
 * Owner spec 2026-10-02 items 4, 5, 6 through the job services: the preview
 * and the job prefer plates with files and default to the printer the files
 * were sliced for; a job's plate whose file was deleted says so.
 */

function box(opts: { files?: boolean; slicedFor?: string } = {}) {
  const row = boxRow();
  const files = opts.files !== false;
  if (files) {
    row.components[0].attachmentId = 'att-1';
    row.components[0].plateLayouts[0].attachmentId = 'att-12';
  }
  const h = productionHarness([row]);
  h.db.insert('printer', { id: 'pr-hi', name: 'HI', model: null, isActive: true, hourlyRate: 0.5, wattage: 300, markupMultiplier: 2.5 });
  if (files) {
    for (const id of ['att-1', 'att-12']) {
      h.db.insert('attachment', {
        id, entityType: 'product', entityId: BOX_ID, filename: `${id}.gcode`, originalName: `${id}.gcode`, mimeType: 'application/octet-stream',
        sizeBytes: 10, storagePath: `x/${id}.gcode`, slicedForPrinter: opts.slicedFor ?? 'Creality Hi',
      });
    }
  }
  return h;
}

const shape = (plates: Array<{ unitsPerPlate: number; plateCount: number }>) => plates.map((p) => `${p.plateCount}×${p.unitsPerPlate}`);

describe('J2 preview', () => {
  it('13 boxes with ×12 and ×1 files → ×12 + ×1, and the printer the files were sliced for', async () => {
    const h = box();
    const p: any = await h.planning.previewJob({ productId: BOX_ID, quantity: 13 });
    expect(shape(p.components[0].plates)).toEqual(['1×12', '1×1']);
    expect(p.printer).toEqual({ printerId: 'pr-hi', printerName: 'HI', slicedFor: 'Creality Hi', fromFile: true });
    expect(p.warnings.map((w: any) => w.code)).not.toContain('NO_GCODE_ON_FILE');
  });

  it('no file on record → the old suggestion, "No G-code on file for …", the pricing printer', async () => {
    const h = box({ files: false });
    const p: any = await h.planning.previewJob({ productId: BOX_ID, quantity: 13 });
    expect(shape(p.components[0].plates)).toEqual(['1×12', '1×1']);
    expect(p.warnings).toContainEqual(expect.objectContaining({ code: 'NO_GCODE_ON_FILE', message: 'No G-code on file for "Box" — upload one' }));
    expect(p.printer).toMatchObject({ printerId: 'pr-1', fromFile: false, slicedFor: null });
  });

  it('a file sliced for a printer the farm lacks → "Sliced for … — no matching printer"', async () => {
    const h = box({ slicedFor: 'Bambu Lab X1 Carbon' });
    const p: any = await h.planning.previewJob({ productId: BOX_ID, quantity: 12 });
    expect(p.printer).toMatchObject({ printerId: 'pr-1', fromFile: false, slicedFor: 'Bambu Lab X1 Carbon' });
    expect(p.warnings).toContainEqual({ code: 'PRINTER_NOT_MATCHED', message: 'Sliced for Bambu Lab X1 Carbon — no matching printer' });
  });
});

describe('J1 create and J3 read', () => {
  it('without a printer the job gets the matched one; its plates carry the files', async () => {
    const h = box();
    const job: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 13 });
    expect(h.db.t('productionJob').find((j: any) => j.id === job.id).printerId).toBe('pr-hi');
    const plates = h.db.t('jobPlate').filter((p: any) => p.jobId === job.id);
    expect(plates.map((p: any) => p.attachmentId).sort()).toEqual(['att-1', 'att-12']);
    // An explicit choice still wins.
    const chosen: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 13, printerId: null });
    expect(h.db.t('productionJob').find((j: any) => j.id === chosen.id).printerId).toBeNull();
  });

  it('a plate whose file was deleted since: no download, fileDeleted', async () => {
    const h = box();
    const job: any = await h.jobs.create({ productId: BOX_ID, quantityToProduce: 13 });
    h.db.t('attachment').splice(h.db.t('attachment').findIndex((a: any) => a.id === 'att-12'), 1);
    const detail: any = await h.jobs.findOne(job.id);
    const byUnits = Object.fromEntries(detail.plates.map((p: any) => [p.unitsPerPlate, p]));
    expect(byUnits[12]).toMatchObject({ downloadUrl: null, fileDeleted: true });
    expect(byUnits[1]).toMatchObject({ downloadUrl: '/api/attachments/att-1/download', fileDeleted: false });
  });
});

describe('J4 plan rows', () => {
  it('each row defaults to the printer its suggested plates were sliced for', async () => {
    const h = box();
    const { order } = addOrder(h.db, [{ productId: BOX_ID, quantity: 13, description: 'Box' }]);
    const plan: any = await h.planning.previewPlan(order.id);
    expect(plan.rows[0]).toMatchObject({ printerId: 'pr-hi', printerName: 'HI' });
    expect(shape(plan.rows[0].suggestedPlates)).toEqual(['1×12', '1×1']);
  });

  it('unmatched → the pricing printer and a row warning', async () => {
    const h = box({ slicedFor: 'Creality K1 Max' });
    const { order } = addOrder(h.db, [{ productId: BOX_ID, quantity: 12, description: 'Box' }]);
    const plan: any = await h.planning.previewPlan(order.id);
    expect(plan.rows[0].printerId).toBe('pr-1');
    expect(plan.rows[0].warnings).toContainEqual(expect.objectContaining({ code: 'PRINTER_NOT_MATCHED', message: 'Sliced for Creality K1 Max — no matching printer' }));
  });
});
