import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sardineRow } from '../catalog-core/__fixtures__/sardine-tin';
import { GcodeParserService } from '../file-parser/gcode-parser.service';
import { ThreeMfParserService } from '../file-parser/threemf-parser.service';
import { productsHarness, statusOf } from './__fixtures__/products-harness';
import { gcode } from './__fixtures__/slicer-files';
import { ProductOnboardingService, type ImportOptions } from './product-onboarding.service';

/**
 * A size-scoped slicer import (M1/M2) into a size converted to a plate layout
 * (O8): refused before any file is written, and again under the size's lock.
 * (Kept apart from product-onboarding.service.spec.ts, which is at its size limit.)
 */

const P = 'p-sardine';
const MESSAGE = '"Box x 12" was converted to a plate layout — activate it before importing files for it';
const black = gcode({ minutes: 70, toolGrams: [21], types: ['PLA'], colours: ['#111111'] });
const opts = (sizeOptionId: string): ImportOptions => ({ sizeOptionId, units: new Map(), targets: new Map() });
const file = { originalname: 'XL Box.gcode', buffer: black };

function setup(convertedLayoutId: string | null) {
  const row = sardineRow();
  row.variants.push({ ...row.variants[0], id: 'v-b12', name: 'Box x 12', isActive: convertedLayoutId === null, convertedLayoutId });
  const h = productsHarness([row]);
  const parser = new GcodeParserService();
  return { h, onboarding: new ProductOnboardingService(h.db as any, parser, new ThreeMfParserService(parser), h.pricing) };
}

let dir: string;
const prevDir = process.env.UPLOAD_DIR;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-import-converted-'));
  process.env.UPLOAD_DIR = dir;
});
afterEach(() => {
  process.env.UPLOAD_DIR = prevDir;
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});
const filesOnDisk = () => fs.readdirSync(dir, { recursive: true } as any).map(String).filter((f) => /\.(gcode|png)$/.test(f));
const ownComponents = (h: any) => h.db.t('productComponent').filter((c: any) => c.variantId === 'v-b12');

it('an import into a live-converted size → 409 before any file is written', async () => {
  const { h, onboarding } = setup('l1');
  await expect(onboarding.onboardFromGcode(P, [file], opts('v-b12'))).rejects.toThrow(MESSAGE);
  expect(await statusOf(onboarding.onboardFromGcode(P, [file], opts('v-b12')))).toBe(409);
  expect(filesOnDisk()).toEqual([]);
  expect(ownComponents(h)).toHaveLength(0);
});

it('a conversion committed after the pre-check is caught under the lock, and the written file is removed', async () => {
  const { h, onboarding } = setup(null);
  const orig = h.db.$queryRaw.getMockImplementation();
  h.db.$queryRaw.mockImplementation(async (sql: any) => {
    const rows = await orig(sql);
    return String(sql.sql ?? sql).includes('lock:ProductVariant:SHARE') ? rows.map((r: any) => ({ ...r, convertedLayoutId: 'l1' })) : rows;
  });
  await expect(onboarding.onboardFromGcode(P, [file], opts('v-b12'))).rejects.toThrow(MESSAGE);
  expect(ownComponents(h)).toHaveLength(0);
  expect(filesOnDisk()).toEqual([]);
});

it('once its layout is deleted the size imports as usual', async () => {
  const { h, onboarding } = setup('l-gone');
  await onboarding.onboardFromGcode(P, [file], opts('v-b12'));
  expect(ownComponents(h)).toHaveLength(1);
});
