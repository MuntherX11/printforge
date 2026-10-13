import * as fs from 'fs';
import * as path from 'path';
import { expectStatus } from '../production/__fixtures__/production-harness';
import { stl, useTempUploadDir } from '../slice/__fixtures__/slice-harness';
import { HI, K1, M, OLD, mixedGcode, orderPlatesHarness, type OrderPlatesHarness } from './__fixtures__/order-plates-harness';
import { PLATE_LOCKED, PLATE_RUNNING } from './order-plates.service';

/**
 * The print plan of an order (v2.19.0): what it needs, the suggestion, staff's
 * changes to it and the slice queue.
 */

const dirOf = useTempUploadDir();

async function setup(quantity = 6, mutate?: Parameters<typeof orderPlatesHarness>[0]) {
  const x = orderPlatesHarness(mutate);
  await x.seedFiles();
  return { x, o: x.order(quantity) };
}
const need = (plan: any, part: string) => plan.needs.find((n: any) => n.componentId === part);
const plateOf = (plan: any, part: string) => plan.plates.find((p: any) => p.items.some((i: any) => i.componentId === part));
const codes = (plan: any) => plan.warnings.map((w: any) => w.code);

describe('GET print-plan', () => {
  it('one need per plan row, each with how it can be printed', async () => {
    const { x, o } = await setup();
    const plan = await x.plates.getPlan(o.id);
    expect(plan).toMatchObject({ orderId: o.id, plannable: true, plates: [], slicerReachable: true, finishMinutes: 0 });
    expect(plan.needs.map((n) => [n.componentDescription, n.mode, n.toProduce, n.planned, n.materialName, n.canOwnSettings, n.lockedPrinterId])).toEqual([
      ['dress', 'MIX', 6, 0, 'PLA Black', false, null],
      ['hat', 'MIX', 6, 0, 'PLA Black', false, null],
      ['shoe', 'MIX', 6, 0, 'PLA White', false, null],
      ['badge', 'MIX', 6, 0, 'PLA Black', true, null],
      ['face', 'PROJECT', 6, 0, null, false, HI],
      ['stand', 'LAYOUT', 6, 0, null, false, null],
    ]);
    expect(need(plan, 'stand').layouts).toEqual([
      { layoutId: 'stand10', label: 'stand ×10', unitsPerPlate: 10, printerId: null, printerName: null, hasFile: true },
      { layoutId: null, label: 'stand single', unitsPerPlate: 1, printerId: null, printerName: null, hasFile: false },
    ]);
    // The DTO carries the contract's keys only, never the server-side facts of a need.
    expect(Object.keys(plan.needs[0]).sort()).toEqual([
      'blockedReason', 'canOwnSettings', 'colourLabel', 'componentDescription', 'componentId', 'layouts', 'lockedPrinterId', 'materialId', 'materialName',
      'mode', 'optionLabel', 'orderItemId', 'planned', 'productName', 'rowKey', 'toProduce',
    ]);
    expect(plan.printers).toEqual([
      { id: HI, name: 'Hi', canSliceModels: true, plates: 0, minutes: 0 },
      { id: K1, name: 'K1', canSliceModels: true, plates: 0, minutes: 0 },
      { id: OLD, name: 'Old', canSliceModels: false, plates: 0, minutes: 0 },
    ]);
    expect(codes(plan)).toEqual(Array(6).fill('SHORT'));
  });

  it('blocked parts say why; a slicer that does not answer is a warning; an order that cannot be planned is read-only', async () => {
    const { x, o } = await setup(2, (row) => {
      row.components.find((c: any) => c.id === 'hat').pendingFirstSlice = true;
    });
    x.profiles.filaments.delete(M.white);
    x.health.health.mockResolvedValue({ reachable: false, orcaVersion: null } as any);
    const plan = await x.plates.getPlan(o.id);
    expect(need(plan, 'hat')).toMatchObject({ mode: 'BLOCKED', blockedReason: '"hat" has not been sliced yet — slice one unit on the product page first' });
    expect(need(plan, 'shoe')).toMatchObject({ mode: 'BLOCKED', blockedReason: expect.stringContaining('"PLA White" has no slicer preset') });
    expect(need(plan, 'face').mode).toBe('BLOCKED');
    expect(plan.slicerReachable).toBe(false);
    expect(codes(plan)).toEqual(expect.arrayContaining(['SLICER_DOWN', 'BLOCKED']));

    const done = x.order(1, 'COMPLETED');
    expect(await x.plates.getPlan(done.id)).toMatchObject({ plannable: false });
    await expectStatus(x.plates.suggest(done.id, {}), 409, "production can't be planned");
    await expectStatus(x.plates.getPlan('nope'), 404);
  });
});

