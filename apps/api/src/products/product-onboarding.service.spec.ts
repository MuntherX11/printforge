import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { M, OPT, SLOT, sardineRow } from '../catalog-core/__fixtures__/sardine-tin';
import { makePng } from '../common/utils/__fixtures__/test-images';
import { GcodeParserService } from '../file-parser/gcode-parser.service';
import { ThreeMfParserService } from '../file-parser/threemf-parser.service';
import { productsHarness, statusOf } from './__fixtures__/products-harness';
import { gcode, labels, threeMf } from './__fixtures__/slicer-files';
import { ProductImportsController } from './product-imports.controller';
import { COLOUR_TARGET, ProductOnboardingService, type ImportOptions } from './product-onboarding.service';
import { parseGcodeImport, parseThreeMfImport } from './slicer-import-input';
import { hexToColorName, matchMaterial, normaliseMaterialType } from './slicer-materials';

/** §7.1 item 16, item 26 (import), item 33 (import half) and the M1/M2 rows of item 37. */

const P = 'p-sardine';
const UPLOAD = '0f8fe0a8-1111-4222-8333-944455556666';

function setup(mutate?: (row: any) => void) {
  const row = sardineRow();
  mutate?.(row);
  const h = productsHarness([row]);
  const parser = new GcodeParserService();
  const onboarding = new ProductOnboardingService(h.db as any, parser, new ThreeMfParserService(parser), h.pricing);
  return { h, onboarding };
}

const opts = (o: Partial<ImportOptions> = {}): ImportOptions => ({ sizeOptionId: null, units: new Map(), targets: new Map(), ...o });
const file = (name: string, buffer: Buffer) => ({ originalname: name, buffer });
const comps = (h: any) => h.db.t('productComponent');
const newComps = (h: any) => comps(h).filter((c: any) => !/^c\d$/.test(c.id));

let dir: string;
const prevDir = process.env.UPLOAD_DIR;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-import-'));
  process.env.UPLOAD_DIR = dir;
});
afterEach(() => {
  process.env.UPLOAD_DIR = prevDir;
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});
const isDate = (d: unknown) => d != null && Object.prototype.toString.call(d) === '[object Date]' && !Number.isNaN(new Date(d as any).getTime());
const filesOnDisk = () => fs.readdirSync(dir, { recursive: true } as any).map(String).filter((f) => /\.(gcode|png)$/.test(f));

// ------------------------------------------------------------------ materials

describe('material matching (§3.12)', () => {
  it('type normalisation table', () => {
    const table: Array<[string | undefined, string]> = [
      ['PLA', 'PLA'], ['pla', 'PLA'], ['PLA-CF', 'PLA'], ['PETG-CF', 'PETG'], ['PLA+', 'PLA'], ['ABS', 'ABS'], ['PETG HF', 'PETG'],
      ['PA', 'NYLON'], ['PA6', 'NYLON'], ['PA12', 'NYLON'], ['PAHT', 'NYLON'], ['PA-CF', 'NYLON'], ['PA12-CF', 'NYLON'],
      ['PC', 'OTHER'], ['PVA', 'OTHER'], ['HIPS', 'OTHER'], [undefined, 'PLA'],
    ];
    for (const [raw, want] of table) expect([raw, normaliseMaterialType(raw)]).toEqual([raw, want]);
  });

  it('hex match: exact first, then the nearest ΔE ≤ 10 of the same type, then the legacy name', () => {
    const mats = [
      { id: 'a', name: 'PLA Black', type: 'PLA', color: 'Black', colorHex: '111111' },
      { id: 'b', name: 'PLA Charcoal', type: 'PLA', color: 'Grey', colorHex: '1A1A1A' },
      { id: 'c', name: 'PETG Black', type: 'PETG', color: 'Black', colorHex: '161616' },
      { id: 'd', name: 'PLA Red', type: 'PLA', color: 'Red', colorHex: null },
    ];
    expect(matchMaterial(mats, 'PLA', '#1a1a1a')?.id).toBe('b');
    expect(matchMaterial(mats, 'PLA', '#131313')?.id).toBe('a');
    expect(matchMaterial(mats, 'PETG', '#101010FF')?.id).toBe('c');
    expect(matchMaterial(mats, 'PLA', '#FE0101')?.id).toBe('d');
    expect(hexToColorName('FE0101')).toBe('Red');
    expect(matchMaterial(mats, 'PLA', '#00FF00')).toBeNull();
    expect(matchMaterial(mats, 'PLA', null)?.id).toBe('a');
    expect(matchMaterial(mats, 'TPU', null)).toBeNull();
  });

  it('an import matches an existing filament within ΔE 10 and creates none', async () => {
    const { h, onboarding } = setup();
    const out = await onboarding.onboardFromGcode(P, [file('Tray.gcode', gcode({ minutes: 30, toolGrams: [12], types: ['PLA'], colours: ['#161616'] }))], opts());
    expect(out.createdMaterials).toEqual([]);
    expect(newComps(h)[0].materialId).toBe(M.black);
  });

  it('an unknown filament is created with its hex and reported; the product then has MATERIAL_ZERO_COST and keeps its price', async () => {
    const { h, onboarding } = setup();
    const out = await onboarding.onboardFromGcode(P, [file('Glow.gcode', gcode({ minutes: 30, toolGrams: [12], types: ['PA12-CF'], colours: ['#00FF00'] }))], opts());
    expect(out.createdMaterials).toEqual([{ id: expect.any(String), name: 'PA12-CF Green', colorHex: '00FF00' }]);
    const m = h.db.t('material').find((x: any) => x.id === out.createdMaterials[0].id);
    expect(m).toMatchObject({ type: 'NYLON', costPerGram: 0, color: 'Green' });
    const standard = (await h.pricing.optionCosts(P)).find((o) => o.sizeOptionId === null)!;
    expect(standard.problems).toContainEqual(expect.objectContaining({ code: 'MATERIAL_ZERO_COST', materialId: m.id }));
    expect(standard.complete).toBe(false);
    expect(h.db.t('product')[0].basePrice).toBe(1.5);
  });
});

