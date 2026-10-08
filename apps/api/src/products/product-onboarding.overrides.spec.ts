import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { filamentChoiceText } from '@printforge/types';
import { M, sardineRow } from '../catalog-core/__fixtures__/sardine-tin';
import { GcodeParserService } from '../file-parser/gcode-parser.service';
import { ThreeMfParserService } from '../file-parser/threemf-parser.service';
import { productsHarness, statusOf } from './__fixtures__/products-harness';
import { gcode, threeMf } from './__fixtures__/slicer-files';
import { gcodePlanSlots, threeMfPlanSlots } from './filament-preview';
import { UNKNOWN_FILAMENT } from './filament-overrides';
import { ProductImportsController } from './product-imports.controller';
import { ProductOnboardingService, type ImportOptions } from './product-onboarding.service';
import { parseGcodeImport, parseThreeMfImport, type FilamentOverrides } from './slicer-import-input';

/**
 * Owner: "I should be able to override on import to avoid the system creating
 * phantom colors" — a slot the owner gives his own filament skips matching and
 * creates nothing; the other slots of the import behave as before.
 */

const P = 'p-sardine';
const UPLOAD = '0f8fe0a8-1111-4222-8333-944455556666';
const parser = new GcodeParserService();
const threeMfParser = new ThreeMfParserService(parser);

function setup() {
  const h = productsHarness([sardineRow()]);
  const onboarding = new ProductOnboardingService(h.db as any, parser, threeMfParser, h.pricing);
  return { h, onboarding };
}

/** `{ key: { slot: materialId } }` as the parsed override map. */
const chosen = (o: Record<number, Record<number, string>>): FilamentOverrides =>
  new Map(Object.entries(o).map(([k, slots]) => [Number(k), new Map(Object.entries(slots).map(([s, id]) => [Number(s), id]))]));
const opts = (o: Partial<ImportOptions> = {}): ImportOptions => ({ sizeOptionId: null, units: new Map(), targets: new Map(), ...o });
const file = (name: string, buffer: Buffer) => ({ originalname: name, buffer });
const materials = (h: any) => h.db.t('material');
const newComps = (h: any) => h.db.t('productComponent').filter((c: any) => !/^c\d$/.test(c.id));
const slotsOf = (h: any, componentId: string) => h.db.t('componentMaterial')
  .filter((m: any) => m.componentId === componentId).map((m: any) => [m.colorIndex, m.materialId]);

let dir: string;
const prevDir = process.env.UPLOAD_DIR;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-overrides-'));
  process.env.UPLOAD_DIR = dir;
});
afterEach(() => {
  process.env.UPLOAD_DIR = prevDir;
  fs.rmSync(dir, { recursive: true, force: true });
});
const filesOnDisk = () => fs.readdirSync(dir, { recursive: true } as any).map(String).filter((f) => /\.(gcode|png)$/.test(f));

/** One slot the shop has no filament for: on its own it creates "eSUN PLA+ Peach Pink". */
const peach = () => gcode({
  minutes: 30, toolGrams: [12], types: ['PLA'], colours: ['#F5B6A5'], settings: ['eSUN PLA+ Peach Pink @BBL X1C'], vendors: ['eSUN'],
});
/** Slot 1 matches PLA Black, slot 2 is the peach, slot 3 a green nothing matches. */
const trio = () => gcode({
  minutes: 60, toolGrams: [12, 3, 4], types: ['PLA', 'PLA', 'PLA'], colours: ['#111111', '#F5B6A5', '#00FF00'],
  settings: ['Creality Generic PLA @Hi-all', 'eSUN PLA+ Peach Pink @BBL X1C', 'Creality Generic PLA @Hi-all'], vendors: ['Generic', 'eSUN', 'Generic'],
});

function rejects(fn: () => unknown, text: string) {
  let msg = '';
  try {
    fn();
  } catch (e: any) {
    msg = e?.message ?? '';
    expect(e?.getStatus?.()).toBe(400);
  }
  expect(msg).toContain(text);
}

// ------------------------------------------------------------------ parsing