describe('suggest', () => {
  it('"Prepare print files": a plate for everything, on the printers with the least to do', async () => {
    const { x, o } = await setup();
    const plan = await x.plates.suggest(o.id, {});
    expect(plan.plates.map((p) => [p.label, p.kind, p.status, p.items.map((i) => `${i.componentDescription} ${i.units}`).join(', '), p.plateCount])).toEqual([
      ['Plate 1 · Hi', 'PROJECT', 'DRAFT', 'face 6', 1],
      ['Plate 2 · K1', 'LAYOUT', 'DONE', 'stand 10', 1],
      ['Plate 3 · K1', 'MIXED', 'DRAFT', 'dress 6, badge 6, hat 6', 1],
      ['Plate 4 · Hi', 'MIXED', 'DRAFT', 'shoe 6', 1],
    ]);
    expect(plan.needs.map((n) => [n.componentDescription, n.planned])).toEqual([['dress', 6], ['hat', 6], ['shoe', 6], ['badge', 6], ['face', 6], ['stand', 10]]);
    // The ×10 file prints 10 stands for an order of 6: said, never refused.
    expect(plan.warnings).toEqual([{ code: 'OVER', rowKey: o.key('stand'), message: 'stand: the plates hold 10, the order needs 6' }]);

    const face = plateOf(plan, 'face');
    expect(face).toMatchObject({ printerId: HI, estMinutes: 120, estGrams: 24, hasFile: false, locked: false, minutes: null });
    expect(face.filaments).toEqual([
      { slot: 0, materialId: M.white, name: 'PLA White', type: 'PLA', colorHex: '#FFFFFF' },
      { slot: 1, materialId: M.orange, name: 'Silk Orange', type: 'PLA', colorHex: '#FF8000' },
    ]);
    expect(face.preview).toMatchObject({ exact: false, bed: { x: 260, y: 260 }, overflow: 0 });
    expect(face.preview.objects).toHaveLength(6);

    // An existing file is DONE at once, with the file's own numbers and drawing.
    const stand = plateOf(plan, 'stand');
    expect(stand).toMatchObject({ layoutId: 'stand10', hasFile: true, gcodeFilename: 'stand x10.gcode', minutes: 100, grams: 38, items: [{ units: 10, unitsSliced: 10, minutes: 100, grams: 38 }] });
    expect(stand.preview).toMatchObject({ exact: true, bed: { x: 220, y: 220 } });
    expect(stand.preview.objects).toHaveLength(10);
    expect(stand.preview.objects.every((ob: any) => ob.rowKey === o.key('stand'))).toBe(true);

    expect(plan.printers.map((p) => [p.name, p.plates, p.minutes])).toEqual([['Hi', 2, 150], ['K1', 2, 388], ['Old', 0, 0]]);
    expect(plan.finishMinutes).toBe(388);
  });

  it('a project plate holds what an earlier slice showed fits', async () => {
    const { x, o } = await setup(10);
    x.db.insert('sliceRun', { componentId: 'face', printerId: HI, unitsRequested: 20, unitsSliced: 4, status: 'DONE', filamentMap: {}, createdAt: new Date() });
    const plan = await x.plates.suggest(o.id, {});
    expect(plan.plates.filter((p) => p.kind === 'PROJECT').map((p) => p.items[0].units)).toEqual([4, 4, 2]);
  });

  it('"Reset to suggestion" replaces every plate without jobs; a plate with jobs stays and keeps its number', async () => {
    const { x, o } = await setup();
    await x.plates.suggest(o.id, {});
    const [face, stand] = x.platesOf(o.id);
    await x.plates.deletePlate(face.id);
    await x.jobs.createJobs(o.id, {});
    const plan = await x.plates.suggest(o.id, {});
    expect(plan.plates.map((p) => [p.label, p.kind, p.locked])).toEqual([
      ['Plate 2 · K1', 'LAYOUT', true],
      ['Plate 3 · Hi', 'PROJECT', false],
      ['Plate 4 · K1', 'MIXED', false],
      ['Plate 5 · Hi', 'MIXED', false],
    ]);
    expect(plan.plates[0].id).toBe(stand.id);
    // The stands are on a job now: nothing more is suggested for them, and they are not short.
    expect(need(plan, 'stand')).toMatchObject({ toProduce: 6, planned: 6 });
    expect(codes(plan)).toEqual([]);
  });

  it('what could not be placed is a warning of the plan: the answer to suggest and a later GET say the same', async () => {
    const x = orderPlatesHarness();
    await x.seedFiles();
    // A dress wider than every bed.
    const wide = await x.addFile(stl(400, 300, 5), 'stl');
    x.comp('dress').sourceAttachmentId = wide.id;
    const o = x.order(2);
    const fromSuggest = await x.plates.suggest(o.id, {});
    const unplaced = { code: 'NO_PRINTER', rowKey: o.key('dress'), message: '"dress" is larger than the bed of every printer that can slice models' };
    expect(fromSuggest.warnings).toContainEqual(unplaced);
    const fromGet = await x.plates.getPlan(o.id);
    expect(fromGet.warnings).toEqual(fromSuggest.warnings);
    expect(fromGet.warnings).toContainEqual({ code: 'SHORT', rowKey: o.key('dress'), message: 'dress: 2 of 2 still need a plate' });
    expect(plateOf(fromGet, 'dress')).toBeUndefined();
  });

  it('takes no body', async () => {
    const { x, o } = await setup();
    await expectStatus(x.plates.suggest(o.id, { printerId: K1 }), 400, 'printerId should not exist');
  });
});