// ------------------------------------------------------------------- G-code

describe('G-code import', () => {
  it('a zero-gram file is skipped with its reason; nothing stored for it', async () => {
    const { h, onboarding } = setup();
    const out = await onboarding.onboardFromGcode(P, [file('Empty.gcode', gcode({ minutes: 10 }))], opts());
    expect(out.skipped).toEqual([{ fileName: 'Empty.gcode', reason: 'no filament weight in file' }]);
    expect(newComps(h)).toHaveLength(0);
    expect(filesOnDisk()).toEqual([]);
  });

  it('stores the file with a server-set mime; used tools only; product.colorChanges untouched', async () => {
    const { h, onboarding } = setup();
    const buf = gcode({ minutes: 297, toolGrams: [89.56, 0, 3.13, 1.56], totalGrams: 94.25, changes: 6, types: ['PLA', 'PLA', 'PLA', 'PLA'], colours: ['#C4402A', '#FFFFFF', '#FFFFFF', '#111111'] });
    const out = await onboarding.onboardFromGcode(P, [file('Red fish.gcode', buf)], opts());
    const c = newComps(h)[0];
    expect(c).toMatchObject({ description: 'Red fish', isMultiColor: true, materialId: null, colorChanges: 2, gcodeFilename: 'Red fish.gcode' });
    expect(h.db.t('componentMaterial').filter((m: any) => m.componentId === c.id).map((m: any) => m.colorIndex)).toEqual([0, 2, 3]);
    const att = h.db.t('attachment').find((a: any) => a.id === c.attachmentId);
    expect(att.mimeType).toBe('application/octet-stream');
    expect(fs.readFileSync(path.join(dir, att.storagePath))).toEqual(buf);
    expect(h.db.t('product')[0].colorChanges).toBe(0);
    expect(out.results).toEqual([{ fileName: 'Red fish.gcode', name: 'Red fish', componentsCreated: 1, componentId: c.id }]);
  });

  it('a file with 12 objects imported as units 1 warns; ×12 via units creates a per-unit component and a layout', async () => {
    const { h, onboarding } = setup((r) => { r.components = r.components.filter((c: any) => c.id !== 'c1'); });
    const buf = gcode({ labels: labels('box', 12), minutes: 243, toolGrams: [112.8], totalGrams: 112.8, types: ['PLA'], colours: ['#111111'] });
    const one = await onboarding.onboardFromGcode(P, [file('Box x 12.gcode', buf)], opts());
    expect(one.warnings.find((w) => w.code === 'MULTIPLE_OBJECTS')?.message)
      .toBe('"Box x 12" file contains 12 objects — if this is a multi-unit plate, set its units on the plate');

    const out = await onboarding.onboardFromGcode(P, [file('Box x 12.gcode', buf)], opts({ units: new Map([[0, 12]]) }));
    const c = comps(h).find((x: any) => x.id === out.results[0].componentId);
    expect(c).toMatchObject({ gramsUsed: 9.4, printMinutes: 20.3, attachmentId: null, gcodeFilename: null });
    const layout = h.db.t('plateLayout').find((l: any) => l.componentId === c.id);
    expect(layout).toMatchObject({ unitsPerPlate: 12, plateMinutes: 243, plateGrams: 112.8, source: 'GCODE', objectCount: 12, name: '×12' });
    expect(c.perUnitEstimatedFromLayoutId).toBe(layout.id);
    expect(h.db.t('attachment').find((a: any) => a.id === layout.attachmentId).mimeType).toBe('application/octet-stream');
    expect(out.layoutsCreated).toEqual([{ componentId: c.id, layoutId: layout.id, unitsPerPlate: 12 }]);
    expect(out.warnings.map((w) => w.code)).not.toContain('UNITS_DIFFER_FROM_LABELS');
  });

  it('a failed DB write unlinks every stored file and leaves no Attachment rows', async () => {
    const { h, onboarding } = setup();
    jest.spyOn(h.db.componentMaterial, 'create').mockRejectedValueOnce(new Error('deadlock detected'));
    const files = [
      file('A.gcode', gcode({ minutes: 30, toolGrams: [10], types: ['PLA'], colours: ['#111111'] })),
      file('B.gcode', gcode({ minutes: 30, toolGrams: [5, 5], types: ['PLA', 'PLA'], colours: ['#111111', '#FFFFFF'] })),
    ];
    const before = comps(h).length;
    await expect(onboarding.onboardFromGcode(P, files, opts())).rejects.toThrow('deadlock detected');
    expect(filesOnDisk()).toEqual([]);
    expect(h.db.t('attachment')).toHaveLength(0);
    expect(comps(h)).toHaveLength(before);
  });

  it('a disk write failure → 400 naming the file, nothing imported', async () => {
    const { h, onboarding } = setup();
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    process.env.UPLOAD_DIR = blocker;
    await expect(onboarding.onboardFromGcode(P, [file('A.gcode', gcode({ minutes: 30, toolGrams: [10] }))], opts()))
      .rejects.toThrow('Couldn\'t store "A.gcode" — nothing was imported');
    expect(newComps(h)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------- 3MF

describe('3MF import', () => {
  const plate1 = gcode({ labels: labels('tray', 1), minutes: 30, toolGrams: [0, 0, 12.5, 0], totalGrams: 12.5, types: ['PLA', 'PLA', 'PETG', 'PLA'], colours: ['#FFFFFF', '#111111', '#C4402A', '#2040C0'] });

  it('a 4-slot AMS plate with one used tool → single-material component, plate G-code stored as its file', async () => {
    const { h, onboarding } = setup();
    const buf = await threeMf([{ index: 1, seconds: 1800, weight: 12.5, gcode: plate1 }]);
    const out = await onboarding.onboardFromThreeMf(P, buf, { ...opts(), selectedPlates: [1], plateNames: { 1: 'Tray' } });
    const c = newComps(h)[0];
    expect(c).toMatchObject({ description: 'Tray', isMultiColor: false, gramsUsed: 12.5, printMinutes: 30, gcodeFilename: 'Tray.gcode' });
    expect(h.db.t('material').find((m: any) => m.id === c.materialId)).toMatchObject({ type: 'PETG' });
    expect(h.db.t('componentMaterial').filter((m: any) => m.componentId === c.id)).toHaveLength(0);
    const att = h.db.t('attachment').find((a: any) => a.id === c.attachmentId);
    expect(att.mimeType).toBe('application/octet-stream');
    expect(fs.readFileSync(path.join(dir, att.storagePath))).toEqual(plate1);
    expect(out.results[0]).toMatchObject({ plateIndex: 1, name: 'Tray', componentsCreated: 1 });
  });

  it('the plate thumbnail → component.thumbnailAttachmentId, pre-marked, never a ProductImage or imageUrl', async () => {
    const { h, onboarding } = setup();
    const png = makePng({ width: 64, height: 64 });
    const buf = await threeMf([{ index: 1, seconds: 1800, weight: 12.5, gcode: plate1, png }]);
    await onboarding.onboardFromThreeMf(P, buf, { ...opts(), selectedPlates: [1] });
    const c = newComps(h)[0];
    const att = h.db.t('attachment').find((a: any) => a.id === c.thumbnailAttachmentId);
    expect(att).toMatchObject({ mimeType: 'image/png', originalName: 'Plate 1 thumbnail' });
    expect(isDate(att.photoMigratedAt)).toBe(true);
    expect(att.filename).toMatch(/^plate-1-\d+\.png$/);
    expect(h.db.t('productImage')).toHaveLength(0);
    expect(h.db.t('product')[0].imageUrl).toBeNull();
  });

  it('a thumbnail that is not a PNG is dropped with a warning', async () => {
    const { h, onboarding } = setup();
    const buf = await threeMf([{ index: 1, seconds: 1800, weight: 12.5, gcode: plate1, png: Buffer.from('<svg/>') }]);
    const out = await onboarding.onboardFromThreeMf(P, buf, { ...opts(), selectedPlates: [1] });
    expect(newComps(h)[0].thumbnailAttachmentId).toBeNull();
    expect(out.warnings.map((w) => w.code)).toContain('THUMBNAIL_DROPPED');
  });

  it('an unsliced plate that was selected is imported as a placeholder (warning, not skipped)', async () => {
    const { h, onboarding } = setup();
    const buf = await threeMf([{ index: 1, seconds: 1800, weight: 12.5, gcode: plate1 }, { index: 2 }], { sliceInfo: true });
    const out = await onboarding.onboardFromThreeMf(P, buf, { ...opts(), selectedPlates: [1, 2], plateNames: { 2: 'Lid design' } });
    const lid = newComps(h).find((c: any) => c.description === 'Lid design');
    expect(lid).toMatchObject({ gramsUsed: 0, printMinutes: 0, attachmentId: null, materialId: null, isMultiColor: false });
    expect(out.skipped).toEqual([]);
    expect(out.warnings).toContainEqual({ code: 'PLATE_NOT_SLICED', message: 'Plate 2 "Lid design" isn\'t sliced — its weight and time are 0 until you enter them or re-import it sliced' });
  });

  it('a ×12 plate (units 12, 243 min / 112.8 g) → 9.4 g / 20.3 min per unit and a ×12 GCODE layout', async () => {
    const { h, onboarding } = setup();
    const g = gcode({ labels: labels('sardines_base_v2', 12), minutes: 243, toolGrams: [112.8], totalGrams: 112.8, types: ['PLA'], colours: ['#111111'] });
    const buf = await threeMf([{ index: 1, seconds: 243 * 60, weight: 112.8, gcode: g }]);
    const analysis = await new ThreeMfParserService(new GcodeParserService()).parse(buf);
    expect(analysis.plates[0]).toMatchObject({ objectCount: 12, objectModels: [{ model: 'sardines base v2', count: 12 }], ignoredLabels: [] });

    const out = await onboarding.onboardFromThreeMf(P, buf, { ...opts({ units: new Map([[1, 12]]) }), selectedPlates: [1], plateNames: { 1: 'Box' } });
    const c = newComps(h)[0];
    expect(c).toMatchObject({ gramsUsed: 9.4, printMinutes: 20.3, attachmentId: null });
    expect(isDate(c.stockConfirmedAt)).toBe(true);
    const layout = h.db.t('plateLayout').find((l: any) => l.componentId === c.id);
    expect(layout).toMatchObject({ unitsPerPlate: 12, plateMinutes: 243, plateGrams: 112.8, source: 'GCODE', objectCount: 12, gcodeFilename: 'Box.gcode' });
    expect(c.perUnitEstimatedFromLayoutId).toBe(layout.id);
    expect(fs.readFileSync(path.join(dir, h.db.t('attachment').find((a: any) => a.id === layout.attachmentId).storagePath))).toEqual(g);
    expect(out.layoutsCreated).toEqual([{ componentId: c.id, layoutId: layout.id, unitsPerPlate: 12 }]);
    const standard = (await h.pricing.optionCosts(P)).find((o) => o.sizeOptionId === null)!;
    expect([...standard.problems, ...standard.warnings].map((w) => w.code)).toContain('PER_UNIT_ESTIMATED');
  });

  it('add to an existing component: only a layout, no new component; foreign component → 400; duplicate size → 409', async () => {
    const { h, onboarding } = setup();
    const g = gcode({ labels: labels('key', 20), minutes: 110, toolGrams: [30], totalGrams: 30, types: ['PLA'], colours: ['#C0C0C0'] });
    const buf = await threeMf([{ index: 1, seconds: 6600, weight: 30, gcode: g }]);
    const before = comps(h).length;
    const out = await onboarding.onboardFromThreeMf(P, buf, { ...opts({ units: new Map([[1, 20]]), targets: new Map([[1, 'c4']]) }), selectedPlates: [1] });
    expect(comps(h)).toHaveLength(before);
    const layout = h.db.t('plateLayout').find((l: any) => l.componentId === 'c4' && l.unitsPerPlate === 20);
    expect(layout).toMatchObject({ source: 'GCODE', plateGrams: 30 });
    expect(out.layoutsCreated).toEqual([{ componentId: 'c4', layoutId: layout.id, unitsPerPlate: 20 }]);
    expect(out.warnings.map((w) => w.code)).not.toContain('SLOTS_DIFFER');

    await expect(onboarding.onboardFromThreeMf(P, buf, { ...opts({ units: new Map([[1, 20]]), targets: new Map([[1, 'c4']]) }), selectedPlates: [1] }))
      .rejects.toThrow('A ×20 layout already exists for "Key"');
    // A component of the Large size is foreign to a standard-size import; another product's component too.
    await expect(onboarding.onboardFromThreeMf(P, buf, { ...opts({ targets: new Map([[1, 'c9']]) }), selectedPlates: [1] }))
      .rejects.toThrow('That component belongs to another product or option');
    h.db.insert('product', { id: 'p-other', name: 'Other' });
    h.db.insert('productComponent', { id: 'x1', productId: 'p-other', variantId: null, description: 'X', gramsUsed: 1, sortOrder: 0, materialId: M.black });
    await expect(onboarding.onboardFromThreeMf(P, buf, { ...opts({ targets: new Map([[1, 'x1']]) }), selectedPlates: [1] }))
      .rejects.toThrow('That component belongs to another product or option');
    expect(filesOnDisk()).toHaveLength(1);
  });

  it('a plate sliced without embedded G-code takes its filaments from slice_info (no file, used tools only)', async () => {
    const { h, onboarding } = setup();
    const buf = await threeMf([{ index: 1, seconds: 26617, weight: 307.52, filaments: [{ id: 2, type: 'PLA', color: '#111111', grams: 307.52 }] }]);
    const analysis = await new ThreeMfParserService(new GcodeParserService()).parse(buf);
    expect(analysis.plates[0].tools).toEqual([{ index: 1, filamentGrams: 307.52, colorHex: '#111111', materialType: 'PLA' }]);
    expect(await new ThreeMfParserService(new GcodeParserService()).extractPlateGcode(buf, 1)).toBeNull();
    await onboarding.onboardFromThreeMf(P, buf, { ...opts(), selectedPlates: [1], plateNames: { 1: 'Ball' } });
    expect(newComps(h)[0]).toMatchObject({ description: 'Ball', materialId: M.black, isMultiColor: false, gramsUsed: 307.52, printMinutes: 444, attachmentId: null, gcodeFilename: null });
  });

  it('a plate the file does not have → 400', async () => {
    const { onboarding } = setup();
    const buf = await threeMf([{ index: 1, seconds: 1800, weight: 12.5, gcode: plate1 }]);
    await expect(onboarding.onboardFromThreeMf(P, buf, { ...opts(), selectedPlates: [1, 3] })).rejects.toThrow("Plate 3 isn't in this file");
  });
});

// ------------------------------------------------------------ targets and links

describe('size target, locks and colour links (§3.12, §7.1 item 26)', () => {
  const black = gcode({ minutes: 70, toolGrams: [21], types: ['PLA'], colours: ['#111111'] });
  const lid = gcode({ minutes: 45, toolGrams: [12.5, 1.6], types: ['PLA', 'PLA'], colours: ['#111111', '#C0C0C0'] });
  const white = gcode({ minutes: 10, toolGrams: [2], types: ['PLA'], colours: ['#FFFFFF'] });

  it('SIZE target (and the variantId alias): components under the size, FOR SHARE lock, stockConfirmedAt set', async () => {
    const { h, onboarding } = setup();
    expect(parseGcodeImport({ variantId: OPT.large }, 1).sizeOptionId).toBe(OPT.large);
    expect(parseThreeMfImport({ sizeOptionId: OPT.large, selectedPlates: '[1]' }).sizeOptionId).toBe(OPT.large);
    await onboarding.onboardFromGcode(P, [file('XL Box.gcode', black)], opts({ sizeOptionId: OPT.large }));
    const c = newComps(h)[0];
    expect(c).toMatchObject({ variantId: OPT.large, sortOrder: 4 });
    expect(isDate(c.stockConfirmedAt)).toBe(true);
    expect(h.db.locks).toContainEqual({ table: 'ProductVariant', mode: 'SHARE', ids: [OPT.large] });
  });

  it('a COLOUR target → 400 and nothing written', async () => {
    const { h, onboarding } = setup();
    await expect(onboarding.onboardFromGcode(P, [file('X.gcode', black)], opts({ sizeOptionId: OPT.red }))).rejects.toThrow(COLOUR_TARGET);
    expect(newComps(h)).toHaveLength(0);
    expect(filesOnDisk()).toEqual([]);
  });

  it('by filament: a material linked only to "Tin" is linked to Tin; one whose decided slots are all Fixed → Fixed', async () => {
    const { h, onboarding } = setup((r) => { r.components = r.components.filter((c: any) => c.id !== 'c5'); });
    const out = await onboarding.onboardFromGcode(P, [file('Tray.gcode', black), file('Pearl.gcode', white)], opts());
    const [tray, pearl] = newComps(h);
    expect(tray).toMatchObject({ colourSlotId: SLOT.tin, colourFixed: null });
    expect(pearl).toMatchObject({ colourSlotId: null, colourFixed: true });
    expect(out.warnings.filter((w) => w.code.startsWith('COLOUR_'))).toEqual([]);
  });

  it('the Sardine Large import links Large Box and Large Lid colour 0 to Tin by position (PLA Black is split Tin/Band)', async () => {
    const { h, onboarding } = setup((r) => { r.components = r.components.filter((c: any) => c.variantId === null); });
    const out = await onboarding.onboardFromGcode(P, [file('Large Box.gcode', black), file('Large Lid.gcode', lid)], opts({ sizeOptionId: OPT.large }));
    const [box, lidC] = newComps(h);
    expect(box).toMatchObject({ description: 'Large Box', variantId: OPT.large, colourSlotId: SLOT.tin });
    const cms = h.db.t('componentMaterial').filter((m: any) => m.componentId === lidC.id);
    expect(cms.map((m: any) => [m.colorIndex, m.colourSlotId])).toEqual([[0, SLOT.tin], [1, SLOT.trim]]);
    expect(out.warnings).toContainEqual({
      code: 'COLOUR_LINKED_BY_POSITION',
      message: '2 parts linked by position (Large Box → Tin, Large Lid colour 1 → Tin) — check them in Edit links',
    });
  });

  it('no positional match and a split material → unlinked with COLOUR_SLOT_NOT_LINKED', async () => {
    const { h, onboarding } = setup();
    const out = await onboarding.onboardFromGcode(P, [file('Ribbon.gcode', black)], opts());
    expect(newComps(h)[0]).toMatchObject({ colourSlotId: null, colourFixed: null });
    expect(out.warnings).toContainEqual({
      code: 'COLOUR_SLOT_NOT_LINKED',
      message: '"Ribbon" colour 1 (PLA Black) isn\'t linked to a colour slot — colours won\'t change it and won\'t be offered on Regular in the shop; link it in Edit links',
    });
  });
});

describe('O7 vs an import onto size V (§7.1 item 33, import half)', () => {
  const black = gcode({ minutes: 70, toolGrams: [21], types: ['PLA'], colours: ['#111111'] });
  const withV = (r: any) => {
    r.variants.push({ id: 'v-x', productId: P, name: 'XL', sku: null, kind: 'SIZE', isActive: true, sortOrder: 5, basePrice: null, estimatedGrams: null, estimatedMinutes: null, createdAt: new Date(), colourAssignments: [], sizeExclusions: [] });
  };

  it('import first → O7 409 (own components)', async () => {
    const { h, onboarding } = setup(withV);
    await onboarding.onboardFromGcode(P, [file('XL Box.gcode', black)], opts({ sizeOptionId: 'v-x' }));
    expect(await statusOf(h.variants.setKinds(P, { changes: [{ variantId: 'v-x', kind: 'COLOUR' }] }))).toBe(409);
  });

  it('O7 first → the import is 400 and no component is created under a colour', async () => {
    const { h, onboarding } = setup(withV);
    await h.variants.setKinds(P, { changes: [{ variantId: 'v-x', kind: 'COLOUR' }] });
    await expect(onboarding.onboardFromGcode(P, [file('XL Box.gcode', black)], opts({ sizeOptionId: 'v-x' }))).rejects.toThrow(COLOUR_TARGET);
    expect(comps(h).filter((c: any) => c.variantId === 'v-x')).toHaveLength(0);
  });

  it('the kind is re-read under the lock: a size reclassified after the pre-check still refuses', async () => {
    const { h, onboarding } = setup(withV);
    const orig = h.db.$queryRaw.getMockImplementation();
    h.db.$queryRaw.mockImplementation(async (sql: any) => {
      const rows = await orig(sql);
      return String(sql.sql ?? sql).includes('lock:ProductVariant:SHARE') ? rows.map((r: any) => ({ ...r, kind: 'COLOUR' })) : rows;
    });
    await expect(onboarding.onboardFromGcode(P, [file('XL Box.gcode', black)], opts({ sizeOptionId: 'v-x' }))).rejects.toThrow(COLOUR_TARGET);
    expect(comps(h).filter((c: any) => c.variantId === 'v-x')).toHaveLength(0);
    expect(filesOnDisk()).toEqual([]);
  });
});

// ------------------------------------------------------- controller: consume/discard

describe('M1/M2 staged uploads: validate first, keep on failure, discard after commit', () => {
  function controller(onboarding: any, fileName = 'proj.3mf') {
    const chunk = {
      consume: jest.fn(async (): Promise<{ originalname: string; buffer: Buffer }> => ({ originalname: fileName, buffer: Buffer.from("x") })),
      discard: jest.fn(async () => undefined),
    };
    const products = { findOne: jest.fn(async () => ({ id: P })) };
    return { ctrl: new ProductImportsController(products as any, onboarding, chunk as any), chunk };
  }

  it('M2: a bad field → 400 before the staged upload is read', async () => {
    const onboarding = { onboardFromThreeMf: jest.fn() };
    const { ctrl, chunk } = controller(onboarding);
    await expect(ctrl.onboardThreeMf(P, undefined, { selectedPlates: '[1]', units: '{"1": 501}' }, UPLOAD)).rejects.toThrow('"units[1]" must be between 1 and 500');
    expect(chunk.consume).not.toHaveBeenCalled();
    expect(chunk.discard).not.toHaveBeenCalled();
  });

  it('M2: a plate the file does not have → 400 and the staged upload is kept for a retry', async () => {
    const { onboarding } = setup();
    const buf = await threeMf([{ index: 1, seconds: 60, weight: 1, gcode: gcode({ minutes: 1, toolGrams: [1] }) }]);
    const { ctrl, chunk } = controller(onboarding);
    chunk.consume.mockResolvedValue({ originalname: 'proj.3mf', buffer: buf });
    await expect(ctrl.onboardThreeMf(P, undefined, { selectedPlates: '[1,2]' }, UPLOAD)).rejects.toThrow("Plate 2 isn't in this file");
    expect(chunk.consume).toHaveBeenCalledWith(UPLOAD, expect.any(Number), { keep: true });
    expect(chunk.discard).not.toHaveBeenCalled();
    await ctrl.onboardThreeMf(P, undefined, { selectedPlates: '[1]' }, UPLOAD);
    expect(chunk.discard).toHaveBeenCalledWith(UPLOAD);
  });

  it('M2: .3mf required', async () => {
    const { ctrl, chunk } = controller({ onboardFromThreeMf: jest.fn() }, 'proj.stl');
    await expect(ctrl.onboardThreeMf(P, undefined, { selectedPlates: '[1]' }, UPLOAD)).rejects.toThrow('File must be a .3mf');
    expect(chunk.discard).not.toHaveBeenCalled();
  });

  it('M1: a failed import keeps every staged file; a successful one discards them', async () => {
    const onboarding = { onboardFromGcode: jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ results: [] }) };
    const { ctrl, chunk } = controller(onboarding, 'a.gcode');
    const body = { assembledUploadIds: JSON.stringify([UPLOAD]), units: '{"0": 4}' };
    await expect(ctrl.onboardGcode(P, [], body)).rejects.toThrow('boom');
    expect(chunk.consume).toHaveBeenCalledWith(UPLOAD, expect.any(Number), { keep: true });
    expect(chunk.discard).not.toHaveBeenCalled();
    const out = await ctrl.onboardGcode(P, [], body);
    expect(chunk.discard).toHaveBeenCalledWith(UPLOAD);
    expect(out.product).toEqual({ id: P });
    expect(onboarding.onboardFromGcode.mock.calls[1][2].units.get(0)).toBe(4);
  });

  it('M1: no files → 400', async () => {
    const { ctrl } = controller({ onboardFromGcode: jest.fn() });
    await expect(ctrl.onboardGcode(P, [], {})).rejects.toThrow('No files uploaded');
  });
});

// ------------------------------------------------------------ §7.1 item 37 (M1/M2)

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

describe('M1/M2 numeric bounds (§4.7)', () => {
  it('M1/M2 units: int 1–500', () => {
    expect(parseGcodeImport({ units: '{"0":1}' }, 1).units.get(0)).toBe(1);
    expect(parseGcodeImport({ units: { 0: 500 } }, 1).units.get(0)).toBe(500);
    expect(parseThreeMfImport({ selectedPlates: '[2]', units: '{"2":500}' }).units.get(2)).toBe(500);
    for (const bad of [0, 501, 2.5, NaN, Infinity, 'abc']) {
      rejects(() => parseGcodeImport({ units: { 0: bad } }, 1), 'units[0]');
      rejects(() => parseThreeMfImport({ selectedPlates: [2], units: { 2: bad } }), 'units[2]');
    }
  });

  it('M1 files ≤ 20; units/targets keys an index of a sent file (0–19)', () => {
    rejects(() => parseGcodeImport({ assembledUploadIds: JSON.stringify(Array.from({ length: 3 }, () => UPLOAD)) }, 18), 'At most 20 files');
    expect(() => parseGcodeImport({ targets: { 19: 'c1' } }, 20)).not.toThrow();
    rejects(() => parseGcodeImport({ targets: { 20: 'c1' } }, 20), 'targets[20]');
    rejects(() => parseGcodeImport({ units: { 2: 3 } }, 2), 'units[2]');
    rejects(() => parseGcodeImport({ units: { '-1': 3 } }, 2), 'units');
    rejects(() => parseGcodeImport({ units: '{bad' }, 1), '"units" must be valid JSON');
    rejects(() => parseGcodeImport({ targets: { 0: 5 } }, 1), 'targets[0]');
  });

  it('M2 selectedPlates: 1–100 distinct ints; targets/units keys must be selected plates', () => {
    expect(parseThreeMfImport({ selectedPlates: '[1]' }).selectedPlates).toEqual([1]);
    expect(parseThreeMfImport({ selectedPlates: Array.from({ length: 100 }, (_, i) => i + 1) }).selectedPlates).toHaveLength(100);
    rejects(() => parseThreeMfImport({ selectedPlates: '[]' }), 'No plates selected');
    rejects(() => parseThreeMfImport({ selectedPlates: Array.from({ length: 101 }, (_, i) => i + 1) }), 'selectedPlates');
    rejects(() => parseThreeMfImport({ selectedPlates: '[1,1]' }), 'selectedPlates');
    for (const bad of [1.5, -1, 'abc', null]) rejects(() => parseThreeMfImport({ selectedPlates: [bad] }), 'selectedPlates[0]');
    rejects(() => parseThreeMfImport({ selectedPlates: 'nope' }), '"selectedPlates" must be valid JSON');
    rejects(() => parseThreeMfImport({ selectedPlates: [1], targets: { 2: 'c1' } }), 'targets[2]');
    rejects(() => parseThreeMfImport({ selectedPlates: [1], units: { 3: 2 } }), 'units[3]');
  });

  it('a units value over the bound through the service path is a 400 before anything is written', async () => {
    const { h, onboarding } = setup();
    const g = gcode({ minutes: 30, toolGrams: [10] });
    await expect(onboarding.onboardFromGcode(P, [file('No time.gcode', gcode({ toolGrams: [10] }))], opts({ units: new Map([[0, 6]]) })))
      .rejects.toThrow('"No time" can\'t be a ×6 plate layout: no print time found in the file');
    expect(newComps(h)).toHaveLength(0);
    void g;
  });
});
