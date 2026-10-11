import * as fs from 'fs';
import * as path from 'path';
import { gcode, labels } from '../products/__fixtures__/slicer-files';
import { HI, K1, M, P, sliceHarness, stl, useTempUploadDir, type SliceHarness } from './__fixtures__/slice-harness';
import { RUN_TIMEOUT_MS } from './slice.processor';

/**
 * Slicer plan WP5: the processor claims one run per tick, re-validates it,
 * turns the sidecar's G-code into a SLICED layout (or the part's ×1 file),
 * applies the replacement key, reaps stuck runs and re-queues after a restart.
 */

const dirOf = useTempUploadDir();

const PLA_MAP = { '0': { materialId: M.black, name: 'PLA Black', type: 'PLA' } };
const plate = (n: number, o: Record<string, unknown> = {}) => gcode({ labels: labels('box', n), minutes: 240, totalGrams: 120, toolGrams: [120], types: ['PLA'], ...o });

function queue(x: SliceHarness, o: Record<string, unknown> = {}) {
  return x.db.insert('sliceRun', { componentId: 'c1', printerId: K1, unitsRequested: 12, filamentMap: PLA_MAP, status: 'QUEUED', createdAt: new Date(), ...o });
}

const ok = (x: SliceHarness, buf: Buffer) => x.sidecar.slice.mockResolvedValue({ ok: true, gcode: buf, plateFiles: 1 });
const layoutsOf = (x: SliceHarness, cid = 'c1') => x.db.t('plateLayout').filter((l: any) => l.componentId === cid);
const slotsOf = (x: SliceHarness, layoutId: string) => x.db.t('plateLayoutSlot').filter((s: any) => s.layoutId === layoutId).sort((a: any, b: any) => a.colorIndex - b.colorIndex);

describe('claiming', () => {
  it('one run per tick, oldest first; a tick with nothing queued does nothing', async () => {
    const x = sliceHarness();
    await x.seedSource('c1', 'STL');
    ok(x, plate(12));
    const a = queue(x, { createdAt: new Date(1_700_000_000_000) });
    const b = queue(x, { unitsRequested: 13, createdAt: new Date(1_700_000_001_000) });
    await x.processor.tick();
    expect(x.run(a.id).status).toBe('DONE');
    expect(x.run(b.id).status).toBe('QUEUED');
    expect(x.sidecar.slice).toHaveBeenCalledTimes(1);
    await x.processor.tick();
    expect(x.run(b.id).status).toBe('DONE');
    await x.processor.tick();
    expect(x.sidecar.slice).toHaveBeenCalledTimes(2);
  });

  it('boot re-queue: a RUNNING run from before this process started goes back to QUEUED', async () => {
    const x = sliceHarness();
    const stale = queue(x, { status: 'RUNNING', startedAt: new Date(Date.now() - 60_000) });
    const fresh = queue(x, { status: 'RUNNING', startedAt: new Date(Date.now() + 60_000) });
    await x.processor.onModuleInit();
    expect(x.run(stale.id)).toMatchObject({ status: 'QUEUED', startedAt: null });
    expect(x.run(fresh.id).status).toBe('RUNNING');
  });

  it('reaper: RUNNING for over 10 minutes → FAILED TIMED_OUT, broadcast', async () => {
    const x = sliceHarness();
    const stuck = queue(x, { status: 'RUNNING', startedAt: new Date(Date.now() - RUN_TIMEOUT_MS - 1000) });
    const live = queue(x, { status: 'RUNNING', startedAt: new Date(Date.now() - 1000) });
    await x.processor.tick();
    expect(x.run(stuck.id)).toMatchObject({ status: 'FAILED', error: expect.stringContaining('TIMED_OUT') });
    expect(x.run(live.id).status).toBe('RUNNING');
    expect(x.gateway.server.emit).toHaveBeenCalledWith('slice-run', expect.objectContaining({ id: stuck.id, status: 'FAILED', productId: P, error: 'TIMED_OUT' }));
  });
});

