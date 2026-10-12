import { BadRequestException, ConflictException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as fs from 'fs';
import * as path from 'path';
import { OPT, sardineRow, SLOT } from '../catalog-core/__fixtures__/sardine-tin';
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
  const chunk = chunkStub(file, name);
  const sources = new ProductSourcesService(x.db as any, chunk as any, x.service);
  const svc = new ComponentFromModelService(x.db as any, chunk as any, sources, x.service);
  return { x, chunk, svc, sources };
}

/** A staged upload with the service's claim rule: one holder at a time, gone once discarded. */
function chunkStub(file: Buffer, name: string) {
  let claimed = false;
  let gone = false;
  return {
    consume: jest.fn(async () => {
      if (gone) throw new BadRequestException('Unknown or expired upload — start again');
      return { originalname: name, buffer: file, size: file.length };
    }),
    claim: jest.fn(async () => {
      if (claimed) throw new ConflictException('This upload is already being used');
      claimed = true;
    }),
    release: jest.fn(async () => { claimed = false; }),
    discard: jest.fn(async () => { gone = true; }),
  };
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
      pendingFirstSlice: true,
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
    expect(chunk.claim).toHaveBeenCalledWith(UPLOAD);
    expect(chunk.discard).toHaveBeenCalledWith(UPLOAD);
    // Nothing is priced on placeholder numbers: the slice processor reprices when the part is measured.
    expect(recalc).not.toHaveBeenCalled();
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
    const file = stl();
    const chunk = {
      consume: jest.fn(async () => ({ originalname: 'box.stl', buffer: file, size: file.length })),
      claim: jest.fn(async () => undefined), release: jest.fn(async () => undefined), discard: jest.fn(async () => undefined),
    };
    const slice = { assertSliceable: jest.fn(async () => undefined), create: jest.fn(async () => ({ id: 'run-1', status: 'QUEUED' })) };
    const svc = new ComponentFromModelService(h.db as any, chunk as any, new ProductSourcesService(h.db as any, chunk as any, slice as any), slice as any);
    const out = await svc.create(P, body({ variantId: OPT.large }));
    expect(slice.assertSliceable).toHaveBeenCalledWith({ kind: 'STL', meta: { printerModel: null, printerId: null, slots: [] }, printerId: K1, defaultPrinterId: null, materials: { '0': M.black } });
    expect(h.db.t('productComponent').find((c: any) => c.id === out.componentId)).toMatchObject({ variantId: OPT.large, sortOrder: 4 });
    expect(slice.create).toHaveBeenCalledWith(P, out.componentId, { printerId: K1, materials: { '0': M.black }, units: 1 }, true);
    expect(out.validationRun).toEqual({ id: 'run-1', status: 'QUEUED' });
    await expect(svc.create(P, body({ variantId: OPT.red }))).rejects.toThrow("Colours use each size's components");
    expect(await statusOf(svc.create(P, body({ variantId: 'v-none' })))).toBe(404);
    // A refused transaction gives the upload back, so the retry is not a 409.
    expect(chunk.release).toHaveBeenCalledTimes(2);
    expect(chunk.discard).toHaveBeenCalledTimes(1);
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

  it('preconditions fail (a filament without a preset) → 400 with the slice message, nothing created, the upload kept for a retry', async () => {
    const { x, svc, chunk } = setup(await project(FOUR), 'Zelda.3mf');
    x.profiles.filaments.delete(M.white);
    const attempt = svc.create(P, body({ materials: FOUR_MATERIALS }));
    await expect(attempt).rejects.toThrow('NO_FILAMENT_PROFILE: "PLA White" has no slicer preset, and there is no main preset for PLA. Set one in Settings › Slicer');
    expect(await statusOf(svc.create(P, body({ materials: FOUR_MATERIALS })))).toBe(400);
    expect(x.db.t('productComponent')).toHaveLength(9);
    expect(x.db.t('attachment')).toHaveLength(0);
    expect(x.db.t('sliceRun')).toHaveLength(0);
    expect(fs.readdirSync(dirOf())).toHaveLength(0);
    expect(chunk.claim).not.toHaveBeenCalled();
    expect(chunk.discard).not.toHaveBeenCalled();
    // The owner sets the preset in Settings and submits the same upload again.
    x.profiles.filaments.set(M.white, { name: 'Generic PLA' });
    await expect(svc.create(P, body({ materials: FOUR_MATERIALS }))).resolves.toMatchObject({ notice: null, validationRun: { status: 'QUEUED' } });
  });

  it.each([
    ['no machine profile', (x: SliceHarness) => x.profiles.machines.delete(K1), 'NO_MACHINE_PROFILE: K1 has no machine profile — import one in Settings › Slicer'],
    ['no default process (STL)', (x: SliceHarness) => x.profiles.processes.delete(K1), 'NO_PROCESS_PROFILE: K1 has no default process profile — set one in Settings › Slicer'],
    ['an inactive printer', (x: SliceHarness) => { x.db.t('printer').find((p: any) => p.id === K1).isActive = false; }, 'NO_MACHINE_PROFILE: That printer is not active'],
  ])('preconditions fail (%s) → 400, nothing created', async (_what, breakIt, message) => {
    const { x, svc, chunk } = setup(stl(), 'box.stl');
    const name = x.db.t('printer').find((p: any) => p.id === K1).name;
    breakIt(x);
    await expect(svc.create(P, body())).rejects.toThrow(message.replace('K1 has', `${name} has`));
    expect(await statusOf(svc.create(P, body()))).toBe(400);
    expect(x.db.t('productComponent')).toHaveLength(9);
    expect(x.db.t('attachment')).toHaveLength(0);
    expect(chunk.discard).not.toHaveBeenCalled();
  });

  it('an error after the part is committed is never a 500: the part stays and the notice says the first slice was not queued', async () => {
    const { x, svc, chunk } = setup(stl(), 'box.stl');
    jest.spyOn(x.service, 'create').mockRejectedValue(new Error('db down'));
    const out = await svc.create(P, body());
    expect(out.validationRun).toBeNull();
    expect(out.notice).toBe('The part was added but the first slice could not be queued: an unexpected error. Open the part and slice it again');
    expect(out.notice).not.toContain('db down');
    expect(comp(x, out.componentId)).toMatchObject({ sourceAttachmentId: out.source.attachmentId, pendingFirstSlice: true });
    expect(chunk.discard).toHaveBeenCalledWith(UPLOAD);

    // An HTTP refusal gives its own sentence, without the error code.
    const b = setup(stl(), 'box.stl');
    jest.spyOn(b.x.service, 'create').mockRejectedValue(new ConflictException('IDENTICAL_PENDING: The same slice is already queued'));
    await expect(b.svc.create(P, body())).resolves.toMatchObject({ validationRun: null, notice: 'The part was added but the first slice could not be queued: The same slice is already queued' });

    // So does a failure to clear the staged upload.
    const c = setup(stl(), 'box.stl');
    c.chunk.discard.mockRejectedValue(new Error('EBUSY'));
    const third = await c.svc.create(P, body());
    expect(third.notice).toContain('The part was added but the first slice could not be queued');
    expect(comp(c.x, third.componentId)).toBeTruthy();
  });

  it('a double submit of one upload makes one part: the second request is a 409', async () => {
    const { x, svc } = setup(stl(), 'box.stl');
    const results = await Promise.allSettled([svc.create(P, body()), svc.create(P, body())]);
    const made = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(made).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(ConflictException);
    expect(refused[0].reason.message).toBe('This upload is already being used');
    expect(x.db.t('productComponent')).toHaveLength(10);
    expect(x.db.t('attachment')).toHaveLength(1);
    expect(x.db.t('sliceRun')).toHaveLength(1);
    expect(fs.readdirSync(dirOf(), { recursive: true }).filter((f) => String(f).endsWith('.stl'))).toHaveLength(1);
  });

  it('a failed transaction releases the claim, so the same upload can be submitted again', async () => {
    const { x, svc, chunk } = setup(stl(), 'box.stl');
    x.db.$transaction.mockRejectedValueOnce(new Error('deadlock'));
    await expect(svc.create(P, body())).rejects.toThrow('deadlock');
    expect(chunk.release).toHaveBeenCalledWith(UPLOAD);
    expect(chunk.discard).not.toHaveBeenCalled();
    expect(x.db.t('productComponent')).toHaveLength(9);
    expect(fs.readdirSync(dirOf(), { recursive: true }).filter((f) => String(f).endsWith('.stl'))).toHaveLength(0);
    await expect(svc.create(P, body())).resolves.toMatchObject({ notice: null });
    expect(x.db.t('productComponent')).toHaveLength(10);
  });
});

