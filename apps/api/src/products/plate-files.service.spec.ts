import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sardineRow } from '../catalog-core/__fixtures__/sardine-tin';
import { GcodeParserService } from '../file-parser/gcode-parser.service';
import { addJob, productsHarness, statusOf } from './__fixtures__/products-harness';
import { gcode, labels } from './__fixtures__/slicer-files';
import { HAS_FILE, NO_FILE, PlateFilesService } from './plate-files.service';

/** Owner spec 2026-10-02 items 3 and 5: a plate's print file can be uploaded onto it and deleted. */

const P = 'p-sardine';
const UPLOAD = '0f8fe0a8-1111-4222-8333-944455556666';
const BOX12 = Buffer.concat([
  gcode({ labels: labels('box', 12), minutes: 243, totalGrams: 112.8, types: ['PLA'] }),
  Buffer.from('; printer_model = Creality Hi\n'),
]);

function setup(file: Buffer = BOX12, name = 'Box x 12.gcode') {
  const h = productsHarness([sardineRow()]);
  h.db.insert('printer', { id: 'pr-hi', name: 'HI', model: null, isActive: true });
  const chunk = {
    consume: jest.fn(async () => ({ originalname: name, buffer: file, size: file.length })),
    discard: jest.fn(async () => undefined),
  };
  const recalc = jest.spyOn(h.pricing, 'recalcPricing');
  const svc = new PlateFilesService(h.db as any, new GcodeParserService(), chunk as any, h.pricing);
  return { h, chunk, svc, recalc };
}

