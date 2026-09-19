import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OPT, sardineRow } from '../catalog-core/__fixtures__/sardine-tin';
import { GcodeParserService } from '../file-parser/gcode-parser.service';
import { addJob, productsHarness, statusOf } from './__fixtures__/products-harness';
import { gcode, labels } from './__fixtures__/slicer-files';
import { PlateLayoutsService } from './plate-layouts.service';
import { parseLayoutCreate, parseLayoutPatch } from './slicer-import-input';

/** §7.1 item 15 (and the M3/M4 rows of item 37). */

const P = 'p-sardine';
const UPLOAD = '0f8fe0a8-1111-4222-8333-944455556666';

function setup(opts: { file?: Buffer; name?: string } = {}) {
  const h = productsHarness([sardineRow()]);
  const chunk = {
    consume: jest.fn(async () => ({ originalname: opts.name ?? 'Key x 12.gcode', buffer: opts.file ?? BOX12, size: 0 })),
    discard: jest.fn(async () => undefined),
  };
  const svc = new PlateLayoutsService(h.db as any, new GcodeParserService(), chunk as any);
  return { h, chunk, svc };
}

// "Box x 12.gcode"-like: 12 Klipper labels, 4h03, per-tool 110 g but a 112.8 g total.
const BOX12 = gcode({ labels: labels('box', 12), minutes: 243, toolGrams: [110], totalGrams: 112.8, types: ['PLA'], colours: ['#C0C0C0'] });

let dir: string;
const prevDir = process.env.UPLOAD_DIR;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-layouts-'));
  process.env.UPLOAD_DIR = dir;
});
afterEach(() => {
  process.env.UPLOAD_DIR = prevDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

const filesOnDisk = () => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true } as any).filter((f: any) => /\.(gcode|png)$/.test(String(f))) : []);