describe('the `filaments` field of M1/M2', () => {
  it('absent → no overrides; a JSON string or an object → key → slot → filament id', () => {
    expect(parseGcodeImport({}, 1).filaments.size).toBe(0);
    expect(parseGcodeImport({ filaments: '' }, 1).filaments.size).toBe(0);
    expect(parseGcodeImport({ filaments: '{"0":{}}' }, 1).filaments.size).toBe(0);
    const m1 = parseGcodeImport({ filaments: '{"1":{"0":"m-black","3":" m-red "}}' }, 2).filaments;
    expect([...m1.keys()]).toEqual([1]);
    expect([...m1.get(1)!]).toEqual([[0, 'm-black'], [3, 'm-red']]);
    const m2 = parseThreeMfImport({ selectedPlates: '[2,5]', filaments: { 5: { 255: 'm-red' } } }).filaments;
    expect([...m2.get(5)!]).toEqual([[255, 'm-red']]);
  });

  it('keys must be a sent file (M1) or a selected plate (M2)', () => {
    rejects(() => parseGcodeImport({ filaments: { 2: { 0: 'm-red' } } }, 2), 'filaments[2]');
    rejects(() => parseGcodeImport({ filaments: { '-1': { 0: 'm-red' } } }, 2), '"filaments" keys');
    rejects(() => parseThreeMfImport({ selectedPlates: [2], filaments: { 1: { 0: 'm-red' } } }), 'filaments[1]');
  });

  it('a wrong shape, slot or id is a 400 naming the field', () => {
    rejects(() => parseGcodeImport({ filaments: '{bad' }, 1), '"filaments" must be valid JSON');
    rejects(() => parseGcodeImport({ filaments: ['m-red'] }, 1), '"filaments" must be an object');
    rejects(() => parseGcodeImport({ filaments: 'null' }, 1), '"filaments" must be an object');
    for (const bad of ['m-red', ['m-red'], null, 3]) rejects(() => parseGcodeImport({ filaments: { 0: bad } }, 1), '"filaments[0]" must be an object');
    for (const slot of ['-1', '256', '1.5', 'a', '0000', '']) {
      rejects(() => parseGcodeImport({ filaments: { 0: { [slot]: 'm-red' } } }, 1), '"filaments[0]" keys must be slot numbers from 0 to 255');
    }
    for (const bad of [5, '', '   ', null, { id: 'm-red' }, 'x'.repeat(65)]) {
      rejects(() => parseGcodeImport({ filaments: { 0: { 1: bad } } }, 1), '"filaments[0][1]" must be an id');
    }
  });

  it('at most 500 chosen slots per import', () => {
    const slots = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i, 'm-red']));
    expect(() => parseGcodeImport({ filaments: { 0: slots(250), 1: slots(250) } }, 2)).not.toThrow();
    rejects(() => parseGcodeImport({ filaments: { 0: slots(250), 1: slots(251) } }, 2), 'at most 500 slots');
  });

  it('the line the dialog shows for a chosen slot', () => {
    const fromFile = { profile: 'eSUN PLA+', vendor: 'eSUN', type: 'PLA+', colorHex: '8E2A14', colorName: null };
    expect(filamentChoiceText(fromFile, { name: 'eSUN PLA', type: 'PLA', brand: 'eSun', color: 'Fire Engine Red' }))
      .toBe('eSUN PLA+ #8E2A14 → your eSun PLA Fire Engine Red (your choice)');
  });
});

// ------------------------------------------------------------------- G-code

