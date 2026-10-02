import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sardineRow } from '../catalog-core/__fixtures__/sardine-tin';
import { GcodeParserService } from '../file-parser/gcode-parser.service';
import { ThreeMfParserService } from '../file-parser/threemf-parser.service';
import { productsHarness } from './__fixtures__/products-harness';
import { gcode, threeMf } from './__fixtures__/slicer-files';
import { ProductOnboardingService, type ImportOptions } from './product-onboarding.service';

/**
 * Owner spec 2026-10-02 items 3 and 6: every imported G-code is stored with the
 * printer it was sliced for, and that printer becomes the pricing printer when
 * the product has none.
 */

const P = 'p-sardine';

function setup(defaultPrinterId: string | null) {
  const row = sardineRow();
  row.defaultPrinterId = defaultPrinterId;
  if (!defaultPrinterId) delete row.defaultPrinter;
  const h = productsHarness([row]);
  h.db.insert('printer', { id: 'pr-hi', name: 'HI', model: null, isActive: true, hourlyRate: 0.5, wattage: 300, markupMultiplier: 2.5 });
  h.db.insert('printer', { id: 'pr-e3', name: 'Ender', model: 'Ender-3 V3', isActive: true, hourlyRate: 0.3, wattage: 200, markupMultiplier: 2.5 });
  const parser = new GcodeParserService();
  return { h, onboarding: new ProductOnboardingService(h.db as any, parser, new ThreeMfParserService(parser), h.pricing) };
}

const opts = (): ImportOptions => ({ sizeOptionId: null, units: new Map(), targets: new Map() });
const sliced = (printer: string) => Buffer.concat([gcode({ minutes: 30, totalGrams: 9.4, types: ['PLA'], colours: ['#000000'] }), Buffer.from(`; printer_model = ${printer}\n`)]);

let dir: string;
const prevDir = process.env.UPLOAD_DIR;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-printer-'));
  process.env.UPLOAD_DIR = dir;
});
afterEach(() => {
  process.env.UPLOAD_DIR = prevDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('slicer imports keep the sliced-for printer', () => {
  it('a G-code sliced for "Creality Hi": stored with it, and the matching printer becomes the pricing printer', async () => {
    const { h, onboarding } = setup(null);
    const out = await onboarding.onboardFromGcode(P, [{ originalname: 'Box.gcode', buffer: sliced('Creality Hi') }], opts());
    const att = h.db.t('attachment').at(-1);
    expect(att).toMatchObject({ slicedForPrinter: 'Creality Hi', entityType: 'product' });
    expect(fs.existsSync(path.join(dir, att.storagePath))).toBe(true);
    expect(out.defaultPrinterAssigned).toEqual({ id: 'pr-hi', name: 'HI' });
    expect(h.db.t('product').find((p: any) => p.id === P).defaultPrinterId).toBe('pr-hi');
    expect(out.warnings.some((w) => w.code === 'PRINTER_NOT_MATCHED')).toBe(false);
  });

  it('a product that has a pricing printer keeps it', async () => {
    const { h, onboarding } = setup('pr-1');
    const out = await onboarding.onboardFromGcode(P, [{ originalname: 'Box.gcode', buffer: sliced('Creality Ender-3 V3') }], opts());
    expect(out.defaultPrinterAssigned).toBeNull();
    expect(h.db.t('product').find((p: any) => p.id === P).defaultPrinterId).toBe('pr-1');
    expect(h.db.t('attachment').at(-1).slicedForPrinter).toBe('Creality Ender-3 V3');
  });

  it('no matching printer: a warning names the model, and no printer is guessed by name', async () => {
    const { h, onboarding } = setup(null);
    const out = await onboarding.onboardFromGcode(P, [{ originalname: 'Box.gcode', buffer: sliced('Creality K1 Max') }], opts());
    expect(out.defaultPrinterAssigned).toBeNull();
    expect(out.warnings).toContainEqual({ code: 'PRINTER_NOT_MATCHED', message: 'Sliced for Creality K1 Max — no matching printer' });
    expect(h.db.t('product').find((p: any) => p.id === P).defaultPrinterId).toBeNull();
  });

  it('a 3MF: the stored plate file carries the project printer', async () => {
    const { h, onboarding } = setup(null);
    const zip = await threeMf([{ index: 1, seconds: 1800, weight: 9.4, gcode: gcode({ minutes: 30, totalGrams: 9.4 }) }]);
    // project_settings.config names the printer, as OrcaSlicer writes it
    const JSZip = (await import('jszip')).default;
    const z = await JSZip.loadAsync(zip);
    z.file('Metadata/project_settings.config', JSON.stringify({ printer_model: 'Creality Ender-3 V3', printer_settings_id: 'Creality Ender-3 V3 0.4 nozzle' }));
    const buf = await z.generateAsync({ type: 'nodebuffer' });
    const out = await onboarding.onboardFromThreeMf(P, buf, { ...opts(), selectedPlates: [1] });
    expect(h.db.t('attachment').find((a: any) => a.mimeType === 'application/octet-stream').slicedForPrinter).toBe('Creality Ender-3 V3');
    expect(out.defaultPrinterAssigned).toEqual({ id: 'pr-e3', name: 'Ender' });
  });
});