describe('M3 from a staged plate G-code', () => {
  it('Klipper labels → units 12; minutes and grams from filamentUsedGrams (B1 regression); file stored octet-stream', async () => {
    const { h, chunk, svc } = setup();
    const out = await svc.create(P, 'c4', { assembledUploadId: UPLOAD });
    expect(out.layout).toMatchObject({ unitsPerPlate: 12, plateMinutes: 243, plateGrams: 112.8, source: 'GCODE', objectCount: 12, name: '×12' });
    expect(out.layout.slots).toEqual([{ colorIndex: 0, gramsUsed: 112.8 }]);
    expect(out.warnings).toEqual([]);
    const att = h.db.t('attachment').find((a: any) => a.id === out.layout.file!.attachmentId);
    expect(att).toMatchObject({ mimeType: 'application/octet-stream', entityType: 'product', entityId: P, originalName: 'Key x 12.gcode' });
    expect(att.filename).not.toContain('Key');
    expect(fs.readFileSync(path.join(dir, att.storagePath))).toEqual(BOX12);
    expect(chunk.consume).toHaveBeenCalledWith(UPLOAD, expect.any(Number), { keep: true });
    expect(chunk.discard).toHaveBeenCalledWith(UPLOAD);
  });

  it('no labels and no units → 400; with units it is created', async () => {
    const { svc, chunk } = setup({ file: gcode({ minutes: 60, totalGrams: 20 }) });
    await expect(svc.create(P, 'c4', { assembledUploadId: UPLOAD })).rejects.toThrow('This file has no object labels — enter how many units are on the plate');
    expect(chunk.discard).not.toHaveBeenCalled();
    const out = await svc.create(P, 'c4', { assembledUploadId: UPLOAD, unitsPerPlate: 6 });
    expect(out.layout.unitsPerPlate).toBe(6);
  });

  it('no time / no grams in the file → 400 asking for them', async () => {
    await expect(setup({ file: gcode({ labels: labels('k', 3), totalGrams: 10 }) }).svc.create(P, 'c4', { assembledUploadId: UPLOAD }))
      .rejects.toThrow('No print time found in the file — enter the plate minutes');
    await expect(setup({ file: gcode({ labels: labels('k', 3), minutes: 30 }) }).svc.create(P, 'c4', { assembledUploadId: UPLOAD }))
      .rejects.toThrow('No filament weight found in the file — enter the plate grams');
  });

  it('mixed plate, units override and tower warnings', async () => {
    const file = gcode({ labels: [...labels('key', 10), ...labels('box', 2), 'wipe_tower'], minutes: 90, totalGrams: 30 });
    const { svc } = setup({ file });
    const out = await svc.create(P, 'c4', { assembledUploadId: UPLOAD, unitsPerPlate: 11 });
    expect(out.warnings.map((w) => w.code)).toEqual(['MIXED_PLATE', 'UNITS_DIFFER_FROM_LABELS', 'TOWER_IGNORED']);
    expect(out.warnings[1].message).toBe('"Key": 11 units entered, but the file\'s labels count 12 objects');
    expect(out.layout.objectCount).toBe(12);
  });

  it('a multicolour file on a single-material component warns SLOTS_DIFFER', async () => {
    const { svc } = setup({ file: gcode({ labels: labels('k', 5), minutes: 50, toolGrams: [8, 2], totalGrams: 10 }) });
    const out = await svc.create(P, 'c4', { assembledUploadId: UPLOAD });
    expect(out.warnings.map((w) => w.code)).toEqual(['SLOTS_DIFFER']);
    expect(out.layout.slots).toEqual([{ colorIndex: 0, gramsUsed: 8 }, { colorIndex: 1, gramsUsed: 2 }]);
  });

  it('a duplicate active size → 409, and the staged upload is kept', async () => {
    const { svc, chunk, h } = setup({ file: gcode({ labels: labels('k', 10), minutes: 55, totalGrams: 15 }) });
    await expect(svc.create(P, 'c4', { assembledUploadId: UPLOAD })).rejects.toThrow('A ×10 layout already exists for "Key"');
    expect(chunk.discard).not.toHaveBeenCalled();
    expect(filesOnDisk()).toEqual([]);
    expect(h.db.t('attachment')).toHaveLength(0);
  });

  it('a disk write failure → 400 and no layout or Attachment row', async () => {
    const { svc, h, chunk } = setup();
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    process.env.UPLOAD_DIR = blocker;
    const before = h.db.t('plateLayout').length;
    await expect(svc.create(P, 'c4', { assembledUploadId: UPLOAD })).rejects.toThrow("Couldn't store the file — try again");
    expect(h.db.t('plateLayout')).toHaveLength(before);
    expect(h.db.t('attachment')).toHaveLength(0);
    expect(chunk.discard).not.toHaveBeenCalled();
  });

  it('a transaction failure unlinks the written file and leaves no rows', async () => {
    const { svc, h } = setup();
    jest.spyOn(h.db.plateLayoutSlot, 'create').mockRejectedValueOnce(new Error('connection reset'));
    const before = h.db.t('plateLayout').length;
    await expect(svc.create(P, 'c4', { assembledUploadId: UPLOAD })).rejects.toThrow('connection reset');
    expect(filesOnDisk()).toEqual([]);
    expect(h.db.t('attachment')).toHaveLength(0);
    expect(h.db.t('plateLayout')).toHaveLength(before);
  });
});