describe('re-validation at claim', () => {
  it('a filament merged away since queueing → FAILED naming the slot; the sidecar is never called', async () => {
    const x = sliceHarness();
    await x.seedSource('c1', 'STL');
    const r = queue(x, { filamentMap: { '0': { materialId: 'm-merged', name: 'Old Black', type: 'PLA' } } });
    await x.processor.tick();
    expect(x.run(r.id)).toMatchObject({ status: 'FAILED', error: 'SLOT_UNMAPPED: Slot 1: "Old Black" no longer exists (merged or deleted)' });
    expect(x.sidecar.slice).not.toHaveBeenCalled();
  });

  it('source file gone from disk, printer inactive, profile unmapped → FAILED with the reason', async () => {
    const x = sliceHarness();
    const att = await x.seedSource('c1', 'STL');
    fs.unlinkSync(path.join(dirOf(), att.storagePath));
    const r1 = queue(x);
    await x.processor.tick();
    expect(x.run(r1.id)).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/^NO_SOURCE: .*missing on disk/) });

    await x.seedSource('c1', 'STL');
    x.db.t('printer').find((p: any) => p.id === K1).isActive = false;
    const r2 = queue(x);
    await x.processor.tick();
    expect(x.run(r2.id).error).toMatch(/^NO_MACHINE_PROFILE/);

    x.db.t('printer').find((p: any) => p.id === K1).isActive = true;
    x.profiles.filaments.delete(M.black);
    const r3 = queue(x);
    await x.processor.tick();
    expect(x.run(r3.id).error).toBe('NO_FILAMENT_PROFILE: "PLA Black" has no filament profile');
  });
});

describe('the sidecar call', () => {
  it('sends the source path, kind, copies, raw presets with density per slot and every preset as a sibling', async () => {
    const x = sliceHarness();
    const att = await x.seedSource('c1', 'STL');
    x.db.insert('slicerProfile', { kind: 'MACHINE', name: 'Creality K1 0.4 nozzle', json: { name: 'Creality K1 0.4 nozzle', inherits: 'fdm_creality_common' } });
    x.db.t('material').find((m: any) => m.id === M.black).density = 1.27;
    ok(x, plate(12));
    queue(x);
    await x.processor.tick();
    expect(x.sidecar.slice).toHaveBeenCalledWith({
      inputPath: att.storagePath, kind: 'stl', copies: 12,
      machine: { raw: expect.objectContaining({ name: 'Creality K1 0.4 nozzle' }) }, process: { raw: { name: '0.20mm Standard' } },
      filaments: [{ raw: { name: 'Generic PLA' }, density: '1.27' }],
      siblings: [{ raw: { name: 'Creality K1 0.4 nozzle', inherits: 'fdm_creality_common' } }],
    });
  });

  it('a project sends no process (the 3MF carries its own)', async () => {
    const x = sliceHarness();
    await x.seedSource('c1', 'THREEMF', stl(), { printerModel: 'Creality Hi', printerId: HI, slots: [{ colorIndex: 0, profile: null, colorHex: null, materialId: M.black }] });
    ok(x, plate(12));
    queue(x, { printerId: HI });
    await x.processor.tick();
    const req = x.sidecar.slice.mock.calls[0][0];
    expect(req).toMatchObject({ kind: '3mf', copies: 12 });
    expect(req.process).toBeUndefined();
  });

  it('sidecar unreachable → FAILED SLICER_UNAVAILABLE; Orca crash → FAILED with the log tail; a plate without labels → NO_OBJECTS', async () => {
    const x = sliceHarness();
    await x.seedSource('c1', 'STL');
    const r1 = queue(x);
    await x.processor.tick();
    expect(x.run(r1.id)).toMatchObject({ status: 'FAILED', error: 'SLICER_UNAVAILABLE: no stub' });
    expect(x.gateway.server.emit).toHaveBeenCalledWith('slice-run', expect.objectContaining({ id: r1.id, status: 'FAILED', componentId: 'c1' }));

    x.sidecar.slice.mockResolvedValue({ ok: false, code: 'SLICER_FAILED', message: 'orca-slicer exited with code 255', exitCode: 255, logTail: 'a\nb\nassert failed' });
    const r2 = queue(x);
    await x.processor.tick();
    expect(x.run(r2.id).error).toBe('SLICER_FAILED: orca-slicer exited with code 255 — a | b | assert failed');

    ok(x, gcode({ minutes: 240, totalGrams: 120 }));
    const r3 = queue(x);
    await x.processor.tick();
    expect(x.run(r3.id).error).toMatch(/^NO_OBJECTS/);
    expect(layoutsOf(x)).toHaveLength(1); // only the fixture's hand layout
  });
});