let dir: string;
const prevDir = process.env.UPLOAD_DIR;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-plate-files-'));
  process.env.UPLOAD_DIR = dir;
});
afterEach(() => {
  process.env.UPLOAD_DIR = prevDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

const layout = (h: any, id: string) => h.db.t('plateLayout').find((l: any) => l.id === id);
const comp = (h: any, id: string) => h.db.t('productComponent').find((c: any) => c.id === id);

describe('upload a G-code onto a plate', () => {
  it('a ×12 layout entered by hand gets the file; its typed numbers stay; the file is stored with its printer', async () => {
    const { h, svc, chunk, recalc } = setup();
    const before = { ...layout(h, 'l1') };
    const out = await svc.attach(P, 'c1', 'l1', { assembledUploadId: UPLOAD });
    const l = layout(h, 'l1');
    expect(l).toMatchObject({ attachmentId: out.file.attachmentId, gcodeFilename: 'Box x 12.gcode', objectCount: 12 });
    expect(l).toMatchObject({ unitsPerPlate: before.unitsPerPlate, plateMinutes: before.plateMinutes, plateGrams: before.plateGrams });
    const att = h.db.t('attachment').find((a: any) => a.id === out.file.attachmentId);
    expect(att).toMatchObject({ entityType: 'product', entityId: P, slicedForPrinter: 'Creality Hi', mimeType: 'application/octet-stream' });
    expect(fs.readFileSync(path.join(dir, att.storagePath))).toEqual(BOX12);
    expect(out).toMatchObject({ slicedFor: 'Creality Hi', printer: { id: 'pr-hi', name: 'HI' }, warnings: [] });
    expect(out.file.downloadUrl).toBe(`/api/attachments/${att.id}/download`);
    expect(chunk.discard).toHaveBeenCalledWith(UPLOAD);
    // A layout file never changes the price (the product already has a pricing printer).
    expect(recalc).not.toHaveBeenCalled();
  });

  it('re-scans the units: a file of 12 on a ×10 plate is stored with a warning', async () => {
    const { svc } = setup();
    const out = await svc.attach(P, 'c4', 'l4', { assembledUploadId: UPLOAD });
    expect(out.warnings).toEqual([{ code: 'UNITS_DIFFER_FROM_LABELS', message: '"Key ×10": the file holds 12 units — check it is the right file' }]);
  });

  it("the component's own ×1: stored on the component, and the product is repriced", async () => {
    const one = Buffer.concat([gcode({ labels: labels('box', 1), minutes: 34, totalGrams: 9.4 }), Buffer.from('; printer_model = Creality K1 Max\n')]);
    const { h, svc, recalc } = setup(one, 'Box.gcode');
    const out = await svc.attach(P, 'c1', null, { assembledUploadId: UPLOAD });
    expect(comp(h, 'c1')).toMatchObject({ attachmentId: out.file.attachmentId, gcodeFilename: 'Box.gcode' });
    expect(out.printer).toBeNull();
    expect(out.warnings).toEqual([{ code: 'PRINTER_NOT_MATCHED', message: 'Sliced for Creality K1 Max — no matching printer' }]);
    expect(recalc).toHaveBeenCalledWith(P);
  });

  it('a plate that already has a file → 409, nothing stored; bad bodies and foreign ids are refused', async () => {
    const { h, svc, chunk } = setup();
    await svc.attach(P, 'c1', 'l1', { assembledUploadId: UPLOAD });
    const files = h.db.t('attachment').length;
    await expect(svc.attach(P, 'c1', 'l1', { assembledUploadId: UPLOAD })).rejects.toThrow(HAS_FILE);
    expect(h.db.t('attachment')).toHaveLength(files);
    expect(chunk.consume).toHaveBeenCalledTimes(1);
    expect(await statusOf(svc.attach(P, 'c1', 'l1', { assembledUploadId: UPLOAD, plateGrams: 3 }))).toBe(400);
    expect(await statusOf(svc.attach(P, 'c1', 'l1', {}))).toBe(400);
    expect(await statusOf(svc.attach(P, 'c2', 'l1', { assembledUploadId: UPLOAD }))).toBe(404);
    expect(await statusOf(svc.attach('p-other', 'c1', null, { assembledUploadId: UPLOAD }))).toBe(404);
  });

  it('only G-code files', async () => {
    const { svc } = setup(BOX12, 'box.3mf');
    await expect(svc.attach(P, 'c1', 'l1', { assembledUploadId: UPLOAD })).rejects.toThrow('File must be a G-code file');
  });
});

describe('delete a plate file', () => {
  it('an open job printing it → 409 naming the job; nothing deleted', async () => {
    const { h, svc } = setup();
    const { file } = await svc.attach(P, 'c1', 'l1', { assembledUploadId: UPLOAD });
    const job = addJob(h.db, { status: 'PAUSED', name: 'Order 12 — Box' });
    h.db.insert('jobPlate', { jobId: job.id, layoutId: 'l1', componentId: 'c1', attachmentId: file.attachmentId });
    await expect(svc.remove(P, 'c1', 'l1')).rejects.toThrow('This file is printed by job "Order 12 — Box" (paused) — finish or cancel that job first');
    expect(layout(h, 'l1').attachmentId).toBe(file.attachmentId);
    expect(h.db.t('attachment').some((a: any) => a.id === file.attachmentId)).toBe(true);
  });

  it("a finished job doesn't keep it: row and disk file go, the job's plate row stays", async () => {
    const { h, svc } = setup();
    const { file } = await svc.attach(P, 'c1', 'l1', { assembledUploadId: UPLOAD });
    const abs = path.join(dir, h.db.t('attachment').find((a: any) => a.id === file.attachmentId).storagePath);
    const job = addJob(h.db, { status: 'COMPLETED', name: 'Done' });
    h.db.insert('jobPlate', { jobId: job.id, layoutId: 'l1', componentId: 'c1', attachmentId: file.attachmentId });
    await expect(svc.remove(P, 'c1', 'l1')).resolves.toEqual({ deleted: true });
    expect(layout(h, 'l1')).toMatchObject({ attachmentId: null, gcodeFilename: null, isActive: true });
    expect(h.db.t('attachment').some((a: any) => a.id === file.attachmentId)).toBe(false);
    expect(fs.existsSync(abs)).toBe(false);
    expect(h.db.t('jobPlate').find((p: any) => p.jobId === job.id).attachmentId).toBe(file.attachmentId);
  });

  it("the component's own file: deleted and the product repriced; no file → 404", async () => {
    const { h, svc, recalc } = setup();
    await svc.attach(P, 'c1', null, { assembledUploadId: UPLOAD });
    recalc.mockClear();
    await svc.remove(P, 'c1', null);
    expect(comp(h, 'c1')).toMatchObject({ attachmentId: null, gcodeFilename: null });
    expect(recalc).toHaveBeenCalledWith(P);
    await expect(svc.remove(P, 'c1', null)).rejects.toThrow(NO_FILE);
  });
});