describe('M3 manual', () => {
  it('all three numbers required; slots follow the component proportions', async () => {
    const { svc } = setup();
    await expect(svc.create(P, 'c2', { unitsPerPlate: 20, plateMinutes: 300 })).rejects.toThrow('"plateGrams" is required');
    const out = await svc.create(P, 'c2', { unitsPerPlate: 20, plateMinutes: 300, plateGrams: 120, name: 'Full bed' });
    expect(out.layout).toMatchObject({ name: 'Full bed', source: 'MANUAL', unitsPerPlate: 20, file: null });
    // Lid: 5.2 g black + 0.8 g silver per unit.
    expect(out.layout.slots).toEqual([{ colorIndex: 0, gramsUsed: 104 }, { colorIndex: 1, gramsUsed: 16 }]);
  });

  it('404 unless the component belongs to the product', async () => {
    const { svc, h } = setup();
    h.db.insert('product', { id: 'p-other', name: 'Other' });
    expect(await statusOf(svc.create('p-other', 'c4', { unitsPerPlate: 2, plateMinutes: 10, plateGrams: 3 }))).toBe(404);
    expect(await statusOf(svc.create(P, 'nope', { unitsPerPlate: 2, plateMinutes: 10, plateGrams: 3 }))).toBe(404);
  });
});

describe('M4 / M5', () => {
  it('M4: rescales slots when plateGrams changes; duplicate active size → 409', async () => {
    const { svc } = setup();
    const out = await svc.update(P, 'c2', 'l2', { plateGrams: 180 });
    expect(out.plateGrams).toBe(180);
    const { svc: s2 } = setup();
    await s2.create(P, 'c4', { unitsPerPlate: 20, plateMinutes: 100, plateGrams: 30 });
    await expect(s2.update(P, 'c4', 'l4', { unitsPerPlate: 20 })).rejects.toThrow('A ×20 layout already exists for "Key"');
  });

  it('M4 rescales stored slots proportionally', async () => {
    const { svc } = setup();
    const out = await svc.update(P, 'c3', 'l3', { plateGrams: 72 });
    expect(out.slots).toEqual([{ colorIndex: 0, gramsUsed: 57.6 }, { colorIndex: 1, gramsUsed: 14.4 }]);
  });

  it('M4/M5: a layout of another component (same product) → 404; a component of another product → 404', async () => {
    const { svc, h } = setup();
    h.db.insert('product', { id: 'p-other', name: 'Other' });
    expect(await statusOf(svc.update(P, 'c4', 'l1', { name: 'x' }))).toBe(404);
    expect(await statusOf(svc.remove(P, 'c4', 'l1'))).toBe(404);
    expect(await statusOf(svc.update('p-other', 'c1', 'l1', { name: 'x' }))).toBe(404);
    expect(await statusOf(svc.remove('p-other', 'c1', 'l1'))).toBe(404);
  });

  it('M5: open job → 409; history → deactivated; otherwise deleted with its file', async () => {
    const { svc, h } = setup();
    const open = addJob(h.db, { status: 'QUEUED', productId: P });
    h.db.insert('jobPlate', { jobId: open.id, layoutId: 'l1', componentId: 'c1' });
    expect(await statusOf(svc.remove(P, 'c1', 'l1'))).toBe(409);

    const done = addJob(h.db, { status: 'COMPLETED', productId: P });
    h.db.insert('jobPlate', { jobId: done.id, layoutId: 'l2', componentId: 'c2' });
    await expect(svc.remove(P, 'c2', 'l2')).resolves.toEqual({ deactivated: true });
    expect(h.db.t('plateLayout').find((l: any) => l.id === 'l2').isActive).toBe(false);

    const { layout } = await svc.create(P, 'c4', { assembledUploadId: UPLOAD });
    const att = h.db.t('attachment').find((a: any) => a.id === layout.file!.attachmentId);
    const abs = path.join(dir, att.storagePath);
    expect(fs.existsSync(abs)).toBe(true);
    await expect(svc.remove(P, 'c4', layout.id)).resolves.toEqual({ deleted: true });
    expect(h.db.t('plateLayout').some((l: any) => l.id === layout.id)).toBe(false);
    expect(h.db.t('attachment')).toHaveLength(0);
    expect(fs.existsSync(abs)).toBe(false);
  });
});

// ------------------------------------------------------------ §7.1 item 37 (M3/M4)

function rejects(fn: () => unknown, field: string) {
  let msg = '';
  try {
    fn();
  } catch (e: any) {
    msg = e?.message ?? '';
    expect(e?.getStatus?.()).toBe(400);
  }
  expect(msg).toContain(field);
}