describe('changing plates', () => {
  it('add a plate by hand; change its parts and its printer; delete it', async () => {
    const { x, o } = await setup();
    const made = await x.plates.createPlate(o.id, { kind: 'MIXED', printerId: K1, items: [{ rowKey: o.key('dress'), units: 2 }] });
    expect(made).toMatchObject({ label: 'Plate 1 · K1', kind: 'MIXED', status: 'DRAFT', estMinutes: 60, estGrams: 12, items: [{ componentDescription: 'dress', units: 2 }] });

    const changed = await x.plates.updatePlate(made.id, { items: [{ rowKey: o.key('dress'), units: 3 }, { rowKey: o.key('hat'), units: 1 }], printerId: HI });
    expect(changed).toMatchObject({ id: made.id, label: 'Plate 1 · Hi', printerId: HI, estMinutes: 100, items: [{ units: 3 }, { componentDescription: 'hat', units: 1 }] });
    expect((await x.plates.getPlan(o.id)).needs.map((n) => n.planned)).toEqual([3, 1, 0, 0, 0, 0]);

    expect(await x.plates.deletePlate(made.id)).toEqual({ deleted: true });
    expect(x.platesOf(o.id)).toEqual([]);
    await expectStatus(x.plates.updatePlate(made.id, { printerId: K1 }), 404);
  });

  it('the two hard limits hold for a change as for a new plate', async () => {
    const { x, o } = await setup();
    await expectStatus(x.plates.createPlate(o.id, { kind: 'MIXED', printerId: HI, items: [{ rowKey: o.key('dress'), units: 1 }, { rowKey: o.key('face'), units: 1 }] }), 400, 'prints alone on its own plate');
    const face = await x.plates.createPlate(o.id, { kind: 'PROJECT', printerId: K1, items: [{ rowKey: o.key('face'), units: 2 }] }).catch((e) => e);
    expect(face.message).toBe('"face" prints with its project\'s own settings, on Hi only');
    const ok = await x.plates.createPlate(o.id, { kind: 'PROJECT', items: [{ rowKey: o.key('face'), units: 2 }] });
    expect(ok.printerId).toBe(HI);
    await expectStatus(x.plates.updatePlate(ok.id, { printerId: K1 }), 400, 'on Hi only');
    await expectStatus(x.plates.updatePlate(ok.id, { plateCount: 2 }), 400, 'Only a plate that prints an existing file');
    // "Print alone with its own settings" for a one-slot project.
    expect(await x.plates.createPlate(o.id, { kind: 'PROJECT', items: [{ rowKey: o.key('badge'), units: 2 }] })).toMatchObject({ kind: 'PROJECT', printerId: HI, label: 'Plate 2 · Hi' });
  });

  it('"Use an existing file": a LAYOUT plate, printed several times', async () => {
    const { x, o } = await setup(25);
    const made = await x.plates.createPlate(o.id, { kind: 'LAYOUT', layoutId: 'stand10', plateCount: 2, items: [{ rowKey: o.key('stand'), units: 1 }] });
    expect(made).toMatchObject({ kind: 'LAYOUT', status: 'DONE', plateCount: 2, hasFile: true, printerId: K1, items: [{ units: 10, unitsSliced: 10 }] });
    expect(need(await x.plates.getPlan(o.id), 'stand')).toMatchObject({ toProduce: 25, planned: 20 });
    const more = await x.plates.updatePlate(made.id, { plateCount: 3, printerId: HI });
    expect(more).toMatchObject({ status: 'DONE', plateCount: 3, printerId: HI, hasFile: true });
    // The file is the part's: deleting the plate leaves it where it is.
    const file = x.db.t('plateLayout').find((l: any) => l.id === 'stand10').attachmentId;
    await x.plates.deletePlate(made.id);
    expect(x.db.t('attachment').some((a: any) => a.id === file)).toBe(true);
  });

  it('any change to a sliced plate returns it to DRAFT and drops its file, row and disk', async () => {
    const { x, o } = await setup();
    const made = await x.plates.createPlate(o.id, { kind: 'MIXED', printerId: K1, items: [{ rowKey: o.key('dress'), units: 2 }] });
    const att = await x.addFile(mixedGcode([2]), 'gcode', { entityType: 'order-plate', entityId: made.id });
    Object.assign(x.plate(made.id), {
      status: 'DONE', attachmentId: att.id, gcodeFilename: 'f.gcode', minutes: 50, grams: 9, preview: { bed: { x: 220, y: 220 }, exact: true, objects: [], overflow: 0 },
      items: [{ ...x.plate(made.id).items[0], unitsSliced: 2, minutes: 50, grams: 9 }],
    });
    const abs = path.join(dirOf(), att.storagePath);
    expect(fs.existsSync(abs)).toBe(true);

    const changed = await x.plates.updatePlate(made.id, { items: [{ rowKey: o.key('dress'), units: 3 }] });
    expect(changed).toMatchObject({ status: 'DRAFT', hasFile: false, gcodeFilename: null, minutes: null, grams: null, items: [{ units: 3, unitsSliced: null, minutes: null }] });
    expect(changed.preview).toMatchObject({ exact: false });
    expect(x.db.t('attachment').some((a: any) => a.id === att.id)).toBe(false);
    expect(fs.existsSync(abs)).toBe(false);
    expect(x.gateway.server.emit).toHaveBeenCalledWith('order-plate', { id: made.id, orderId: o.id, status: 'DRAFT', error: null });
  });

  it('a plate that is being sliced or has jobs cannot be changed, sliced again or deleted', async () => {
    const { x, o } = await setup();
    await x.plates.suggest(o.id, {});
    const [face, stand] = x.platesOf(o.id);
    face.status = 'RUNNING';
    await expectStatus(x.plates.updatePlate(face.id, { items: [{ rowKey: o.key('face'), units: 1 }] }), 409, PLATE_RUNNING);
    await expectStatus(x.plates.deletePlate(face.id), 409, PLATE_RUNNING);
    await x.jobs.createJobs(o.id, {});
    await expectStatus(x.plates.updatePlate(stand.id, { plateCount: 2 }), 409, PLATE_LOCKED);
    await expectStatus(x.plates.deletePlate(stand.id), 409, PLATE_LOCKED);
    await expectStatus(x.plates.queueOne(stand.id, {}), 409, PLATE_LOCKED);
    // Cancelling its jobs frees the plate again.
    for (const j of x.db.t('productionJob')) j.status = 'CANCELLED';
    expect(await x.plates.deletePlate(stand.id)).toEqual({ deleted: true });
  });

  it('every write takes the order\'s plan lock and refuses an order that cannot be planned', async () => {
    const { x, o } = await setup();
    await x.plates.createPlate(o.id, { kind: 'MIXED', printerId: K1, items: [{ rowKey: o.key('dress'), units: 2 }] });
    expect(x.db.$queryRaw.mock.calls.some(([sql]: any[]) => /plan:advisory/.test(sql?.sql ?? ''))).toBe(true);
    x.db.t('order').find((r: any) => r.id === o.id).status = 'CANCELLED';
    await expectStatus(x.plates.createPlate(o.id, { kind: 'MIXED', printerId: K1, items: [{ rowKey: o.key('dress'), units: 1 }] }), 409, 'This order is cancelled');
    await expectStatus(x.plates.queueAll(o.id, {}), 409);
  });
});

