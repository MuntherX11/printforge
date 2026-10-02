import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { filamentMatchText } from '@printforge/types';
import { M, sardineRow } from '../catalog-core/__fixtures__/sardine-tin';
import { GcodeParserService } from '../file-parser/gcode-parser.service';
import { ThreeMfParserService } from '../file-parser/threemf-parser.service';
import { productsHarness } from './__fixtures__/products-harness';
import { gcode, threeMf } from './__fixtures__/slicer-files';
import { gcodePlanSlots, previewFilamentMatches, threeMfPlanSlots } from './filament-preview';
import { ProductOnboardingService, type ImportOptions } from './product-onboarding.service';

/**
 * Owner: "the 3MF will already have the correct filaments set" — imports use the
 * file's own filament (vendor, profile, colour name) and never create a
 * brandless "PLA Beige" when the file names one.
 */

const P = 'p-sardine';
const parser = new GcodeParserService();
const threeMfParser = new ThreeMfParserService(parser);

function setup() {
  const h = productsHarness([sardineRow()]);
  const onboarding = new ProductOnboardingService(h.db as any, parser, threeMfParser, h.pricing);
  return { h, onboarding };
}

const opts = (): ImportOptions => ({ sizeOptionId: null, units: new Map(), targets: new Map() });
const file = (name: string, buffer: Buffer) => ({ originalname: name, buffer });
const material = (h: any, id: string) => h.db.t('material').find((m: any) => m.id === id);
const newComps = (h: any) => h.db.t('productComponent').filter((c: any) => !/^c\d$/.test(c.id));

