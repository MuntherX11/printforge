import * as fs from 'fs';
import * as path from 'path';
import { RUN_TIMEOUT_MS } from '../slice/slice.processor';
import { useTempUploadDir } from '../slice/__fixtures__/slice-harness';
import { HI, K1, M, mixedGcode, orderPlatesHarness, type OrderPlatesHarness } from './__fixtures__/order-plates-harness';
import { plateFileName } from './order-plate-view';

/**
 * Slicing the plates of an order (v2.19.0): they wait in the same queue as the
 * product page's slice runs, are checked again when claimed, and keep what the
 * sliced file says.
 */

const dirOf = useTempUploadDir();

async function setup(quantity = 6) {
  const x = orderPlatesHarness();
  await x.seedFiles();
  const o = x.order(quantity);
  return { x, o };
}
/** A queued MIXED plate of dresses and hats on the K1. */
async function mixed(x: OrderPlatesHarness, o: ReturnType<OrderPlatesHarness['order']>, dress = 4, hat = 2) {
  const p = await x.plates.createPlate(o.id, { kind: 'MIXED', printerId: K1, items: [{ rowKey: o.key('dress'), units: dress }, { rowKey: o.key('hat'), units: hat }] });
  await x.plates.queueOne(p.id, {});
  return x.plate(p.id);
}
const filesOnDisk = (dir: string): string[] => fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.gcode'));

describe('one queue for slice runs and order plates', () => {
  it('a tick claims the oldest QUEUED row of either table, one per tick', async () => {
    const { x, o } = await setup();
    x.slicer.onModuleInit();
    const runSpy = jest.spyOn(x.processor, 'run').mockResolvedValue();
    const plateSpy = jest.spyOn(x.slicer, 'run').mockResolvedValue();
    // A plate waits since it was QUEUED, not since it was made: `last` is the older plate, queued later.
    const last = await mixed(x, o, 1, 1);
    const first = await mixed(x, o);
    expect(first.queuedAt).toBeInstanceOf(Date);
    first.queuedAt = new Date(1_700_000_000_000);
    const run = x.db.insert('sliceRun', { componentId: 'dress', printerId: K1, unitsRequested: 3, filamentMap: {}, status: 'QUEUED', createdAt: new Date(1_700_000_001_000) });
    last.queuedAt = new Date(1_700_000_002_000);
    expect(+last.createdAt).toBeLessThanOrEqual(+first.createdAt);

    await x.processor.tick();
    expect(plateSpy.mock.calls).toEqual([[first.id]]);
    expect(first.status).toBe('RUNNING');
    expect([run.status, last.status]).toEqual(['QUEUED', 'QUEUED']);
    await x.processor.tick();
    expect(runSpy.mock.calls).toEqual([[run.id]]);
    await x.processor.tick();
    expect(plateSpy.mock.calls).toEqual([[first.id], [last.id]]);
    await x.processor.tick();
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(plateSpy).toHaveBeenCalledTimes(2);
  });

  it('a failure on the plate side never stops slice runs from being claimed', async () => {
    const { x, o } = await setup();
    x.slicer.onModuleInit();
    const runSpy = jest.spyOn(x.processor, 'run').mockResolvedValue();
    await mixed(x, o);
    const run = () => x.db.insert('sliceRun', { componentId: 'dress', printerId: K1, unitsRequested: 3, filamentMap: {}, status: 'QUEUED', createdAt: new Date() });

    // The plate table cannot be read (say the schema is not pushed yet).
    const a = run();
    jest.spyOn(x.slicer, 'reap').mockRejectedValueOnce(new Error('relation "OrderPlate" does not exist'));
    x.db.orderPlate.findFirst = jest.fn(async () => { throw new Error('relation "OrderPlate" does not exist'); });
    await x.processor.tick();
    expect(runSpy.mock.calls).toEqual([[a.id]]);

    // The plate's own run blows up: the tick ends cleanly and the next one works.
    x.db.orderPlate.findFirst = jest.fn(async () => ({ queuedAt: new Date(0), createdAt: new Date(0) }));
    jest.spyOn(x.slicer, 'run').mockRejectedValueOnce(new Error('boom'));
    await expect(x.processor.tick()).resolves.toBeUndefined();
    const b = run();
    x.db.orderPlate.findFirst = jest.fn(async () => null);
    await x.processor.tick();
    expect(runSpy.mock.calls).toEqual([[a.id], [b.id]]);
  });

  it('plates are not claimed before the order-plates module has joined the queue', async () => {
    const { x, o } = await setup();
    const p = await mixed(x, o);
    await x.processor.tick();
    expect(p.status).toBe('QUEUED');
  });

  it('boot re-queue and the 10-minute reaper cover plates too', async () => {
    const { x, o } = await setup();
    const stale = await mixed(x, o);
    Object.assign(stale, { status: 'RUNNING', startedAt: new Date(Date.now() - 60_000) });
    await x.slicer.onModuleInit();
    expect(stale).toMatchObject({ status: 'QUEUED', startedAt: null });

    Object.assign(stale, { status: 'RUNNING', startedAt: new Date(Date.now() - RUN_TIMEOUT_MS - 1000) });
    const live = await mixed(x, o, 1, 1);
    Object.assign(live, { status: 'RUNNING', startedAt: new Date() });
    await x.processor.tick();
    expect(stale).toMatchObject({ status: 'FAILED', error: 'The slicer did not finish in 10 minutes — try fewer units on this plate' });
    expect(live.status).toBe('RUNNING');
    expect(x.gateway.server.emit).toHaveBeenCalledWith('order-plate', { id: stale.id, orderId: o.id, status: 'FAILED', error: stale.error });
  });
});