describe('G-code import with chosen filaments', () => {
  it('a chosen slot uses that filament and creates none (without it the import creates one)', async () => {
    const auto = setup();
    const before = materials(auto.h).length;
    const plain = await auto.onboarding.onboardFromGcode(P, [file('Peach.gcode', peach())], opts());
    expect([plain.createdMaterials.map((m) => m.name), materials(auto.h).length]).toEqual([['eSUN PLA+ Peach Pink'], before + 1]);

    const { h, onboarding } = setup();
    const out = await onboarding.onboardFromGcode(P, [file('Peach.gcode', peach())], opts({ filaments: chosen({ 0: { 0: M.orange } }) }));
    expect([out.createdMaterials, materials(h).length]).toEqual([[], before]);
    expect(newComps(h)[0]).toMatchObject({ description: 'Peach', materialId: M.orange, isMultiColor: false, gramsUsed: 12 });
    expect(out.warnings.map((w) => w.code)).not.toContain('FILAMENT_TYPE_DIFFERS');
  });

  it('mixed: the chosen slot is used as given, the others match or create as before', async () => {
    const { h, onboarding } = setup();
    const before = materials(h).length;
    const out = await onboarding.onboardFromGcode(P, [file('Trio.gcode', trio())], opts({ filaments: chosen({ 0: { 1: M.orange } }) }));
    expect(out.createdMaterials).toHaveLength(1);
    expect(out.createdMaterials[0].name).not.toMatch(/Peach/);
    expect(materials(h)).toHaveLength(before + 1);
    expect(materials(h).some((m: any) => m.color === 'Peach Pink')).toBe(false);
    expect(slotsOf(h, newComps(h)[0].id)).toEqual([[0, M.black], [1, M.orange], [2, out.createdMaterials[0].id]]);
  });

  it('every slot chosen → nothing is matched or created, and the identity lock is never taken', async () => {
    const { h, onboarding } = setup();
    const before = materials(h).length;
    const out = await onboarding.onboardFromGcode(P, [file('Trio.gcode', trio())], opts({ filaments: chosen({ 0: { 0: M.white, 1: M.orange, 2: M.blue } }) }));
    expect([out.createdMaterials, materials(h).length]).toEqual([[], before]);
    expect(slotsOf(h, newComps(h)[0].id)).toEqual([[0, M.white], [1, M.orange], [2, M.blue]]);
    expect(h.db.$queryRaw.mock.calls.filter((c: Array<{ sql: string }>) => /material:advisory/.test(c[0].sql))).toHaveLength(0);
  });

  it('per file: a choice for the first file leaves the same slot of the second file automatic', async () => {
    const { h, onboarding } = setup();
    const out = await onboarding.onboardFromGcode(P, [file('A.gcode', peach()), file('B.gcode', peach())], opts({ filaments: chosen({ 0: { 0: M.orange } }) }));
    const [a, b] = newComps(h);
    expect(a.materialId).toBe(M.orange);
    expect(out.createdMaterials.map((m) => m.id)).toEqual([b.materialId]);
  });

  it('a ×N plate: the per-unit component takes the chosen filament', async () => {
    const { h, onboarding } = setup();
    const out = await onboarding.onboardFromGcode(P, [file('Peach x 4.gcode', peach())], opts({ units: new Map([[0, 4]]), filaments: chosen({ 0: { 0: M.orange } }) }));
    expect(out.createdMaterials).toEqual([]);
    expect(newComps(h)[0]).toMatchObject({ materialId: M.orange, gramsUsed: 3 });
    expect(out.layoutsCreated).toHaveLength(1);
  });

  it('an unknown filament id → 400 before anything is stored or written, even for a slot the file does not use', async () => {
    const { h, onboarding } = setup();
    const before = materials(h).length;
    const attempts: Array<Record<number, string>> = [{ 0: 'm-nope' }, { 0: M.orange, 7: 'm-nope' }];
    for (const slots of attempts) {
      const attempt = onboarding.onboardFromGcode(P, [file('Peach.gcode', peach())], opts({ filaments: chosen({ 0: slots }) }));
      await expect(attempt).rejects.toThrow(UNKNOWN_FILAMENT);
      expect(await statusOf(onboarding.onboardFromGcode(P, [file('Peach.gcode', peach())], opts({ filaments: chosen({ 0: slots }) })))).toBe(400);
    }
    expect([newComps(h).length, materials(h).length, filesOnDisk(), h.db.t('attachment').length]).toEqual([0, before, [], 0]);
  });

  it('a filament deleted after the first check → 400 inside the import and the stored file is removed', async () => {
    const { h, onboarding } = setup();
    const findMany = h.db.material.findMany;
    // The pre-check sees it; the import's own snapshot (no `where`) no longer does.
    h.db.material.findMany = jest.fn(async (a: { where?: unknown }) => (a?.where ? [{ id: 'm-gone' }] : findMany(a)));
    await expect(onboarding.onboardFromGcode(P, [file('Peach.gcode', peach())], opts({ filaments: chosen({ 0: { 0: 'm-gone' } }) })))
      .rejects.toThrow(UNKNOWN_FILAMENT);
    expect([newComps(h).length, filesOnDisk()]).toEqual([0, []]);
  });

  it('a filament of another material type is allowed and reported', async () => {
    const { h, onboarding } = setup();
    h.db.insert('material', { id: 'm-petg', name: 'PETG Black', type: 'PETG', brand: 'eSun', color: 'Black', colorHex: '111111', costPerGram: 0.02 });
    const out = await onboarding.onboardFromGcode(P, [file('Peach.gcode', peach())], opts({ filaments: chosen({ 0: { 0: 'm-petg' } }) }));
    expect(newComps(h)[0].materialId).toBe('m-petg');
    expect(out.createdMaterials).toEqual([]);
    expect(out.warnings).toContainEqual({
      code: 'FILAMENT_TYPE_DIFFERS', materialId: 'm-petg',
      message: '"Peach" slot 1: the file prints PLA but your choice eSun PETG Black is PETG — check the filament',
    });
  });

  it('an unused (0 g) slot never creates a filament and is not in the preview', async () => {
    const { h, onboarding } = setup();
    const buf = gcode({ minutes: 30, toolGrams: [12, 0], types: ['PLA', 'PLA'], colours: ['#111111', '#00FF00'], settings: ['Generic PLA', 'eSUN PLA+ Lime @BBL X1C'], vendors: ['Generic', 'eSUN'] });
    const before = materials(h).length;
    expect(gcodePlanSlots(parser.parseHeader(buf)).map((s) => s.index)).toEqual([0]);
    const out = await onboarding.onboardFromGcode(P, [file('Mono.gcode', buf)], opts());
    expect([out.createdMaterials, materials(h).length, newComps(h)[0].materialId]).toEqual([[], before, M.black]);
  });
});