describe('a part that is not sliced yet', () => {
  it('the cost is incomplete (PART_NOT_MEASURED), the stored price is not rewritten, and planning reports the same problem', async () => {
    const { x, svc } = setup(stl(), 'Key ring.stl');
    const before = x.db.t('product')[0].basePrice;
    const out = await svc.create(P, body({ description: 'Key ring' }));
    expect(x.db.t('product')[0].basePrice).toBe(before);

    // Any reprice while the part waits (another part was edited, a setting changed) keeps the price.
    const results = await x.h.pricing.recalcPricing(P);
    const standard = results.find((r) => r.sizeOptionId === null)!;
    expect(standard.written).toBe(false);
    expect(standard.problems).toContainEqual({ code: 'PART_NOT_MEASURED', componentId: out.componentId, message: '"Key ring" has not been sliced yet' });
    expect(standard.problems.filter((p) => p.componentId === out.componentId)).toHaveLength(1);
    expect(x.db.t('product')[0].basePrice).toBe(before);

    const bom = await x.h.resolver.resolve(P, { sizeOptionId: null, colourOptionId: null });
    expect(bom.complete).toBe(false);
    expect(bom.productionReady).toBe(false);
    expect(bom.components.find((c) => c.componentId === out.componentId)!.layouts).toHaveLength(0);
    const plan = await x.h.planner.planOption({ productId: P, sizeOptionId: null, colourOptionId: null, quantity: 3 });
    expect(plan.problems).toEqual([{ code: 'PART_NOT_MEASURED', componentId: out.componentId, message: '"Key ring" has not been sliced yet' }]);
    expect(plan.components.find((c) => c.componentId === out.componentId)).toMatchObject({ plates: [], printMinutes: 0 });
  });

  it('the validation slice measures it: the mark is cleared, the cost is complete and the price is rewritten', async () => {
    const { x, svc } = setup(stl(), 'Key ring.stl');
    const out = await svc.create(P, body({ description: 'Key ring' }));
    const before = x.db.t('product')[0].basePrice;
    x.sidecar.slice.mockResolvedValue({ ok: true, gcode: gcode({ labels: labels('key', 1), minutes: 30, totalGrams: 12, toolGrams: [12] }), plateFiles: 1 });
    await x.processor.tick();
    expect(x.run(out.validationRun!.id)).toMatchObject({ status: 'DONE' });
    expect(comp(x, out.componentId)).toMatchObject({ pendingFirstSlice: false, gramsUsed: 12, printMinutes: 30 });
    const bom = await x.h.resolver.resolve(P, { sizeOptionId: null, colourOptionId: null });
    expect(bom.problems.filter((p) => p.code === 'PART_NOT_MEASURED')).toHaveLength(0);
    expect(x.db.t('product')[0].basePrice).toBeGreaterThan(before);
  });

  it('a failed validation slice leaves the mark, and typing grams and minutes clears it', async () => {
    const { x, svc } = setup(stl(), 'Key ring.stl');
    const out = await svc.create(P, body({ description: 'Key ring' }));
    await x.processor.tick();
    expect(x.run(out.validationRun!.id)).toMatchObject({ status: 'FAILED' });
    expect(comp(x, out.componentId)).toMatchObject({ pendingFirstSlice: true, gramsUsed: PLACEHOLDER_GRAMS });
    await x.h.components.update(P, out.componentId, { gramsUsed: 9 });
    expect(comp(x, out.componentId).pendingFirstSlice).toBe(true);
    await x.h.components.update(P, out.componentId, { gramsUsed: 9, printMinutes: 25 });
    expect(comp(x, out.componentId).pendingFirstSlice).toBe(false);
  });
});