describe('M3/M4 numeric bounds (§4.7)', () => {
  const manual = { unitsPerPlate: 2, plateMinutes: 10, plateGrams: 3 };
  const cases: Array<[string, number, number, number, boolean]> = [
    ['unitsPerPlate', 1, 500, 1, true],
    ['plateMinutes', 1, 100000, 0.5, false],
    ['plateGrams', 0.1, 100000, 0.05, false],
    ['colorChanges', 0, 10000, 1, true],
  ];
  for (const [field, lo, hi, step, integer] of cases) {
    it(`M3 ${field}: ${lo}–${hi}`, () => {
      expect(() => parseLayoutCreate({ ...manual, [field]: lo })).not.toThrow();
      expect(() => parseLayoutCreate({ ...manual, [field]: hi })).not.toThrow();
      rejects(() => parseLayoutCreate({ ...manual, [field]: lo - step }), field);
      rejects(() => parseLayoutCreate({ ...manual, [field]: hi + step }), field);
      for (const bad of [NaN, Infinity, 'abc']) rejects(() => parseLayoutCreate({ ...manual, [field]: bad }), field);
      if (integer) rejects(() => parseLayoutCreate({ ...manual, [field]: lo + 0.5 }), field);
    });
    it(`M4 ${field}: ${lo}–${hi}`, () => {
      expect(parseLayoutPatch({ [field]: lo })).toEqual({ [field]: lo });
      expect(parseLayoutPatch({ [field]: hi })).toEqual({ [field]: hi });
      rejects(() => parseLayoutPatch({ [field]: lo - step }), field);
      rejects(() => parseLayoutPatch({ [field]: hi + step }), field);
      for (const bad of [NaN, Infinity, 'abc']) rejects(() => parseLayoutPatch({ [field]: bad }), field);
    });
  }

  it('M4 sortOrder 0–10000; name ≤ 60; unknown keys dropped', () => {
    expect(parseLayoutPatch({ sortOrder: 0, isActive: false, componentId: 'x', plateLayoutId: 'y' })).toEqual({ sortOrder: 0, isActive: false });
    expect(parseLayoutPatch({ sortOrder: 10000 })).toEqual({ sortOrder: 10000 });
    for (const bad of [-1, 10001, 2.5, NaN, Infinity, 'abc']) rejects(() => parseLayoutPatch({ sortOrder: bad }), 'sortOrder');
    rejects(() => parseLayoutPatch({ name: 'x'.repeat(61) }), 'name');
    rejects(() => parseLayoutPatch({ isActive: 'yes' }), 'isActive');
  });

  it('named cases: M3 colorChanges 10001 → 400; M4 sortOrder −1 → 400 (through the service, nothing written)', async () => {
    const { svc, h } = setup();
    const before = JSON.stringify(h.db.t('plateLayout'));
    expect(await statusOf(svc.create(P, 'c4', { ...manual, colorChanges: 10001 }))).toBe(400);
    expect(await statusOf(svc.update(P, 'c4', 'l4', { sortOrder: -1 }))).toBe(400);
    expect(JSON.stringify(h.db.t('plateLayout'))).toBe(before);
  });

  it('a label count above 500 in the file is refused naming unitsPerPlate', async () => {
    const { svc } = setup({ file: gcode({ labels: labels('pin', 501), minutes: 60, totalGrams: 20 }) });
    await expect(svc.create(P, 'c4', { assembledUploadId: UPLOAD })).rejects.toThrow('"unitsPerPlate" must be between 1 and 500');
  });
});

it('layouts on a SIZE-owned component work the same (ownership is by product)', async () => {
  const { svc } = setup();
  const out = await svc.create(P, 'c9', { unitsPerPlate: 20, plateMinutes: 170, plateGrams: 48 });
  expect(out.layout.unitsPerPlate).toBe(20);
  expect(OPT.large).toBe('v-large');
});