let dir: string;
const prevDir = process.env.UPLOAD_DIR;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-filaments-'));
  process.env.UPLOAD_DIR = dir;
});
afterEach(() => {
  process.env.UPLOAD_DIR = prevDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

const peach = (o: { colours?: string[] } = {}) => gcode({
  minutes: 30, toolGrams: [12], types: ['PLA'], colours: o.colours ?? ['#F5B6A5'],
  settings: ['eSUN PLA+ Peach Pink @BBL X1C'], vendors: ['eSUN'],
});

describe('slicer imports use the file\'s filament identity', () => {
  it('an unmatched vendor\'d slot creates a branded filament named after its profile, cost 0 and blocking', async () => {
    const { h, onboarding } = setup();
    const out = await onboarding.onboardFromGcode(P, [file('Peach.gcode', peach())], opts());
    expect(out.createdMaterials).toEqual([{ id: expect.any(String), name: 'eSUN PLA+ Peach Pink', colorHex: 'F5B6A5' }]);
    expect(material(h, out.createdMaterials[0].id)).toMatchObject({ brand: 'eSUN', type: 'PLA', color: 'Peach Pink', colorHex: 'F5B6A5', costPerGram: 0 });
    const standard = (await h.pricing.optionCosts(P)).find((o) => o.sizeOptionId === null)!;
    expect(standard.problems).toContainEqual(expect.objectContaining({ code: 'MATERIAL_ZERO_COST', materialId: out.createdMaterials[0].id }));
  });

  it('a profile that names no colour still gives a branded filament ("eSUN PLA+ Beige", not "PLA Beige")', async () => {
    const { h, onboarding } = setup();
    const buf = gcode({ minutes: 30, toolGrams: [12], types: ['PLA'], colours: ['#F5DEB3'], settings: ['eSUN PLA+ @System'], vendors: ['eSUN'] });
    const out = await onboarding.onboardFromGcode(P, [file('Beige.gcode', buf)], opts());
    expect(out.createdMaterials.map((m) => m.name)).toEqual(['eSUN PLA+ Beige']);
    expect(material(h, out.createdMaterials[0].id)).toMatchObject({ brand: 'eSUN', color: 'Beige' });
  });

  it('a slot whose brand + colour name exist is matched by name, whatever its hex', async () => {
    const { h, onboarding } = setup();
    h.db.insert('material', { id: 'm-peach', name: 'PLA Peach', type: 'PLA', brand: 'eSun', color: 'Peach Pink', colorHex: null, costPerGram: 0.02 });
    const out = await onboarding.onboardFromGcode(P, [file('Peach.gcode', peach({ colours: ['#00FF00'] }))], opts());
    expect([out.createdMaterials, newComps(h)[0].materialId]).toEqual([[], 'm-peach']);
  });

  it('the filament the slot would create already exists under another spelling of the brand → reused', async () => {
    const { h, onboarding } = setup();
    h.db.insert('material', { id: 'm-beige', name: 'eSun Beige', type: 'PLA', brand: 'ESUN', color: 'beige', colorHex: null, costPerGram: 0.02 });
    const buf = gcode({ minutes: 30, toolGrams: [12], types: ['PLA'], colours: ['#F5DEB3'], settings: ['eSUN PLA+ @System'], vendors: ['eSUN'] });
    const out = await onboarding.onboardFromGcode(P, [file('Beige.gcode', buf)], opts());
    expect([out.createdMaterials, newComps(h)[0].materialId]).toEqual([[], 'm-beige']);
  });

  it('a 3MF plate without G-code creates the branded filament from project_settings', async () => {
    const { h, onboarding } = setup();
    const buf = await threeMf([{ index: 1, seconds: 600, weight: 20, filaments: [{ id: 1, type: 'PLA', color: '#F5B6A5', grams: 20 }] }], {
      projectSettings: {
        filament_settings_id: ['eSUN PLA+ Peach Pink @BBL A1'], filament_vendor: ['eSUN'], filament_type: ['PLA'], filament_colour: ['#F5B6A5'],
      },
    });
    const out = await onboarding.onboardFromThreeMf(P, buf, { ...opts(), selectedPlates: [1] });
    expect(out.createdMaterials.map((m) => m.name)).toEqual(['eSUN PLA+ Peach Pink']);
    expect(material(h, out.createdMaterials[0].id).brand).toBe('eSUN');
  });

  it('a Generic slot without a colour name matches by hex as before (sardine PLA Black)', async () => {
    const { h, onboarding } = setup();
    const buf = gcode({ minutes: 30, toolGrams: [12], types: ['PLA'], colours: ['#111111'], settings: ['Creality Generic PLA @Hi-all'], vendors: ['Generic'] });
    const out = await onboarding.onboardFromGcode(P, [file('Black.gcode', buf)], opts());
    expect([out.createdMaterials, newComps(h)[0].materialId]).toEqual([[], M.black]);
  });
});

describe('the mapping shown before an import (analysis, ?matchFilaments=1)', () => {
  const readOnly = (h: any) => {
    const writes = ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'];
    for (const w of writes) h.db.material[w] = jest.fn(() => { throw new Error(`analysis wrote material.${w}`); });
    return h.db;
  };

  it('G-code: each used slot → existing filament or the new one, and nothing is written', async () => {
    const { h } = setup();
    const a = parser.parseHeader(gcode({
      minutes: 30, toolGrams: [12, 3], types: ['PLA', 'PLA'], colours: ['#111111', '#F5B6A5'],
      settings: ['Creality Generic PLA @Hi-all', 'eSUN PLA+ Peach Pink @BBL X1C'], vendors: ['Generic', 'eSUN'],
    }));
    const before = h.db.t('material').length;
    const plan = await previewFilamentMatches(readOnly(h), gcodePlanSlots(a));
    expect(plan.map(filamentMatchText)).toEqual([
      'Creality Generic PLA #111111 → your PLA Black (exact)',
      'eSUN PLA+ Peach Pink → new filament eSUN PLA+ Peach Pink (cost 0 — set it after)',
    ]);
    expect(h.db.t('material')).toHaveLength(before);
  });

  it('3MF: used slots across plates, once each', async () => {
    const { h } = setup();
    const buf = await threeMf([
      { index: 1, seconds: 600, weight: 20, filaments: [{ id: 1, type: 'PLA', color: '#111111', grams: 20 }] },
      { index: 2, seconds: 600, weight: 25, filaments: [{ id: 1, type: 'PLA', color: '#111111', grams: 5 }, { id: 2, type: 'PLA', color: '#F5B6A5', grams: 20 }] },
    ], {
      projectSettings: {
        filament_settings_id: ['Bambu PLA Basic @BBL X1C', 'eSUN PLA+ Peach Pink @BBL X1C'], filament_vendor: ['Bambu Lab', 'eSUN'],
        filament_type: ['PLA', 'PLA'], filament_colour: ['#111111', '#F5B6A5'],
      },
    });
    const plan = await previewFilamentMatches(readOnly(h), threeMfPlanSlots(await threeMfParser.parse(buf)));
    expect(plan.map((m) => [m.index, m.material?.id ?? m.create?.name])).toEqual([[0, M.black], [1, 'eSUN PLA+ Peach Pink']]);
  });
});