describe('the result', () => {
  it('N units → a SLICED layout named after the count and printer, with the file, the filament and type per slot; run DONE', async () => {
    const x = sliceHarness();
    await x.seedSource('c1', 'STL');
    ok(x, plate(12, { minutes: 243, totalGrams: 112.8, toolGrams: [112.8], changes: 0 }));
    const r = queue(x);
    await x.processor.tick();
    const layout = layoutsOf(x).find((l: any) => l.source === 'SLICED');
    expect(layout).toMatchObject({ name: 'x12 · K1', unitsPerPlate: 12, plateMinutes: 243, plateGrams: 112.8, printerId: K1, objectCount: 12, isActive: true, gcodeFilename: 'Box x12 K1.gcode' });
    expect(slotsOf(x, layout.id)).toEqual([expect.objectContaining({ colorIndex: 0, gramsUsed: 112.8, materialId: M.black, materialType: 'PLA' })]);
    const att = x.db.t('attachment').find((a: any) => a.id === layout.attachmentId);
    expect(att).toMatchObject({ entityType: 'product', entityId: P, mimeType: 'application/octet-stream' });
    expect(fs.existsSync(path.join(dirOf(), att.storagePath))).toBe(true);
    expect(x.run(r.id)).toMatchObject({ status: 'DONE', unitsSliced: 12, resultLayoutId: layout.id, error: null });
    expect(x.run(r.id).finishedAt).toBeInstanceOf(Date);
    expect(x.gateway.server.emit).toHaveBeenCalledWith('slice-run', { id: r.id, componentId: 'c1', productId: P, status: 'DONE', resultLayoutId: layout.id, error: null });
  });

  it('a non-PLA slot puts the type in the name; two slots keep their own grams and types', async () => {
    const x = sliceHarness();
    await x.seedSource('c2', 'STL');
    x.db.t('material').find((m: any) => m.id === M.silver).type = 'PETG';
    ok(x, gcode({ labels: labels('lid', 15), minutes: 260, totalGrams: 90, toolGrams: [80, 10], types: ['PLA', 'PETG'], changes: 14 }));
    queue(x, { componentId: 'c2', unitsRequested: 15, filamentMap: { ...PLA_MAP, '1': { materialId: M.silver, name: 'PETG Silver', type: 'PETG' } } });
    await x.processor.tick();
    const layout = layoutsOf(x, 'c2').find((l: any) => l.source === 'SLICED');
    expect(layout).toMatchObject({ name: 'x15 · K1 · PLA/PETG', colorChanges: 14 });
    expect(slotsOf(x, layout.id)).toEqual([
      expect.objectContaining({ colorIndex: 0, gramsUsed: 80, materialId: M.black, materialType: 'PLA' }),
      expect.objectContaining({ colorIndex: 1, gramsUsed: 10, materialId: M.silver, materialType: 'PETG' }),
    ]);
  });

  it('replacement key: the active SLICED layout with the same part, printer, units and slot types is deactivated — even when its material was merged away; GCODE and MANUAL layouts and other keys stay', async () => {
    const x = sliceHarness();
    await x.seedSource('c1', 'STL');
    const old = x.db.insert('plateLayout', { componentId: 'c1', name: 'x12 · K1', unitsPerPlate: 12, plateMinutes: 200, plateGrams: 100, source: 'SLICED', printerId: K1, isActive: true });
    x.db.insert('plateLayoutSlot', { layoutId: old.id, colorIndex: 0, gramsUsed: 100, materialId: null, materialType: 'PLA' }); // merged material: SetNull
    const otherPrinter = x.db.insert('plateLayout', { componentId: 'c1', name: 'x12 · Hi', unitsPerPlate: 12, plateMinutes: 200, plateGrams: 100, source: 'SLICED', printerId: HI, isActive: true });
    x.db.insert('plateLayoutSlot', { layoutId: otherPrinter.id, colorIndex: 0, gramsUsed: 100, materialId: M.black, materialType: 'PLA' });
    const otherType = x.db.insert('plateLayout', { componentId: 'c1', name: 'x12 · K1 · PETG', unitsPerPlate: 12, plateMinutes: 200, plateGrams: 100, source: 'SLICED', printerId: K1, isActive: true });
    x.db.insert('plateLayoutSlot', { layoutId: otherType.id, colorIndex: 0, gramsUsed: 100, materialId: M.black, materialType: 'PETG' });
    const manual = x.db.insert('plateLayout', { componentId: 'c1', name: '×12 by hand', unitsPerPlate: 12, plateMinutes: 200, plateGrams: 100, source: 'MANUAL', isActive: true });
    ok(x, plate(12));
    queue(x);
    await x.processor.tick();
    const byId = (id: string) => x.db.t('plateLayout').find((l: any) => l.id === id);
    expect(byId(old.id).isActive).toBe(false);
    expect(byId(otherPrinter.id).isActive).toBe(true);
    expect(byId(otherType.id).isActive).toBe(true);
    expect(byId(manual.id).isActive).toBe(true);
    expect(byId('l1')).toMatchObject({ source: 'GCODE', isActive: true });
    expect(layoutsOf(x).filter((l: any) => l.source === 'SLICED' && l.isActive && l.printerId === K1 && l.name === 'x12 · K1')).toHaveLength(1);
  });

  it('the 1-unit validation run becomes the part\'s own file and per-unit numbers (repriced), replacing a hand-uploaded one; no layout', async () => {
    const x = sliceHarness();
    await x.seedSource('c1', 'STL');
    const hand = x.db.insert('attachment', { entityType: 'product', entityId: P, filename: 'hand.gcode', originalName: 'hand.gcode', mimeType: 'application/octet-stream', sizeBytes: 1, storagePath: 'x/hand.gcode' });
    const comp = () => x.db.t('productComponent').find((c: any) => c.id === 'c1');
    Object.assign(comp(), { attachmentId: hand.id, gcodeFilename: 'hand.gcode' });
    const recalc = jest.spyOn(x.h.pricing, 'recalcPricing');
    ok(x, gcode({ labels: labels('box', 1), minutes: 34, totalGrams: 9.4, toolGrams: [9.4] }));
    const r = queue(x, { unitsRequested: 1 });
    await x.processor.tick();
    expect(x.run(r.id)).toMatchObject({ status: 'DONE', unitsSliced: 1, resultLayoutId: null });
    expect(comp()).toMatchObject({ gramsUsed: 9.4, printMinutes: 34, gcodeFilename: 'Box x1 K1.gcode' });
    expect(comp().attachmentId).not.toBe(hand.id);
    expect(x.db.t('attachment').some((a: any) => a.id === hand.id)).toBe(true);
    expect(layoutsOf(x).filter((l: any) => l.source === 'SLICED')).toHaveLength(0);
    expect(recalc).toHaveBeenCalledWith(P);
  });

  it('a multicolour part\'s validation run writes each colour\'s grams', async () => {
    const x = sliceHarness();
    await x.seedSource('c2', 'STL');
    ok(x, gcode({ labels: labels('lid', 1), minutes: 26, totalGrams: 6, toolGrams: [5.2, 0.8] }));
    queue(x, { componentId: 'c2', unitsRequested: 1, filamentMap: { ...PLA_MAP, '1': { materialId: M.silver, name: 'PLA Silver', type: 'PLA' } } });
    await x.processor.tick();
    const mats = x.db.t('componentMaterial').filter((m: any) => m.componentId === 'c2').sort((a: any, b: any) => a.colorIndex - b.colorIndex);
    expect(mats.map((m: any) => m.gramsUsed)).toEqual([5.2, 0.8]);
  });

  it('bodies-per-unit: a project whose validation run labelled 3 bodies counts 12 labels as 4 units', async () => {
    const x = sliceHarness();
    await x.seedSource('c1', 'THREEMF', stl(), { printerModel: 'Creality Hi', printerId: HI, slots: [{ colorIndex: 0, profile: null, colorHex: null, materialId: M.black }] });
    ok(x, gcode({ labels: labels('part', 3), minutes: 30, totalGrams: 9, toolGrams: [9] }));
    const v = queue(x, { printerId: HI, unitsRequested: 1 });
    await x.processor.tick();
    expect(x.run(v.id)).toMatchObject({ status: 'DONE', unitsSliced: 3 });
    ok(x, gcode({ labels: labels('part', 12), minutes: 120, totalGrams: 36, toolGrams: [36] }));
    const r = queue(x, { printerId: HI, unitsRequested: 4 });
    await x.processor.tick();
    expect(x.run(r.id)).toMatchObject({ status: 'DONE', unitsSliced: 4 });
    const layout = layoutsOf(x).find((l: any) => l.source === 'SLICED');
    expect(layout).toMatchObject({ name: 'x4 · Hi', unitsPerPlate: 4, objectCount: 12 });
  });

  it('a crash inside the result step still marks the run FAILED', async () => {
    const x = sliceHarness();
    await x.seedSource('c1', 'STL');
    ok(x, plate(12));
    jest.spyOn(x.processor['layouts'], 'createSliced').mockRejectedValue(new Error('disk full'));
    const r = queue(x);
    await x.processor.tick();
    expect(x.run(r.id)).toMatchObject({ status: 'FAILED', error: 'SLICE_FAILED: disk full' });
  });
});
