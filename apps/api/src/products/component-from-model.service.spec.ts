import { BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as fs from 'fs';
import * as path from 'path';
import { OPT, sardineRow } from '../catalog-core/__fixtures__/sardine-tin';
import { RolesGuard } from '../auth/guards/roles.guard';
import { HI, K1, M, P, sliceHarness, statusOf, useTempUploadDir, type SliceHarness } from '../slice/__fixtures__/slice-harness';
import { productsHarness } from './__fixtures__/products-harness';
import { gcode, labels, threeMf } from './__fixtures__/slicer-files';
import { ComponentFromModelService, parseComponentFromModel, PLACEHOLDER_GRAMS, withoutErrorCode } from './component-from-model.service';
import { ProductSourcesController } from './product-sources.controller';
import { OLD_PROJECT_FORMAT_MESSAGE } from './product-sources';
import { ProductSourcesService } from './product-sources.service';

/**
 * A part made from its model alone: an STL gives a single-material part, a
 * project with several slots a multicolour one, and the validation slice that
 * is queued fills in the grams, minutes and filament changes.
 */

const dirOf = useTempUploadDir();
const UPLOAD = '0f8fe0a8-1111-4222-8333-944455556666';

function stl(): Buffer {
  const buf = Buffer.alloc(84 + 2 * 50);
  buf.write('binary stl', 0, 'ascii');
  buf.writeUInt32LE(2, 80);
  return buf;
}

const FOUR = {
  version: '2.3.1.0',
  printer_model: 'Creality Hi',
  filament_settings_id: ['PLA Black @Creality Hi', 'PLA Red @Creality Hi', 'PLA White @Creality Hi', 'PLA Gold @Creality Hi'],
  filament_vendor: ['Generic', 'Generic', 'Generic', 'Generic'],
  filament_type: ['PLA', 'PLA', 'PLA', 'PLA'],
  filament_colour: ['#111111', '#C4402A', '#FFFFFF', '#D4AF37'],
};
const ONE = { ...FOUR, filament_settings_id: ['PLA Black @Creality Hi'], filament_vendor: ['Generic'], filament_type: ['PLA'], filament_colour: ['#111111'] };

async function project(settings: Record<string, unknown>) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await threeMf([{ index: 1 }], { projectSettings: settings, sliceInfo: false }));
  zip.file('Metadata/model_settings.config', '<config><plate><metadata key="plater_id" value="1"/></plate></config>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** The real slice service and processor behind the new service, over the sardine tin. */
function setup(file: Buffer, name: string) {
  const x = sliceHarness();
  const chunk = { consume: jest.fn(async () => ({ originalname: name, buffer: file, size: file.length })), discard: jest.fn(async () => undefined) };
  const sources = new ProductSourcesService(x.db as any, chunk as any, x.service);
  const svc = new ComponentFromModelService(x.db as any, chunk as any, sources, x.h.products, x.service);
  return { x, chunk, svc, sources };
}

const comp = (x: SliceHarness, id: string) => x.db.t('productComponent').find((c: any) => c.id === id);
const mats = (x: SliceHarness, id: string) => x.db.t('componentMaterial').filter((m: any) => m.componentId === id).sort((a: any, b: any) => a.colorIndex - b.colorIndex);
const body = (o: Record<string, unknown> = {}) => ({ assembledUploadId: UPLOAD, description: 'Keychain', materials: { '0': M.black }, ...o });
const FOUR_MATERIALS = { '0': M.black, '1': M.red, '2': M.white, '3': M.gold };

describe('body', () => {
  it('allowlist: description 1..120, slot keys "0".."3", ids, no extra keys', () => {
    expect(parseComponentFromModel(body({ printerId: K1, variantId: null }))).toEqual({
      assembledUploadId: UPLOAD, description: 'Keychain', printerId: K1, materials: { '0': M.black }, variantId: null,
    });
    const bad = (o: Record<string, unknown>) => () => parseComponentFromModel(body(o));
    expect(bad({ description: '' })).toThrow('"description" must be 1 to 120 characters');
    expect(bad({ description: '   ' })).toThrow(BadRequestException);
    expect(bad({ description: 'x'.repeat(121) })).toThrow(BadRequestException);
    expect(parseComponentFromModel(body({ description: 'x'.repeat(120) })).description).toHaveLength(120);
    expect(bad({ description: 12 })).toThrow(BadRequestException);
    expect(bad({ materials: { '4': M.black } })).toThrow('"materials" keys must be slot numbers 0, 1, 2, 3');
    expect(bad({ materials: [M.black] })).toThrow('"materials" must be an object');
    expect(bad({ materials: undefined })).toThrow('"materials" must be an object');
    expect(bad({ materials: { '0': 7 } })).toThrow('"materials[0]" must be an id');
    expect(bad({ assembledUploadId: '' })).toThrow('"assembledUploadId" is required');
    expect(bad({ gramsUsed: 5 })).toThrow('property gramsUsed should not exist');
    expect(bad({ productId: 'p-other' })).toThrow('property productId should not exist');
  });

  it('the notice is the sentence without its error code', () => {
    expect(withoutErrorCode('NO_FILAMENT_PROFILE: "PLA Black" has no filament profile — map one in Settings › Slicer')).toBe('"PLA Black" has no filament profile — map one in Settings › Slicer');
    expect(withoutErrorCode('Component not found')).toBe('Component not found');
  });
});

describe('from an STL', () => {
  it('creates a single-material part with the file as its source and queues the 1-unit run on the product printer', async () => {
    const { x, svc, chunk } = setup(stl(), 'Key Ring.stl');
    const recalc = jest.spyOn(x.h.pricing, 'recalcPricing');
    const out = await svc.create(P, body({ description: ' Key ring ' }));
    const c = comp(x, out.componentId);
    expect(c).toMatchObject({
      productId: P, variantId: null, description: 'Key ring', materialId: M.black, isMultiColor: false, quantity: 1,
      gramsUsed: PLACEHOLDER_GRAMS, printMinutes: 0, sortOrder: 5, sourceKind: 'STL', sourceAttachmentId: out.source.attachmentId,
    });
    expect(c.stockConfirmedAt).toBeTruthy();
    expect(mats(x, c.id)).toHaveLength(0);
    const att = x.db.t('attachment').find((a: any) => a.id === out.source.attachmentId);
    expect(att).toMatchObject({ entityType: 'product', entityId: P, mimeType: 'model/stl', originalName: 'Key Ring.stl' });
    expect(fs.readFileSync(path.join(dirOf(), att.storagePath))).toEqual(stl());
    expect(out.source).toEqual({ attachmentId: att.id, kind: 'STL', filename: 'Key Ring.stl', sizeBytes: stl().length, slots: [], printerId: null, printerModel: null });
    expect(out.notice).toBeNull();
    expect(out.validationRun).toMatchObject({ componentId: c.id, printerId: K1, unitsRequested: 1, status: 'QUEUED', filamentMap: { '0': { materialId: M.black } } });
    expect(chunk.consume).toHaveBeenCalledWith(UPLOAD, expect.any(Number), { keep: true });
    expect(chunk.discard).toHaveBeenCalledWith(UPLOAD);
    expect(recalc).toHaveBeenCalledWith(P);
  });

  it('the printer asked for wins; a product without a default printer needs one', async () => {
    const a = setup(stl(), 'box.stl');
    await expect(a.svc.create(P, body({ printerId: HI }))).resolves.toMatchObject({ validationRun: { printerId: HI } });
    const b = setup(stl(), 'box.stl');
    b.x.db.t('product')[0].defaultPrinterId = null;
    const before = b.x.db.t('productComponent').length;
    await expect(b.svc.create(P, body())).rejects.toThrow('Choose a printer — this product has no default printer');
    expect(await statusOf(b.svc.create(P, body()))).toBe(400);
    expect(b.x.db.t('productComponent')).toHaveLength(before);
    expect(b.x.db.t('attachment')).toHaveLength(0);
    expect(b.chunk.discard).not.toHaveBeenCalled();
    await expect(b.svc.create(P, body({ printerId: HI }))).resolves.toMatchObject({ validationRun: { printerId: HI } });
  });

  it('exactly slot "0": none → SLOT_UNMAPPED, a second slot → 400; an unknown filament or product → 400 / 404', async () => {
    const { svc, x } = setup(stl(), 'box.stl');
    await expect(svc.create(P, body({ materials: {} }))).rejects.toThrow('SLOT_UNMAPPED: Slot 1 has no filament');
    await expect(svc.create(P, body({ materials: { '0': M.black, '1': M.red } }))).rejects.toThrow('An STL part takes one filament');
    await expect(svc.create(P, body({ materials: { '0': 'm-gone' } }))).rejects.toThrow('SLOT_UNMAPPED: Slot 1 names a filament that no longer exists');
    expect(await statusOf(svc.create(P, body({ materials: { '1': M.red } })))).toBe(400);
    expect(await statusOf(svc.create('p-none', body()))).toBe(404);
    expect(x.db.t('productComponent')).toHaveLength(9);
  });

  it('a size option owns the part; a colour option or another product\'s option is refused', async () => {
    // The plain products harness: its database serves the option row locks.
    const h = productsHarness([sardineRow()]);
    const chunk = { consume: jest.fn(async () => ({ originalname: 'box.stl', buffer: stl(), size: stl().length })), discard: jest.fn(async () => undefined) };
    const slice = { create: jest.fn(async () => ({ id: 'run-1', status: 'QUEUED' })) };
    const svc = new ComponentFromModelService(h.db as any, chunk as any, new ProductSourcesService(h.db as any, chunk as any, slice as any), h.products, slice as any);
    const out = await svc.create(P, body({ variantId: OPT.large }));
    expect(h.db.t('productComponent').find((c: any) => c.id === out.componentId)).toMatchObject({ variantId: OPT.large, sortOrder: 4 });
    expect(slice.create).toHaveBeenCalledWith(P, out.componentId, { printerId: K1, materials: { '0': M.black }, units: 1 }, true);
    expect(out.validationRun).toEqual({ id: 'run-1', status: 'QUEUED' });
    await expect(svc.create(P, body({ variantId: OPT.red }))).rejects.toThrow("Colours use each size's components");
    expect(await statusOf(svc.create(P, body({ variantId: 'v-none' })))).toBe(404);
    // A refused part leaves no row and no file behind.
    expect(h.db.t('attachment')).toHaveLength(1);
    const files = fs.readdirSync(dirOf(), { recursive: true }).filter((f) => String(f).endsWith('.stl'));
    expect(files).toHaveLength(1);
  });

  it('a file that is not a model, or an old project, creates nothing', async () => {
    const a = setup(stl(), 'box.gcode');
    await expect(a.svc.create(P, body())).rejects.toThrow('File must be a binary STL');
    const b = setup(await project({ ...ONE, version: '2.2.0.0' }), 'old.3mf');
    await expect(b.svc.create(P, body())).rejects.toThrow(OLD_PROJECT_FORMAT_MESSAGE);
    expect(b.x.db.t('productComponent')).toHaveLength(9);
  });
});

describe('from an OrcaSlicer project', () => {
  it('four slots → a multicolour part: no material of its own, one ComponentMaterial per slot with the filament chosen', async () => {
    const { x, svc } = setup(await project(FOUR), 'Zelda keychain.3mf');
    // The owner overrides the file's own match for slot 2 (Red → Crimson).
    const materials = { ...FOUR_MATERIALS, '1': M.crimson };
    x.db.insert('material', { id: M.crimson, name: 'PLA Crimson', type: 'PLA', color: 'Crimson', colorHex: '#91202B', brand: null, costPerGram: 0.012 });
    x.profiles.filaments.set(M.crimson, { name: 'Generic PLA' });
    const out = await svc.create(P, body({ description: 'Zelda keychain', materials, printerId: K1 }));
    const c = comp(x, out.componentId);
    expect(c).toMatchObject({ description: 'Zelda keychain', isMultiColor: true, materialId: null, colorChanges: 0, gramsUsed: PLACEHOLDER_GRAMS, printMinutes: 0, sourceKind: 'THREEMF' });
    expect(mats(x, c.id).map((m: any) => [m.colorIndex, m.materialId, m.gramsUsed, m.sortOrder])).toEqual([
      [0, M.black, 0.025, 0], [1, M.crimson, 0.025, 1], [2, M.white, 0.025, 2], [3, M.gold, 0.025, 3],
    ]);
    expect(out.source).toMatchObject({ kind: 'THREEMF', filename: 'Zelda keychain.3mf', printerId: HI, printerModel: 'Creality Hi' });
    expect(out.source.slots.map((s) => s.materialId)).toEqual([M.black, M.crimson, M.white, M.gold]);
    // Locked to the project's printer, whatever the body asked for.
    expect(out.validationRun).toMatchObject({
      printerId: HI, unitsRequested: 1, status: 'QUEUED',
      filamentMap: { '0': { materialId: M.black }, '1': { materialId: M.crimson }, '2': { materialId: M.white }, '3': { materialId: M.gold } },
    });
    expect(out.notice).toBeNull();
  });

  it('the validation slice then writes each colour\'s grams, the filament changes, the total and the minutes, and reprices', async () => {
    const { x, svc } = setup(await project(FOUR), 'Zelda keychain.3mf');
    const out = await svc.create(P, body({ materials: FOUR_MATERIALS }));
    const recalc = jest.spyOn(x.h.pricing, 'recalcPricing');
    x.sidecar.slice.mockResolvedValue({ ok: true, gcode: gcode({ labels: labels('zelda', 1), minutes: 47, totalGrams: 8, toolGrams: [5, 1.5, 1, 0.5], changes: 62 }), plateFiles: 1 });
    await x.processor.tick();
    expect(x.run(out.validationRun!.id)).toMatchObject({ status: 'DONE', unitsSliced: 1 });
    expect(comp(x, out.componentId)).toMatchObject({ gramsUsed: 8, printMinutes: 47, colorChanges: 62, isMultiColor: true });
    expect(mats(x, out.componentId).map((m: any) => m.gramsUsed)).toEqual([5, 1.5, 1, 0.5]);
    expect(recalc).toHaveBeenCalledWith(P);
    expect(x.gateway.server.emit).toHaveBeenCalledWith('slice-run', expect.objectContaining({ id: out.validationRun!.id, status: 'DONE', unitsSliced: 1 }));
  });

  it('one slot → a single-material part', async () => {
    const { x, svc } = setup(await project(ONE), 'Tag.3mf');
    const out = await svc.create(P, body({ description: 'Tag', materials: { '0': M.red } }));
    expect(comp(x, out.componentId)).toMatchObject({ isMultiColor: false, materialId: M.red, sourceKind: 'THREEMF', gramsUsed: PLACEHOLDER_GRAMS });
    expect(mats(x, out.componentId)).toHaveLength(0);
    expect(out.validationRun).toMatchObject({ printerId: HI, filamentMap: { '0': { materialId: M.red } } });
  });

  it('a slot without a filament → 400 SLOT_UNMAPPED naming it; a slot the project does not have → 400; nothing created', async () => {
    const { x, svc, chunk } = setup(await project(FOUR), 'Zelda.3mf');
    const { '2': _third, ...three } = FOUR_MATERIALS;
    await expect(svc.create(P, body({ materials: three }))).rejects.toThrow('SLOT_UNMAPPED: Slot 3 has no filament');
    expect(await statusOf(svc.create(P, body({ materials: three })))).toBe(400);
    const one = setup(await project(ONE), 'Tag.3mf');
    await expect(one.svc.create(P, body({ materials: { '0': M.black, '1': M.red } }))).rejects.toThrow('Slot 2 is not used by this project');
    expect(x.db.t('productComponent')).toHaveLength(9);
    expect(x.db.t('attachment')).toHaveLength(0);
    expect(chunk.discard).not.toHaveBeenCalled();
  });

  it('a project for a printer the shop does not have → 400 naming the model; nothing created', async () => {
    const { x, svc } = setup(await project({ ...FOUR, printer_model: 'Bambu Lab X1 Carbon' }), 'Zelda.3mf');
    await expect(svc.create(P, body({ materials: FOUR_MATERIALS, printerId: K1 }))).rejects.toThrow('This project is for Bambu Lab X1 Carbon, which matches none of your printers');
    expect(await statusOf(svc.create(P, body({ materials: FOUR_MATERIALS })))).toBe(400);
    expect(x.db.t('productComponent')).toHaveLength(9);
    expect(fs.readdirSync(dirOf())).toHaveLength(0);
  });

  it('the run cannot be queued (a filament without a profile) → the part and its source stay, the notice is the sentence', async () => {
    const { x, svc, chunk } = setup(await project(FOUR), 'Zelda.3mf');
    x.profiles.filaments.delete(M.white);
    const out = await svc.create(P, body({ materials: FOUR_MATERIALS }));
    expect(out).toMatchObject({ validationRun: null, notice: '"PLA White" has no filament profile — map one in Settings › Slicer' });
    expect(comp(x, out.componentId)).toMatchObject({ isMultiColor: true, sourceAttachmentId: out.source.attachmentId });
    expect(mats(x, out.componentId)).toHaveLength(4);
    expect(x.db.t('sliceRun')).toHaveLength(0);
    expect(chunk.discard).toHaveBeenCalledWith(UPLOAD);
  });

  it('a crash while queueing that is not an HTTP error is not swallowed', async () => {
    const { x, svc } = setup(stl(), 'box.stl');
    jest.spyOn(x.service, 'create').mockRejectedValue(new Error('db down'));
    await expect(svc.create(P, body())).rejects.toThrow('db down');
  });
});

describe('roles', () => {
  const guard = new RolesGuard(new Reflector());
  const allowed = (handler: Function, role: string) =>
    guard.canActivate({ getHandler: () => handler, getClass: () => ProductSourcesController, switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }) } as any);

  it.each(['inspect', 'createFromModel'] as const)('%s: ADMIN only — VIEWER, OPERATOR and ACCOUNTING are refused (403)', (name) => {
    const handler = ProductSourcesController.prototype[name];
    expect(allowed(handler, 'ADMIN')).toBe(true);
    for (const role of ['VIEWER', 'OPERATOR', 'ACCOUNTING']) expect(allowed(handler, role)).toBe(false);
  });

  it('the controller hands the body to the services untouched', async () => {
    const sources = { inspect: jest.fn(async () => 'i') };
    const fromModel = { create: jest.fn(async () => 'c') };
    const ctrl = new ProductSourcesController(sources as any, fromModel as any);
    await expect(ctrl.inspect(P, { assembledUploadId: UPLOAD })).resolves.toBe('i');
    await expect(ctrl.createFromModel(P, body())).resolves.toBe('c');
    expect(sources.inspect).toHaveBeenCalledWith(P, { assembledUploadId: UPLOAD });
    expect(fromModel.create).toHaveBeenCalledWith(P, body());
  });
});