// ---------------------------------------------------------------------- 3MF

describe('3MF import with chosen filaments', () => {
  const settings = {
    projectSettings: {
      filament_settings_id: ['eSUN PLA+ Peach Pink @BBL A1', 'eSUN PLA+ Lime @BBL A1'], filament_vendor: ['eSUN', 'eSUN'],
      filament_type: ['PLA', 'PLA'], filament_colour: ['#F5B6A5', '#00FF00'],
    },
  };
  const project = () => threeMf([
    { index: 1, seconds: 600, weight: 20, filaments: [{ id: 1, type: 'PLA', color: '#F5B6A5', grams: 20 }] },
    { index: 2, seconds: 900, weight: 25, filaments: [{ id: 1, type: 'PLA', color: '#F5B6A5', grams: 5 }, { id: 2, type: 'PLA', color: '#00FF00', grams: 20 }] },
  ], settings);

  it('keyed by plate: the chosen slot of plate 1 is used as given; plate 2 stays automatic', async () => {
    const { h, onboarding } = setup();
    const before = materials(h).length;
    const out = await onboarding.onboardFromThreeMf(P, await project(), {
      ...opts({ filaments: chosen({ 1: { 0: M.orange } }) }), selectedPlates: [1, 2], plateNames: { 1: 'Shell', 2: 'Fish' },
    });
    const [shell, fish] = newComps(h);
    expect(shell).toMatchObject({ description: 'Shell', materialId: M.orange });
    expect(out.createdMaterials.map((m) => m.name)).toEqual(['eSUN PLA+ Peach Pink', 'eSUN PLA+ Lime']);
    expect(slotsOf(h, fish.id)).toEqual([[0, out.createdMaterials[0].id], [1, out.createdMaterials[1].id]]);
    expect(materials(h)).toHaveLength(before + 2);
  });

  it('every used slot of every selected plate chosen → no filament is created', async () => {
    const { h, onboarding } = setup();
    const before = materials(h).length;
    const out = await onboarding.onboardFromThreeMf(P, await project(), {
      ...opts({ filaments: chosen({ 1: { 0: M.orange }, 2: { 0: M.orange, 1: M.blue } }) }), selectedPlates: [1, 2],
    });
    expect([out.createdMaterials, materials(h).length]).toEqual([[], before]);
    expect(slotsOf(h, newComps(h)[1].id)).toEqual([[0, M.orange], [1, M.blue]]);
  });

  it('a plate added as a layout of an existing component matches no filament: a choice changes nothing and nothing is created', async () => {
    const { h, onboarding } = setup();
    const before = materials(h).length;
    const comps = h.db.t('productComponent').length;
    for (const [units, filaments] of [[20, undefined], [21, chosen({ 1: { 0: M.red } })]] as const) {
      const out = await onboarding.onboardFromThreeMf(P, await project(), {
        ...opts({ units: new Map([[1, units]]), targets: new Map([[1, 'c4']]), filaments }), selectedPlates: [1],
      });
      expect(out.createdMaterials).toEqual([]);
      expect(out.layoutsCreated).toEqual([{ componentId: 'c4', layoutId: expect.any(String), unitsPerPlate: units }]);
    }
    expect([materials(h).length, h.db.t('productComponent').length]).toEqual([before, comps]);
    expect(h.db.t('productComponent').find((c: any) => c.id === 'c4').materialId).toBe(M.silver);
  });

  it('an unknown filament id → 400, nothing written', async () => {
    const { h, onboarding } = setup();
    const attempt = onboarding.onboardFromThreeMf(P, await project(), { ...opts({ filaments: chosen({ 1: { 0: 'm-nope' } }) }), selectedPlates: [1] });
    expect(await statusOf(attempt)).toBe(400);
    expect(newComps(h)).toHaveLength(0);
  });

  it('a slot with 0 g on the selected plates never creates a filament and is not in the preview', async () => {
    const { h, onboarding } = setup();
    const buf = await threeMf([
      { index: 1, seconds: 600, weight: 20, filaments: [{ id: 1, type: 'PLA', color: '#111111', grams: 20 }, { id: 2, type: 'PLA', color: '#00FF00', grams: 0 }] },
    ], { projectSettings: { ...settings.projectSettings, filament_settings_id: ['Generic PLA', 'eSUN PLA+ Lime @BBL A1'], filament_vendor: ['Generic', 'eSUN'], filament_colour: ['#111111', '#00FF00'] } });
    const before = materials(h).length;
    expect(threeMfPlanSlots(await threeMfParser.parse(buf)).map((s) => s.index)).toEqual([0]);
    const out = await onboarding.onboardFromThreeMf(P, buf, { ...opts(), selectedPlates: [1] });
    expect([out.createdMaterials, materials(h).length, newComps(h)[0].materialId]).toEqual([[], before, M.black]);
  });
});