describe('colour links', () => {
  it('each colour takes the link product onboarding would give an imported part: by filament when the product links it one way, else unlinked', async () => {
    // Silver is only ever linked to Trim on this product.
    const a = setup(stl(), 'Clip.stl');
    const silver = await a.svc.create(P, body({ description: 'Clip', materials: { '0': M.silver } }));
    expect(comp(a.x, silver.componentId)).toMatchObject({ colourSlotId: SLOT.trim, colourFixed: null });
    // Black is linked to Tin on some parts and Band on another: no decision.
    const black = await setup(stl(), 'Clip.stl').svc.create(P, body({ description: 'Clip' }));
    expect(black.componentId).toBeTruthy();
    const b = setup(stl(), 'Clip.stl');
    const out = await b.svc.create(P, body({ description: 'Clip' }));
    expect(comp(b.x, out.componentId)).toMatchObject({ colourSlotId: null, colourFixed: null });
    // A multicolour part: per colour. White is fixed wherever the product uses it; gold and red are new to it.
    const c = setup(await project(FOUR), 'Zelda.3mf');
    const multi = await c.svc.create(P, body({ materials: { ...FOUR_MATERIALS, '1': M.silver } }));
    expect(mats(c.x, multi.componentId).map((m: any) => [m.colorIndex, m.colourSlotId, m.colourFixed])).toEqual([
      [0, null, null], [1, SLOT.trim, null], [2, null, true], [3, null, null],
    ]);
    expect(comp(c.x, multi.componentId)).toMatchObject({ colourSlotId: null, colourFixed: null });
  });

  it('a product without colour slots leaves the part unlinked', async () => {
    const { x, svc } = setup(stl(), 'Clip.stl');
    x.db.t('productColourSlot').length = 0;
    const out = await svc.create(P, body({ materials: { '0': M.silver } }));
    expect(comp(x, out.componentId)).toMatchObject({ colourSlotId: null, colourFixed: null });
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
