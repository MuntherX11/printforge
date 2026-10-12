import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { M, sardineRow } from '../catalog-core/__fixtures__/sardine-tin';
import { productsHarness, statusOf } from './__fixtures__/products-harness';
import { threeMf } from './__fixtures__/slicer-files';
import { isCurrentProjectVersion, NOT_A_SOURCE_FILE, OLD_PROJECT_FORMAT_MESSAGE, sniffSourceKind, sourceModelOf } from './product-sources';
import { NO_SOURCE_MODEL, ProductSourcesService, suggestedPartName } from './product-sources.service';

/** Slicer plan WP4: the STL or OrcaSlicer project a part is sliced from. */

const P = 'p-sardine';
const UPLOAD = '0f8fe0a8-1111-4222-8333-944455556666';

function stl(ascii = false, triangles = 2): Buffer {
  const buf = Buffer.alloc(84 + triangles * 50);
  buf.write(ascii ? 'solid box' : 'binary stl', 0, 'ascii');
  buf.writeUInt32LE(triangles, 80);
  return buf;
}

const PROJECT = {
  version: '2.3.1.0',
  printer_model: 'Creality Hi',
  filament_settings_id: ['PLA Black @Creality Hi', 'PLA Red @Creality Hi'],
  filament_vendor: ['Generic', 'Generic'],
  filament_type: ['PLA', 'PLA'],
  filament_colour: ['#111111', '#C4402A'],
};

async function project(settings: Record<string, unknown> = PROJECT, modelSettings: string | null = '<config><plate><metadata key="plater_id" value="1"/></plate></config>') {
  const buf = await threeMf([{ index: 1 }], { projectSettings: settings, sliceInfo: false });
  if (modelSettings === null) return buf;
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buf);
  zip.file('Metadata/model_settings.config', modelSettings);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function setup(file: Buffer, name: string) {
  const h = productsHarness([sardineRow()]);
  h.db.insert('printer', { id: 'pr-hi', name: 'Hi', model: 'Creality Hi', isActive: true });
  const chunk = { consume: jest.fn(async () => ({ originalname: name, buffer: file, size: file.length })), discard: jest.fn(async () => undefined) };
  const runDto = { id: 'run-1', status: 'QUEUED' };
  const slice = { create: jest.fn(async () => runDto) };
  const svc = new ProductSourcesService(h.db as any, chunk as any, slice as any);
  return { h, chunk, slice, svc, runDto };
}

let dir: string;
const prevDir = process.env.UPLOAD_DIR;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-sources-'));
  process.env.UPLOAD_DIR = dir;
});
afterEach(() => {
  process.env.UPLOAD_DIR = prevDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

const comp = (h: any, id: string) => h.db.t('productComponent').find((c: any) => c.id === id);

describe('sniffing', () => {
  it('binary STL by content, "solid"-headed binaries by size, zips only as .3mf, ASCII STL and the rest refused', () => {
    expect(sniffSourceKind(stl(), 'box.stl')).toBe('STL');
    expect(sniffSourceKind(stl(true), 'box.stl')).toBe('STL');
    const ascii = Buffer.from('solid box\n facet normal 0 0 0\n'.padEnd(200, ' '));
    expect(sniffSourceKind(ascii, 'box.stl')).toBeNull();
    expect(sniffSourceKind(stl(), 'box.gcode')).toBeNull();
    expect(sniffSourceKind(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), 'box.3mf')).toBe('THREEMF');
    expect(sniffSourceKind(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), 'box.zip')).toBeNull();
    expect(sniffSourceKind(Buffer.alloc(10), 'box.stl')).toBeNull();
  });

  it('project versions: 2.3+ current, 2.2 and unreadable old', () => {
    expect(isCurrentProjectVersion('2.3.0.0')).toBe(true);
    expect(isCurrentProjectVersion('2.4.1')).toBe(true);
    expect(isCurrentProjectVersion('3.0')).toBe(true);
    expect(isCurrentProjectVersion('2.2.9.9')).toBe(false);
    expect(isCurrentProjectVersion('1.9')).toBe(false);
    expect(isCurrentProjectVersion(undefined)).toBe(false);
    expect(isCurrentProjectVersion('x')).toBe(false);
  });
});