describe('a MIXED plate', () => {
  it('sends its models with the printer\'s process and one filament, and keeps what the file says', async () => {
    const { x, o } = await setup();
    x.slicer.onModuleInit();
    x.db.insert('slicerProfile', { kind: 'MACHINE', name: 'Creality K1 0.4 nozzle', json: { name: 'Creality K1 0.4 nozzle' } });
    x.db.t('material').find((m: any) => m.id === M.black).density = 1.27;
    const p = await mixed(x, o);
    x.ok(mixedGcode([4, 2], { minutes: 140, grams: 28 }), [4, 2]);
    await x.processor.tick();

    const src = (id: string) => x.db.t('attachment').find((a: any) => a.id === x.comp(id).sourceAttachmentId).storagePath;
    expect(x.sidecar.slice).toHaveBeenCalledWith({
      inputs: [{ inputPath: src('dress'), kind: 'stl', copies: 4 }, { inputPath: src('hat'), kind: 'stl', copies: 2 }],
      machine: { raw: expect.objectContaining({ name: 'Creality K1 0.4 nozzle' }) }, process: { raw: { name: '0.20mm Standard' } },
      filaments: [{ raw: { name: 'Generic PLA' }, density: '1.27' }],
      siblings: [{ raw: { name: 'Creality K1 0.4 nozzle' } }],
    });
    const name = plateFileName(o.number, 'Plate 1 · K1', p.id);
    expect(name).toMatch(new RegExp(`^${o.number} Plate 1 K1 [a-z0-9]{1,5}\\.gcode$`));
    expect(p).toMatchObject({ status: 'DONE', minutes: 140, grams: 28, error: null, gcodeFilename: name });
    // Shares by each part's own per-unit numbers: dress 4 x 30 min / 6 g, hat 2 x 10 min / 2 g.
    expect(p.items).toEqual([
      expect.objectContaining({ rowKey: o.key('dress'), units: 4, unitsSliced: 4, minutes: 120, grams: 24 }),
      expect.objectContaining({ rowKey: o.key('hat'), units: 2, unitsSliced: 2, minutes: 20, grams: 4 }),
    ]);
    const att = x.db.t('attachment').find((a: any) => a.id === p.attachmentId);
    expect(att).toMatchObject({ entityType: 'order-plate', entityId: p.id, originalName: p.gcodeFilename, mimeType: 'application/octet-stream' });
    expect(fs.existsSync(path.join(dirOf(), att.storagePath))).toBe(true);
    expect(p.preview).toMatchObject({ exact: true, bed: { x: 220, y: 220 }, overflow: 0 });
    expect(p.preview.objects.map((ob: any) => ob.rowKey)).toEqual([...Array(4).fill(o.key('dress')), ...Array(2).fill(o.key('hat'))]);
    expect(x.gateway.server.emit.mock.calls.filter(([ev]: any[]) => ev === 'order-plate').map(([, e]: any[]) => e.status)).toEqual(['QUEUED', 'RUNNING', 'DONE']);

    const dto = (await x.plates.getPlan(o.id)).plates[0];
    expect(dto).toMatchObject({ status: 'DONE', hasFile: true, minutes: 140, grams: 28, items: [{ unitsSliced: 4, minutes: 120 }, { unitsSliced: 2, minutes: 20 }] });
    expect((await x.plates.file(p.id)).filename).toBe(name);
  });

  it('a one-slot project on a mixed plate gives only its shape', async () => {
    const { x, o } = await setup();
    x.slicer.onModuleInit();
    const made = await x.plates.createPlate(o.id, { kind: 'MIXED', printerId: K1, items: [{ rowKey: o.key('badge'), units: 3 }] });
    await x.plates.queueOne(made.id, {});
    x.ok(mixedGcode([3]), [3]);
    await x.processor.tick();
    const req = x.sidecar.slice.mock.calls[0][0];
    expect(req.inputs).toEqual([expect.objectContaining({ kind: '3mf', copies: 3 })]);
    expect(req.process).toEqual({ raw: { name: '0.20mm Standard' } });
    expect(x.plate(made.id)).toMatchObject({ status: 'DONE', items: [expect.objectContaining({ unitsSliced: 3 })] });
  });

  it('too full: the plate is DONE with what was really placed, and the plan says what still needs a plate', async () => {
    const { x, o } = await setup(40);
    x.slicer.onModuleInit();
    const p = await mixed(x, o, 40, 40);
    x.ok(mixedGcode([16, 0], { minutes: 480, grams: 96 }), [16, 0]);
    await x.processor.tick();
    expect(p.status).toBe('DONE');
    expect(p.items).toEqual([
      expect.objectContaining({ units: 40, unitsSliced: 16, minutes: 480, grams: 96 }),
      expect.objectContaining({ units: 40, unitsSliced: 0, minutes: 0, grams: 0 }),
    ]);
    const plan = await x.plates.getPlan(o.id);
    expect(plan.needs.slice(0, 2).map((n) => [n.componentDescription, n.toProduce, n.planned])).toEqual([['dress', 40, 16], ['hat', 40, 0]]);
    expect(plan.warnings.filter((w) => w.plateId === p.id || w.rowKey === o.key('dress') || w.rowKey === o.key('hat'))).toEqual([
      { code: 'PLATE_TOO_FULL', plateId: p.id, rowKey: o.key('dress'), message: 'Plate 1 · K1 holds 16 of 40 dress — 24 still need a plate' },
      { code: 'PLATE_TOO_FULL', plateId: p.id, rowKey: o.key('hat'), message: 'Plate 1 · K1 holds 0 of 40 hat — 40 still need a plate' },
      { code: 'SHORT', rowKey: o.key('dress'), message: 'dress: 24 of 40 still need a plate' },
      { code: 'SHORT', rowKey: o.key('hat'), message: 'hat: 40 of 40 still need a plate' },
    ]);
  });

  it('counts are never guessed: without the slicer\'s units per part a plate of several parts fails; one part reads its labels', async () => {
    const { x, o } = await setup();
    x.slicer.onModuleInit();
    const two = await mixed(x, o);
    const before = filesOnDisk(dirOf()).length;
    x.ok(mixedGcode([4, 2]), null);
    await x.processor.tick();
    expect(two).toMatchObject({ status: 'FAILED', error: 'The slicer did not say how many of each part it placed — update the slicer container, then slice again', attachmentId: null });
    expect(filesOnDisk(dirOf()).length).toBe(before);

    const one = await x.plates.createPlate(o.id, { kind: 'MIXED', printerId: K1, items: [{ rowKey: o.key('dress'), units: 5 }] });
    await x.plates.queueOne(one.id, {});
    x.ok(mixedGcode([3]), undefined);
    await x.processor.tick();
    expect(x.plate(one.id)).toMatchObject({ status: 'DONE', items: [expect.objectContaining({ units: 5, unitsSliced: 3 })] });
  });
});