describe('files are read before the plan lock, never inside the transaction', () => {
  it('suggest, a new plate and create-jobs open no model or plate file while the transaction is open', async () => {
    const { x, o } = await setup();
    let inTx = false;
    const readsInTx: string[] = [];
    const realTx = x.db.$transaction;
    x.db.$transaction = jest.fn(async (arg: any, opts?: any) => {
      if (Array.isArray(arg)) return realTx(arg, opts);
      return realTx(async (tx: any) => {
        inTx = true;
        try { return await arg(tx); } finally { inTx = false; }
      }, opts);
    });
    // Every place the module opens a part's file: the three readers of the needs service.
    const readers = ['stlFootprint', 'slicedFootprint', 'fileOutlines'] as const;
    const calls: string[] = [];
    for (const name of readers) {
      const real = (x.needs as any)[name].bind(x.needs);
      jest.spyOn(x.needs as any, name).mockImplementation((...args: any[]) => {
        calls.push(name);
        if (inTx) readsInTx.push(name);
        return real(...args);
      });
    }
    const plan = await x.plates.suggest(o.id, {});
    // The files were read all the same: footprints sized the plates, and the existing file has its drawing.
    expect(calls).toEqual(expect.arrayContaining([...readers]));
    expect(plateOf(plan, 'stand').preview).toMatchObject({ exact: true });
    expect(plateOf(plan, 'dress').preview.objects.length).toBeGreaterThan(0);
    await x.plates.createPlate(o.id, { kind: 'LAYOUT', layoutId: 'stand10', items: [{ rowKey: o.key('stand'), units: 1 }] });
    await x.plates.updatePlate(x.platesOf(o.id)[0].id, { items: [{ rowKey: o.key('face'), units: 2 }] });
    await x.plates.queueAll(o.id, {});
    await x.jobs.createJobs(o.id, {});
    expect(readsInTx).toEqual([]);
  });

  it('a model that cannot be read is unknown for the request (40 x 40 mm in the plan), not an error', async () => {
    const { x, o } = await setup();
    const dress = x.db.t('attachment').find((a: any) => a.id === x.comp('dress').sourceAttachmentId);
    fs.unlinkSync(path.join(dirOf(), dress.storagePath));
    const analyze = jest.spyOn(x.stlReader, 'analyze');
    const plan = await x.plates.suggest(o.id, {});
    expect(plateOf(plan, 'dress').items.find((i: any) => i.componentDescription === 'dress').units).toBe(6);
    // hat and shoe were read once each in the request; the missing dress never reached the reader.
    expect(analyze.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe('the slice queue', () => {
  it('"Slice all" queues every DRAFT or FAILED plate that has something to slice', async () => {
    const { x, o } = await setup();
    await x.plates.suggest(o.id, {});
    const [face, stand, black, white] = x.platesOf(o.id);
    Object.assign(black, { status: 'FAILED', error: 'The slicer stopped with an error', errorDetail: 'log' });
    expect(await x.plates.queueAll(o.id, {})).toEqual({ queued: 3 });
    expect([face, stand, black, white].map((p) => p.status)).toEqual(['QUEUED', 'DONE', 'QUEUED', 'QUEUED']);
    expect(black).toMatchObject({ error: null, errorDetail: null });
    // Its place in the queue is when it was queued.
    for (const p of [face, black, white]) expect(p.queuedAt).toBeInstanceOf(Date);
    expect(stand.queuedAt ?? null).toBeNull();
    expect(x.gateway.server.emit).toHaveBeenCalledWith('order-plate', { id: face.id, orderId: o.id, status: 'QUEUED', error: null });
    expect(await x.plates.queueAll(o.id, {})).toEqual({ queued: 0 });
  });

  it('one plate: queued once; an existing file has nothing to slice', async () => {
    const { x, o } = await setup();
    await x.plates.suggest(o.id, {});
    const [face, stand] = x.platesOf(o.id);
    expect(await x.plates.queueOne(face.id, {})).toMatchObject({ id: face.id, status: 'QUEUED' });
    await expectStatus(x.plates.queueOne(face.id, {}), 409, 'already waiting for the slicer');
    await expectStatus(x.plates.queueOne(stand.id, {}), 400, 'there is nothing to slice');
    await expectStatus(x.plates.queueOne('nope', {}), 404);
    await expectStatus(x.plates.queueOne(face.id, { force: true }), 400);
  });
});

describe('files', () => {
  it('a plate downloads under the name its jobs carry; a plate without a file says so', async () => {
    const { x, o } = await setup();
    await x.plates.suggest(o.id, {});
    const [face, stand] = x.platesOf(o.id);
    const f = await x.plates.file(stand.id);
    expect(f.filename).toBe('stand x10.gcode');
    expect(fs.existsSync(f.abs)).toBe(true);
    expect(f.abs.startsWith(dirOf())).toBe(true);
    await expectStatus(x.plates.file(face.id), 404, 'This plate has no file yet — slice it first');
    expect((await x.plates.files(o.id)).entries.map((e) => e.filename)).toEqual(['stand x10.gcode']);
    await expectStatus(x.plates.files(x.order(1).id), 404, 'No plate of this order has a file yet');
  });

  it('a plate that prints one of the part\'s plate files serves the file that plate has NOW, never "slice it again"', async () => {
    const { x, o } = await setup();
    await x.plates.suggest(o.id, {});
    const stand = x.platesOf(o.id)[1];
    const layout = x.db.t('plateLayout').find((l: any) => l.id === 'stand10');
    const old = layout.attachmentId;
    // The file is replaced on the product page: the old Attachment row is gone.
    const fresh = await x.addFile(mixedGcode([10]), 'gcode');
    Object.assign(layout, { attachmentId: fresh.id, gcodeFilename: 'stand x10 v2.gcode' });
    x.db.t('attachment').splice(x.db.t('attachment').findIndex((a: any) => a.id === old), 1);

    const f = await x.plates.file(stand.id);
    expect(f.filename).toBe('stand x10 v2.gcode');
    expect(f.abs).toBe(path.join(dirOf(), fresh.storagePath));
    expect(plateOf(await x.plates.getPlan(o.id), 'stand')).toMatchObject({ hasFile: true, gcodeFilename: 'stand x10 v2.gcode' });
    expect((await x.plates.files(o.id)).entries).toEqual([{ abs: f.abs, filename: 'stand x10 v2.gcode' }]);
    // The job made from it carries that same file.
    await x.jobs.createJobs(o.id, {});
    expect(x.db.t('jobPlate')[0]).toMatchObject({ attachmentId: fresh.id, gcodeFilename: 'stand x10 v2.gcode' });

    // Removed and not replaced: say where to fix it.
    Object.assign(layout, { attachmentId: null, gcodeFilename: null });
    await expectStatus(x.plates.file(stand.id), 404, 'This plate of the part has no file any more — upload one on the product page');
  });

  it('names inside the zip are flat and distinct', async () => {
    const { x, o } = await setup(25);
    const layout = x.db.t('plateLayout').find((l: any) => l.id === 'stand10');
    layout.gcodeFilename = '../../stand.gcode';
    const a = await x.plates.createPlate(o.id, { kind: 'LAYOUT', layoutId: 'stand10', items: [{ rowKey: o.key('stand'), units: 1 }] });
    const b = await x.plates.createPlate(o.id, { kind: 'MIXED', printerId: K1, items: [{ rowKey: o.key('dress'), units: 1 }] });
    const other = await x.addFile(mixedGcode([1]), 'gcode', { entityType: 'order-plate', entityId: b.id });
    Object.assign(x.plate(b.id), { status: 'DONE', attachmentId: other.id, gcodeFilename: 'stand.gcode' });
    expect(a.hasFile).toBe(true);
    expect((await x.plates.files(o.id)).entries.map((e) => e.filename)).toEqual(['stand.gcode', 'stand (2).gcode']);
  });
});