describe('upload an STL', () => {
  it('stores it as the part\'s source and queues the 1-unit validation run on the product\'s printer', async () => {
    const { h, svc, chunk, slice, runDto } = setup(stl(), 'Box v2.stl');
    const out = await svc.upload(P, 'c1', { assembledUploadId: UPLOAD });
    const c = comp(h, 'c1');
    expect(c).toMatchObject({ sourceAttachmentId: out.source.attachmentId, sourceKind: 'STL' });
    const att = h.db.t('attachment').find((a: any) => a.id === out.source.attachmentId);
    expect(att).toMatchObject({ entityType: 'product', entityId: P, mimeType: 'model/stl', originalName: 'Box v2.stl', sizeBytes: stl().length });
    expect(fs.readFileSync(path.join(dir, att.storagePath))).toEqual(stl());
    expect(out.source).toEqual({ attachmentId: att.id, kind: 'STL', filename: 'Box v2.stl', sizeBytes: stl().length, slots: [], printerId: null, printerModel: null });
    expect(slice.create).toHaveBeenCalledWith(P, 'c1', { printerId: 'pr-1', materials: {}, units: 1 }, true);
    expect(out).toMatchObject({ validationRun: runDto, notice: null });
    expect(chunk.discard).toHaveBeenCalledWith(UPLOAD);
  });

  it('no printer or profile → the source is stored and the notice says why no run was queued', async () => {
    const { h, svc, slice } = setup(stl(), 'box.stl');
    slice.create.mockRejectedValue(new BadRequestException('NO_MACHINE_PROFILE: K1 has no machine profile — import one in Settings › Slicer'));
    const out = await svc.upload(P, 'c1', { assembledUploadId: UPLOAD });
    expect(comp(h, 'c1').sourceKind).toBe('STL');
    expect(out).toMatchObject({ validationRun: null, notice: 'NO_MACHINE_PROFILE: K1 has no machine profile — import one in Settings › Slicer' });
  });

  it('refuses ASCII STL, G-code and foreign parts; nothing stored', async () => {
    const ascii = Buffer.from('solid box\n facet normal 0 0 0\n'.padEnd(200, ' '));
    const a = setup(ascii, 'box.stl');
    await expect(a.svc.upload(P, 'c1', { assembledUploadId: UPLOAD })).rejects.toThrow(NOT_A_SOURCE_FILE);
    const b = setup(stl(), 'box.gcode');
    await expect(b.svc.upload(P, 'c1', { assembledUploadId: UPLOAD })).rejects.toThrow(NOT_A_SOURCE_FILE);
    expect(b.h.db.t('attachment')).toHaveLength(0);
    expect(b.chunk.discard).not.toHaveBeenCalled();
    const c = setup(stl(), 'box.stl');
    expect(await statusOf(c.svc.upload('p-other', 'c1', { assembledUploadId: UPLOAD }))).toBe(404);
    expect(await statusOf(c.svc.upload(P, 'c1', {}))).toBe(400);
    expect(c.chunk.consume).not.toHaveBeenCalled();
  });
});