describe('a PROJECT plate', () => {
  it('sends the project alone with its own settings and a filament per slot; units are labels over bodies per unit', async () => {
    const { x, o } = await setup();
    x.slicer.onModuleInit();
    // The face's 1-unit validation run showed 2 bodies per unit.
    x.db.insert('sliceRun', { componentId: 'face', printerId: HI, unitsRequested: 1, unitsSliced: 2, status: 'DONE', filamentMap: {}, finishedAt: new Date() });
    const made = await x.plates.createPlate(o.id, { kind: 'PROJECT', items: [{ rowKey: o.key('face'), units: 6 }] });
    await x.plates.queueOne(made.id, {});
    x.ok(mixedGcode([8], { minutes: 90, grams: 17, toolGrams: [12, 5], name: (_k, n) => `face_body_id_${n}_copy_0` }));
    await x.processor.tick();

    const req = x.sidecar.slice.mock.calls[0][0];
    expect(req).toMatchObject({ kind: '3mf', copies: 6, filaments: [{ density: '1.24' }, { density: '1.24' }], machine: { raw: expect.objectContaining({ name: 'Creality Hi 0.4 nozzle' }) } });
    expect(req.process).toBeUndefined();
    expect(req.inputs).toBeUndefined();
    const p = x.plate(made.id);
    expect(p).toMatchObject({ status: 'DONE', minutes: 90, grams: 17, gcodeFilename: plateFileName(o.number, 'Plate 1 · Hi', p.id) });
    expect(p.items).toEqual([expect.objectContaining({ units: 6, unitsSliced: 4, minutes: 90, grams: 17, slotGrams: { '0': 12, '1': 5 } })]);
    expect(p.preview.objects.every((ob: any) => ob.rowKey === o.key('face'))).toBe(true);
    expect(p.preview.bed).toEqual({ x: 220, y: 220 }); // the bed the file names
  });
});