// --------------------------------------------------------------- controller

describe('M1/M2 pass the chosen filaments to the import', () => {
  function controller(onboarding: any, fileName: string) {
    const chunk = {
      consume: jest.fn(async () => ({ originalname: fileName, buffer: Buffer.from('x') })),
      discard: jest.fn(async () => undefined),
    };
    const products = { findOne: jest.fn(async () => ({ id: P })) };
    return { ctrl: new ProductImportsController(products as any, onboarding, chunk as any), chunk };
  }

  it('M1: parsed and handed to onboardFromGcode; a bad value → 400 before a staged file is read', async () => {
    const onboarding = { onboardFromGcode: jest.fn().mockResolvedValue({ results: [] }) };
    const { ctrl, chunk } = controller(onboarding, 'a.gcode');
    await ctrl.onboardGcode(P, [], { assembledUploadIds: JSON.stringify([UPLOAD]), filaments: '{"0":{"1":"m-red"}}' });
    expect(onboarding.onboardFromGcode.mock.calls[0][2].filaments.get(0).get(1)).toBe('m-red');
    chunk.consume.mockClear();
    await expect(ctrl.onboardGcode(P, [], { assembledUploadIds: JSON.stringify([UPLOAD]), filaments: '{"1":{"0":"m-red"}}' })).rejects.toThrow('filaments[1]');
    expect(chunk.consume).not.toHaveBeenCalled();
  });

  it('M2: parsed and handed to onboardFromThreeMf; a bad value → 400 before the staged file is read', async () => {
    const onboarding = { onboardFromThreeMf: jest.fn().mockResolvedValue({ results: [] }) };
    const { ctrl, chunk } = controller(onboarding, 'proj.3mf');
    await ctrl.onboardThreeMf(P, undefined, { selectedPlates: '[3]', filaments: '{"3":{"0":"m-red"}}' }, UPLOAD);
    expect(onboarding.onboardFromThreeMf.mock.calls[0][2].filaments.get(3).get(0)).toBe('m-red');
    chunk.consume.mockClear();
    await expect(ctrl.onboardThreeMf(P, undefined, { selectedPlates: '[3]', filaments: '{"3":{"0":5}}' }, UPLOAD)).rejects.toThrow('"filaments[3][0]" must be an id');
    expect(chunk.consume).not.toHaveBeenCalled();
  });
});