describe('upload an OrcaSlicer project', () => {
  it('reads the slots (matched to shop filaments) and the printer, and queues the validation run without a printer (locked to the project\'s)', async () => {
    const { h, svc, slice } = setup(await project(), 'Keychain.3mf');
    const out = await svc.upload(P, 'c1', { assembledUploadId: UPLOAD });
    expect(out.source).toMatchObject({
      kind: 'THREEMF', filename: 'Keychain.3mf', printerModel: 'Creality Hi', printerId: 'pr-hi',
      slots: [
        { colorIndex: 0, profile: 'PLA Black', colorHex: '111111', materialId: M.black },
        { colorIndex: 1, profile: 'PLA Red', colorHex: 'C4402A', materialId: M.red },
      ],
    });
    const att = h.db.t('attachment').find((a: any) => a.id === out.source.attachmentId);
    expect(att.mimeType).toBe('model/3mf');
    expect(att.parsedMetadata).toMatchObject({ printerModel: 'Creality Hi', printerId: 'pr-hi' });
    expect(slice.create).toHaveBeenCalledWith(P, 'c1', { materials: {}, units: 1 }, true);
    // The product page reads the same thing back from the attachment.
    expect(sourceModelOf(comp(h, 'c1'), att)).toEqual(out.source);
  });

  it('an older project (version < 2.3, or no <plate> list) → 400 with the OrcaSlicer re-save message', async () => {
    const old = setup(await project({ ...PROJECT, version: '2.2.0.0' }), 'old.3mf');
    await expect(old.svc.upload(P, 'c1', { assembledUploadId: UPLOAD })).rejects.toThrow(OLD_PROJECT_FORMAT_MESSAGE);
    expect(OLD_PROJECT_FORMAT_MESSAGE).toBe('OLD_PROJECT_FORMAT: This project was saved by an older OrcaSlicer. Open it in your current OrcaSlicer, Save Project As, and upload again.');
    const noPlates = setup(await project(PROJECT, '<config/>'), 'old.3mf');
    await expect(noPlates.svc.upload(P, 'c1', { assembledUploadId: UPLOAD })).rejects.toThrow(OLD_PROJECT_FORMAT_MESSAGE);
    const bare = setup(await threeMf([{ index: 1 }], { sliceInfo: false }), 'bare.3mf');
    await expect(bare.svc.upload(P, 'c1', { assembledUploadId: UPLOAD })).rejects.toThrow(OLD_PROJECT_FORMAT_MESSAGE);
    expect(bare.h.db.t('attachment')).toHaveLength(0);
  });
});

describe('inspect a staged model', () => {
  const untouched = (h: any) => JSON.stringify(h.db.tables());

  it('an STL: its kind, name and size, no slots, the product\'s printer as the default; nothing created, the upload kept', async () => {
    const { h, svc, chunk, slice } = setup(stl(), 'Box v2.stl');
    const before = untouched(h);
    await expect(svc.inspect(P, { assembledUploadId: UPLOAD })).resolves.toEqual({
      kind: 'STL', filename: 'Box v2.stl', sizeBytes: stl().length, suggestedName: 'Box v2', slots: [], printerId: null, printerModel: null, defaultPrinterId: 'pr-1',
    });
    expect(untouched(h)).toBe(before);
    expect(fs.readdirSync(dir)).toHaveLength(0);
    expect(chunk.consume).toHaveBeenCalledWith(UPLOAD, expect.any(Number), { keep: true });
    expect(chunk.discard).not.toHaveBeenCalled();
    expect(slice.create).not.toHaveBeenCalled();
  });

  it('a project: each slot with the shop filament it matched (null when none) and the project\'s printer', async () => {
    const settings = {
      ...PROJECT,
      filament_settings_id: [...PROJECT.filament_settings_id, 'Polymaker TPU95 Teal @Creality Hi'],
      filament_vendor: [...PROJECT.filament_vendor, 'Polymaker'],
      filament_type: [...PROJECT.filament_type, 'TPU'],
      filament_colour: [...PROJECT.filament_colour, '#00B3A4'],
    };
    const { h, svc, chunk } = setup(await project(settings), 'Zelda keychain.3mf');
    const before = untouched(h);
    const out = await svc.inspect(P, { assembledUploadId: UPLOAD });
    expect(out).toMatchObject({ kind: 'THREEMF', filename: 'Zelda keychain.3mf', suggestedName: 'Zelda keychain', printerId: 'pr-hi', printerModel: 'Creality Hi', defaultPrinterId: 'pr-1' });
    expect(out.slots).toEqual([
      { colorIndex: 0, profile: 'PLA Black', colorHex: '111111', materialId: M.black },
      { colorIndex: 1, profile: 'PLA Red', colorHex: 'C4402A', materialId: M.red },
      { colorIndex: 2, profile: 'Polymaker TPU95 Teal', colorHex: '00B3A4', materialId: null },
    ]);
    expect(untouched(h)).toBe(before);
    expect(chunk.discard).not.toHaveBeenCalled();
  });

  it('a project for a printer the shop does not have: the model is named, the printer is null', async () => {
    const { svc } = setup(await project({ ...PROJECT, printer_model: 'Bambu Lab X1 Carbon' }), 'k.3mf');
    await expect(svc.inspect(P, { assembledUploadId: UPLOAD })).resolves.toMatchObject({ printerId: null, printerModel: 'Bambu Lab X1 Carbon' });
  });

  it('an older project → 400 with the re-save message; other files, an unknown product and a missing id are refused; the upload is kept', async () => {
    const old = setup(await project({ ...PROJECT, version: '2.2.0.0' }), 'old.3mf');
    await expect(old.svc.inspect(P, { assembledUploadId: UPLOAD })).rejects.toThrow(OLD_PROJECT_FORMAT_MESSAGE);
    expect(await statusOf(old.svc.inspect(P, { assembledUploadId: UPLOAD }))).toBe(400);
    expect(old.chunk.discard).not.toHaveBeenCalled();
    const other = setup(stl(), 'box.gcode');
    await expect(other.svc.inspect(P, { assembledUploadId: UPLOAD })).rejects.toThrow(NOT_A_SOURCE_FILE);
    expect(await statusOf(other.svc.inspect('p-none', { assembledUploadId: UPLOAD }))).toBe(404);
    expect(await statusOf(other.svc.inspect(P, {}))).toBe(400);
    expect(await statusOf(other.svc.inspect(P, { assembledUploadId: UPLOAD, description: 'x' }))).toBe(400);
  });

  it('the suggested name is the file name without its extension, at most 120 characters', () => {
    expect(suggestedPartName('Zelda keychain.3MF')).toBe('Zelda keychain');
    expect(suggestedPartName('box.v2.stl')).toBe('box.v2');
    expect(suggestedPartName(`${'a'.repeat(150)}.stl`)).toHaveLength(120);
    expect(suggestedPartName(' spaced .stl')).toBe('spaced');
  });
});