describe('failures are one plain sentence', () => {
  it('the slicer is unreachable, or crashed on one part: the part is named and the raw output kept', async () => {
    const { x, o } = await setup();
    x.slicer.onModuleInit();
    const a = await mixed(x, o);
    await x.processor.tick();
    expect(a).toMatchObject({ status: 'FAILED', error: 'The slicer container is unreachable', errorDetail: null });
    expect(x.gateway.server.emit).toHaveBeenCalledWith('order-plate', { id: a.id, orderId: o.id, status: 'FAILED', error: 'The slicer container is unreachable' });

    await x.plates.queueOne(a.id, {});
    x.sidecar.slice.mockResolvedValue({ ok: false, code: 'SLICER_FAILED', message: 'orca-slicer exited with code 253', exitCode: 253, logTail: 'bad mesh', input: 1 });
    await x.processor.tick();
    expect(a).toMatchObject({ status: 'FAILED', error: '"hat": The model file could not be read', errorDetail: 'orca-slicer exited with code 253\nbad mesh' });
  });

  it('the plate is checked again when claimed: a model gone from disk, a filament without a preset, a printer without a profile', async () => {
    const { x, o } = await setup();
    x.slicer.onModuleInit();
    const a = await mixed(x, o);
    const hat = x.db.t('attachment').find((f: any) => f.id === x.comp('hat').sourceAttachmentId);
    fs.unlinkSync(path.join(dirOf(), hat.storagePath));
    await x.processor.tick();
    expect(a.error).toBe('The model of "hat" is missing on disk — upload it again on the product page');

    x.profiles.filaments.delete(M.black);
    const b = await x.plates.createPlate(o.id, { kind: 'MIXED', printerId: K1, items: [{ rowKey: o.key('shoe'), units: 1 }] });
    await x.plates.queueOne(b.id, {});
    x.profiles.filaments.delete(M.white);
    await x.processor.tick();
    expect(x.plate(b.id)).toMatchObject({ status: 'FAILED', error: expect.stringContaining('"PLA White" has no slicer preset') });

    x.profiles.filaments.set(M.white, { name: 'Generic PLA' });
    const c = await x.plates.createPlate(o.id, { kind: 'PROJECT', items: [{ rowKey: o.key('face'), units: 1 }] });
    await x.plates.queueOne(c.id, {});
    x.profiles.machines.delete(HI);
    await x.processor.tick();
    expect(x.plate(c.id)).toMatchObject({ status: 'FAILED', error: 'Hi has no machine profile — import one in Settings › Slicer' });
    expect(x.sidecar.slice).not.toHaveBeenCalled();
  });

  it('a sliced file without objects, time or weight fails with nothing stored', async () => {
    const { x, o } = await setup();
    x.slicer.onModuleInit();
    const a = await mixed(x, o);
    x.ok(mixedGcode([0, 0]), [0, 0]);
    await x.processor.tick();
    expect(a).toMatchObject({ status: 'FAILED', error: 'The slicer placed nothing on the plate — the parts may be larger than the bed', attachmentId: null });
    await x.plates.queueOne(a.id, {});
    x.ok(mixedGcode([4, 2], { minutes: 0 }), [4, 2]);
    await x.processor.tick();
    expect(a.error).toBe('No print time was found in the sliced file');
    expect(x.db.t('attachment').filter((f: any) => f.entityType === 'order-plate')).toEqual([]);
  });
});