describe('replace and remove', () => {
  it('replacing the source deactivates the part\'s SLICED layouts, keeps hand layouts, and drops the old file', async () => {
    const { h, svc } = setup(stl(), 'box.stl');
    const first = await svc.upload(P, 'c1', { assembledUploadId: UPLOAD });
    const oldAbs = path.join(dir, h.db.t('attachment').find((a: any) => a.id === first.source.attachmentId).storagePath);
    const sliced = h.db.insert('plateLayout', { componentId: 'c1', name: 'x12 · K1', unitsPerPlate: 12, plateMinutes: 200, plateGrams: 100, source: 'SLICED', isActive: true });
    const second = await svc.upload(P, 'c1', { assembledUploadId: UPLOAD });
    expect(second.source.attachmentId).not.toBe(first.source.attachmentId);
    expect(comp(h, 'c1').sourceAttachmentId).toBe(second.source.attachmentId);
    expect(h.db.t('plateLayout').find((l: any) => l.id === sliced.id).isActive).toBe(false);
    expect(h.db.t('plateLayout').find((l: any) => l.id === 'l1')).toMatchObject({ source: 'GCODE', isActive: true });
    expect(h.db.t('attachment').some((a: any) => a.id === first.source.attachmentId)).toBe(false);
    expect(fs.existsSync(oldAbs)).toBe(false);
  });

  it('remove unlinks the source, deactivates SLICED layouts and deletes the file; 404 when there is none', async () => {
    const { h, svc } = setup(stl(), 'box.stl');
    const up = await svc.upload(P, 'c1', { assembledUploadId: UPLOAD });
    const abs = path.join(dir, h.db.t('attachment').find((a: any) => a.id === up.source.attachmentId).storagePath);
    const sliced = h.db.insert('plateLayout', { componentId: 'c1', name: 'x12 · K1', unitsPerPlate: 12, plateMinutes: 200, plateGrams: 100, source: 'SLICED', isActive: true });
    await expect(svc.remove(P, 'c1')).resolves.toEqual({ deleted: true });
    expect(comp(h, 'c1')).toMatchObject({ sourceAttachmentId: null, sourceKind: null });
    expect(h.db.t('plateLayout').find((l: any) => l.id === sliced.id).isActive).toBe(false);
    expect(fs.existsSync(abs)).toBe(false);
    await expect(svc.remove(P, 'c1')).rejects.toThrow(NO_SOURCE_MODEL);
    expect(await statusOf(svc.remove(P, 'c1'))).toBe(404);
  });
});