describe('a plate that changed while it was being sliced', () => {
  it('deleted or replaced meanwhile: nothing is kept, the file is removed again', async () => {
    const { x, o } = await setup();
    x.slicer.onModuleInit();
    const p = await mixed(x, o);
    x.sidecar.slice.mockImplementation(async () => {
      // "Reset to suggestion" replaces the plate while the slicer works.
      x.db.t('orderPlate').splice(x.db.t('orderPlate').indexOf(p), 1);
      return { ok: true, gcode: mixedGcode([4, 2]), plateFiles: 1, inputUnits: [4, 2] };
    });
    const before = filesOnDisk(dirOf()).length;
    await x.processor.tick();
    expect(x.db.t('attachment').filter((f: any) => f.entityType === 'order-plate')).toEqual([]);
    expect(filesOnDisk(dirOf()).length).toBe(before);
    expect(x.gateway.server.emit.mock.calls.filter(([ev, e]: any[]) => ev === 'order-plate' && e.status === 'DONE')).toEqual([]);
  });

  it('edited and queued again while the old run was still slicing: the new run never receives the old file', async () => {
    const { x, o } = await setup();
    x.slicer.onModuleInit();
    const p = await mixed(x, o);
    const before = filesOnDisk(dirOf()).length;
    x.sidecar.slice.mockImplementationOnce(async () => {
      // The reaper gave the old run up; staff changed the plate, queued it, and another tick claimed it.
      Object.assign(p, { status: 'RUNNING', startedAt: new Date(Date.now() + 5_000), items: [{ ...p.items[0], units: 9 }] });
      return { ok: true, gcode: mixedGcode([4, 2]), plateFiles: 1, inputUnits: [4, 2] };
    });
    await x.processor.tick();
    expect(p).toMatchObject({ status: 'RUNNING', attachmentId: null, minutes: null });
    expect(p.items).toEqual([expect.objectContaining({ units: 9, unitsSliced: null })]);
    expect(x.db.t('attachment').filter((f: any) => f.entityType === 'order-plate')).toEqual([]);
    expect(filesOnDisk(dirOf()).length).toBe(before);

    // And a failure of the old run does not mark the new one FAILED either.
    const q = await mixed(x, o, 1, 1);
    x.sidecar.slice.mockImplementationOnce(async () => {
      q.startedAt = new Date(Date.now() + 5_000);
      return { ok: false, code: 'SLICER_FAILED', message: 'crash', exitCode: 1, logTail: '' };
    });
    await x.processor.tick();
    expect(q).toMatchObject({ status: 'RUNNING', error: null });
  });

  it('a plate number can come back after a delete; the stored file name cannot', async () => {
    const { x, o } = await setup();
    x.slicer.onModuleInit();
    const a = await mixed(x, o);
    x.ok(mixedGcode([4, 2]), [4, 2]);
    await x.processor.tick();
    const firstName = a.gcodeFilename;
    await x.plates.deletePlate(a.id);
    const b = await mixed(x, o);
    await x.processor.tick();
    expect((await x.plates.getPlan(o.id)).plates[0].label).toBe('Plate 1 · K1');
    expect(b.gcodeFilename).not.toBe(firstName);
    expect(b.gcodeFilename).toMatch(/^[\x20-\x7e]+\.gcode$/);
  });

  it('reaped as timed out before the answer came: it stays FAILED', async () => {
    const { x, o } = await setup();
    x.slicer.onModuleInit();
    const p = await mixed(x, o);
    x.sidecar.slice.mockImplementation(async () => {
      Object.assign(p, { status: 'FAILED', error: 'timed out' });
      return { ok: true, gcode: mixedGcode([4, 2]), plateFiles: 1, inputUnits: [4, 2] };
    });
    await x.processor.tick();
    expect(p).toMatchObject({ status: 'FAILED', error: 'timed out', attachmentId: null });
  });
});
