import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fixtureComponent, M, sardineRow } from '../catalog-core/__fixtures__/sardine-tin';
import { GcodeParserService } from '../file-parser/gcode-parser.service';
import { addJob, addOrderLine, addQuoteLine, productsHarness, statusOf } from './__fixtures__/products-harness';
import { gcode, labels } from './__fixtures__/slicer-files';
import { OptionConversionService } from './option-conversion.service';

/** O8a/O8 Convert to plate, over the in-memory database (spec §4.3–§4.4, §7). */

const P = 'p-clicker';
const T0 = new Date('2026-01-01T00:00:00Z');
const UPLOAD = '0f8fe0a8-1111-4222-8333-944455556666';
const ACTOR = { id: 'u-owner' };

const option = (id: string, name: string, grams: number | null, minutes: number | null, over: Record<string, unknown> = {}) => ({
  id, productId: P, name, sku: null, kind: 'SIZE', isActive: true, sortOrder: 0, basePrice: 4.5, estimatedGrams: grams, estimatedMinutes: minutes,
  createdAt: T0, colourAssignments: [], sizeExclusions: [], ...over,
});

/** Chasen Clicker as on production: three standard parts, legacy "N per plate" options, a colour and a real size. */
function clickerRow() {
  const part = (id: string, desc: string, order: number, minutes: number, mat: string, grams: number, variantId: string | null = null) => {
    const c = fixtureComponent(id, variantId, desc, 1, order, minutes, [[0, mat, grams, null]], []);
    c.productId = P;
    return c;
  };
  return {
    id: P, name: 'Chasen Clicker', isActive: true, basePrice: 2, colorChanges: 0, baseOptionLabel: null, baseOptionSellable: null,
    standardColourLabel: null, standardColourSellable: null, surplusPolicy: 'KEEP_FOR_STOCK', defaultPrinterId: null, updatedAt: T0,
    defaultPrinter: null, colourSlots: [], parts: [], priceTiers: [{ minQty: 10, unitPrice: 1.8 }],
    variants: [
      option('v-b50', 'b50', 120.77, 421),
      option('v-t50', 't50', 220.07, 552),
      option('v-c25', 'c25', 125.9, 655),
      option('v-red', 'Red', null, null, { kind: 'COLOUR', basePrice: null }),
      option('v-big', 'Big', null, null, { basePrice: null }),
      option('v-tier', 'Tiered', null, null, { priceTiers: [{ minQty: 5, unitPrice: 3 }] }),
    ],
    components: [
      part('c-base', 'BASE', 0, 12, M.white, 2.47),
      part('c-top', 'TOP', 1, 20, M.black, 4.44),
      part('c-whisk', 'whisk', 2, 31, M.silver, 5.04),
      part('c-big', 'Big BASE', 0, 20, M.white, 5, 'v-big'),
    ],
  };
}

function setup(opts: { file?: Buffer; name?: string; rows?: any[] } = {}) {
  const h = productsHarness(opts.rows ?? [clickerRow()]);
  const chunk = {
    consume: jest.fn(async () => ({ originalname: opts.name ?? 'b50.gcode', buffer: opts.file ?? B50, size: 0 })),
    discard: jest.fn(async () => undefined),
  };
  const svc = new OptionConversionService(h.db as any, new GcodeParserService(), chunk as any, h.resolver, h.planner);
  return { h, chunk, svc };
}

const B50 = gcode({ labels: labels('base', 50), minutes: 421, toolGrams: [118], totalGrams: 120.77, colours: ['#FFFFFF'], changes: 0 });
const MANUAL = { componentId: 'c-base', unitsPerPlate: 50, plateMinutes: 421, plateGrams: 120.77 };
const opt = (h: ReturnType<typeof setup>['h'], id: string) => h.db.t('productVariant').find((v: any) => v.id === id);

let dir: string;
const prevDir = process.env.UPLOAD_DIR;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-convert-'));
  process.env.UPLOAD_DIR = dir;
});
afterEach(() => {
  process.env.UPLOAD_DIR = prevDir;
  fs.rmSync(dir, { recursive: true, force: true });
});
const filesOnDisk = () => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true } as any).filter((f: any) => /\.gcode$/.test(String(f))) : []);

describe('O8 convert, manual', () => {
  it('creates the layout, its slot, switches the option off and audits it — the option row locked FOR UPDATE first', async () => {
    const { h, svc } = setup();
    const accessed: string[] = [];
    const run = h.db.$transaction.getMockImplementation()!;
    h.db.$transaction.mockImplementationOnce(async (fn: any) => run(async (tx: any) => fn(new Proxy(tx, {
      get(t, k) { if (typeof k === 'string') accessed.push(k); return t[k]; },
    }))));

    const out = await svc.convert(P, 'v-b50', MANUAL, ACTOR);

    expect(accessed[0]).toBe('$queryRaw');
    expect(h.db.locks[0]).toEqual({ table: 'ProductVariant', mode: 'UPDATE', ids: ['v-b50'] });
    expect(out.layout).toMatchObject({ name: '×50', unitsPerPlate: 50, plateMinutes: 421, plateGrams: 120.77, source: 'MANUAL', isActive: true, file: null, objectCount: null });
    expect(out.layout.slots).toEqual([{ colorIndex: 0, gramsUsed: 120.77 }]);
    expect(out.option).toEqual({ id: 'v-b50', name: 'b50', isActive: false, convertedLayoutId: out.layout.id });
    expect(out.warnings).toEqual([]);
    expect(h.db.t('plateLayout').find((l: any) => l.id === out.layout.id)).toMatchObject({ componentId: 'c-base', colorChanges: 0 });
    expect(opt(h, 'v-b50')).toMatchObject({ isActive: false, convertedLayoutId: out.layout.id, basePrice: 4.5, estimatedGrams: 120.77, estimatedMinutes: 421 });

    const audit = h.db.t('auditLog');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ userId: 'u-owner', action: 'ProductVariant.convertedToLayout', entityType: 'ProductVariant', entityId: 'v-b50' });
    expect(audit[0].details).toEqual({
      productId: P, optionName: 'b50', wasActive: true, legacyPrice: 4.5, legacyGrams: 120.77, legacyMinutes: 421, previousLayoutId: null,
      componentId: 'c-base', componentDescription: 'BASE', layoutId: out.layout.id, unitsPerPlate: 50, plateMinutes: 421, plateGrams: 120.77,
      source: 'MANUAL', attachmentId: null, isActive: true, recommendActive: true, slotMatch: 'SINGLE', warningCodes: [],
    });
  });

  it('isActive omitted → the recommendation (off for a suspicious plate); isActive true overrides it', async () => {
    const odd = { componentId: 'c-base', unitsPerPlate: 29, plateMinutes: 144, plateGrams: 42.19 };
    const a = setup();
    const off = await a.svc.convert(P, 'v-b50', odd, ACTOR);
    expect(off.layout.isActive).toBe(false);
    expect(off.warnings.map((w) => w.code)).toEqual(['PLATE_GRAMS_DIFFER']);
    const b = setup();
    const on = await b.svc.convert(P, 'v-b50', { ...odd, isActive: true }, ACTOR);
    expect(on.layout.isActive).toBe(true);
    expect(b.h.db.t('auditLog')[0].details).toMatchObject({ isActive: true, recommendActive: false, warningCodes: ['PLATE_GRAMS_DIFFER'] });
    expect(await statusOf(setup().svc.convert(P, 'v-b50', { ...odd, isActive: 'yes' }, ACTOR))).toBe(400);
  });

  it('never reprices: product, tiers, the option\'s legacy figures and every order/quote/job row are unchanged', async () => {
    const { h, svc } = setup();
    addOrderLine(h.db, { productId: P, sizeOptionId: 'v-b50', quantity: 3 });
    addQuoteLine(h.db, { productId: P, sizeOptionId: 'v-b50' });
    addJob(h.db, { productId: P, sizeOptionId: 'v-b50', status: 'COMPLETED' });
    const snap = () => JSON.stringify(['product', 'priceTier', 'variantPriceTier', 'orderItem', 'quoteItem', 'productionJob', 'order', 'quote']
      .map((t) => h.db.t(t)));
    const before = snap();
    const legacy = (({ basePrice, estimatedGrams, estimatedMinutes, sku, name }) => ({ basePrice, estimatedGrams, estimatedMinutes, sku, name }))(opt(h, 'v-b50'));
    const spy = jest.spyOn(h.pricing, 'recalcPricing');
    await svc.convert(P, 'v-b50', MANUAL, ACTOR);
    expect(snap()).toBe(before);
    expect(opt(h, 'v-b50')).toMatchObject(legacy);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('O8 convert from a plate G-code', () => {
  it('reads the staged upload with keep, stores the file as the layout attachment, and discards the upload only after commit', async () => {
    const { h, chunk, svc } = setup();
    const out = await svc.convert(P, 'v-b50', { ...MANUAL, assembledUploadId: UPLOAD }, ACTOR);
    expect(chunk.consume).toHaveBeenCalledWith(UPLOAD, expect.any(Number), { keep: true });
    expect(chunk.discard).toHaveBeenCalledWith(UPLOAD);
    expect(chunk.discard.mock.invocationCallOrder[0]).toBeGreaterThan(h.db.$transaction.mock.invocationCallOrder[0]);
    expect(out.layout).toMatchObject({ source: 'GCODE', objectCount: 50, file: { filename: 'b50.gcode' } });
    const att = h.db.t('attachment').find((a: any) => a.id === out.layout.file!.attachmentId);
    expect(fs.readFileSync(path.join(dir, att.storagePath))).toEqual(B50);
    expect(h.db.t('plateLayout').find((l: any) => l.id === out.layout.id)).toMatchObject({ gcodeFilename: 'b50.gcode', attachmentId: att.id });
  });

  it('warns UNITS_DIFFER_FROM_LABELS when the units differ from the file', async () => {
    const { svc } = setup();
    const out = await svc.convert(P, 'v-b50', { ...MANUAL, unitsPerPlate: 48, assembledUploadId: UPLOAD }, ACTOR);
    expect(out.warnings.map((w) => w.code)).toContain('UNITS_DIFFER_FROM_LABELS');
  });

  it('a transaction failure leaves the option as it was, no rows, deletes the written file and keeps the staged upload', async () => {
    const { h, chunk, svc } = setup();
    jest.spyOn(h.db.plateLayoutSlot, 'create').mockRejectedValueOnce(new Error('connection reset'));
    await expect(svc.convert(P, 'v-b50', { ...MANUAL, assembledUploadId: UPLOAD }, ACTOR)).rejects.toThrow('connection reset');
    expect(opt(h, 'v-b50')).toMatchObject({ isActive: true });
    expect(opt(h, 'v-b50').convertedLayoutId ?? null).toBeNull();
    expect(h.db.t('plateLayout')).toHaveLength(0);
    expect(h.db.t('attachment')).toHaveLength(0);
    expect(h.db.t('auditLog')).toHaveLength(0);
    expect(filesOnDisk()).toEqual([]);
    expect(chunk.discard).not.toHaveBeenCalled();
  });

  it('a multicolour part: one slot per colour, matched by the file\'s colours; a hex-less filament by its catalogue swatch', async () => {
    const row = sardineRow();
    row.variants.push({ ...row.variants[0], id: 'v-fish1', name: 'fish 1', basePrice: 3, estimatedGrams: 89.4, estimatedMinutes: 393 });
    const orange = row.components.find((c: any) => c.id === 'c3').materials[1].material;
    Object.assign(orange, { colorHex: null, brand: 'eSUN', color: 'Silk Orange' });
    const file = gcode({ labels: labels('fish', 31), minutes: 393, toolGrams: [20, 69.4], totalGrams: 89.4, colours: ['#FF8000', '#FFFFFF'] });
    const { h, svc } = setup({ rows: [row], file, name: 'fish x31.gcode' });
    h.db.insert('filamentCatalog', { id: 1, brand: 'eSUN', colour: 'Silk Orange', type: 'PLA', hex: 'FF8000' });
    const body = { componentId: 'c3', unitsPerPlate: 31, plateMinutes: 393, plateGrams: 89.4, assembledUploadId: UPLOAD };
    const preview = await svc.preview('p-sardine', 'v-fish1', body);
    expect(preview.slotMatch).toBe('FILE_COLOURS');
    expect(preview.layout.slots.map((s) => [s.colorIndex, s.gramsUsed, s.colour.source])).toEqual([[0, 69.4, 'FILAMENT'], [1, 20, 'CATALOGUE']]);
    const out = await svc.convert('p-sardine', 'v-fish1', body, ACTOR);
    expect(out.layout.slots).toEqual([{ colorIndex: 0, gramsUsed: 69.4 }, { colorIndex: 1, gramsUsed: 20 }]);
  });
});

describe('O8a preview', () => {
  it('writes nothing and keeps the staged upload, so the POST can use it', async () => {
    const { h, chunk, svc } = setup();
    const before = JSON.stringify(h.db.tables());
    const p = await svc.preview(P, 'v-b50', { ...MANUAL, unitsPerPlate: '50', assembledUploadId: UPLOAD });
    expect(JSON.stringify(h.db.tables())).toBe(before);
    expect(chunk.discard).not.toHaveBeenCalled();
    expect(filesOnDisk()).toEqual([]);
    expect(p.layout).toMatchObject({ name: '×50', source: 'GCODE', objectCount: 50, gcodeFilename: 'b50.gcode', minutesPerUnit: 8.42, gramsPerUnit: 2.415 });
    await svc.convert(P, 'v-b50', { ...MANUAL, assembledUploadId: UPLOAD }, ACTOR);
    expect(chunk.consume).toHaveBeenCalledTimes(2);
  });

  it('returns the option, part, planning table, history and warnings', async () => {
    const { svc } = setup();
    const p = await svc.preview(P, 'v-b50', MANUAL);
    expect(p.option).toEqual({ id: 'v-b50', name: 'b50', isActive: true, legacyPrice: 4.5, estimatedGrams: 120.77, estimatedMinutes: 421 });
    expect(p.component).toEqual({ id: 'c-base', description: 'BASE', sizeOptionId: null, isMultiColour: false, gramsPerUnit: 2.47, minutesPerUnit: 12 });
    expect(p).toMatchObject({ slotMatch: 'SINGLE', recommendActive: true, warnings: [] });
    expect(p.layout.slots[0]).toMatchObject({ colorIndex: 0, gramsUsed: 120.77, colour: { hex: 'FFFFFF', source: 'FILAMENT', swatch: null }, tools: [] });
    expect(p.planning.surplusPolicy).toBe('KEEP_FOR_STOCK');
    // The standard size, then the other active sizes that plan on the standard parts (Big has its own).
    expect(p.planning.appliesTo).toEqual(['Standard', 'c25', 't50', 'Tiered']);
    expect(p.planning.rows.map((r) => r.units)).toEqual([2, 25, 50, 51]);
    expect(p.planning.rows[0]).toEqual({
      units: 2,
      now: { plates: [{ unitsPerPlate: 1, plateCount: 2 }], minutes: 24, grams: 4.94, extra: 0 },
      withPlate: { plates: [{ unitsPerPlate: 50, plateCount: 1 }], minutes: 421, grams: 120.77, extra: 48 },
    });
    expect(p.history).toEqual({ orderLines: 0, quoteLines: 0, jobs: 0 });
  });

  it('lists only open work left to plan; delivered or cancelled lines only count in the history', async () => {
    const { h, svc } = setup();
    addOrderLine(h.db, { productId: P, sizeOptionId: 'v-b50', quantity: 4 }, 'DELIVERED');
    addOrderLine(h.db, { productId: P, sizeOptionId: 'v-b50', quantity: 2 }, 'CANCELLED');
    const planned = addOrderLine(h.db, { productId: P, sizeOptionId: 'v-b50', quantity: 1 }, 'CONFIRMED');
    const job = addJob(h.db, { productId: P, orderItemId: planned.id, sizeOptionId: 'v-b50', status: 'QUEUED' });
    for (const c of ['c-base', 'c-top', 'c-whisk']) h.db.insert('jobPlate', { jobId: job.id, componentId: c, layoutId: null, unitsRequired: 1, plateCount: 1 });
    const pending = addOrderLine(h.db, { productId: P, variantId: 'v-b50', quantity: 6 }, 'PENDING');
    addQuoteLine(h.db, { productId: P, sizeOptionId: 'v-b50', quantity: 12 }, 'DRAFT');
    addQuoteLine(h.db, { productId: P, sizeOptionId: 'v-b50', quantity: 5 }, 'ACCEPTED');
    const p = await svc.preview(P, 'v-b50', MANUAL);
    expect(p.history).toEqual({ orderLines: 4, quoteLines: 2, jobs: 1 });
    const orderNo = h.db.t('order').find((o: any) => o.id === pending.orderId).orderNumber;
    expect(p.openLines.total).toBe(2);
    expect(p.openLines.lines).toEqual([
      { kind: 'ORDER', number: orderNo, quantity: 6, partlyPlanned: false },
      { kind: 'QUOTE', number: expect.stringMatching(/^Q-/), quantity: 12, partlyPlanned: false },
    ]);
  });
});

describe('refusals (preview and convert alike)', () => {
  const both = async (s: ReturnType<typeof setup>, variantId: string, body: Record<string, unknown>) => [
    await statusOf(s.svc.preview(P, variantId, body)), await statusOf(s.svc.convert(P, variantId, body, ACTOR)),
  ];

  it('404 option, 400 colour, 409 own components, 409 own bulk tiers', async () => {
    const s = setup();
    expect(await both(s, 'nope', MANUAL)).toEqual([404, 404]);
    expect(await both(s, 'v-red', MANUAL)).toEqual([400, 400]);
    await expect(s.svc.preview(P, 'v-red', MANUAL)).rejects.toThrow('"Red" is a colour — only sizes can become plate layouts');
    expect(await both(s, 'v-big', MANUAL)).toEqual([409, 409]);
    await expect(s.svc.convert(P, 'v-tier', MANUAL, ACTOR)).rejects.toThrow('"Tiered" has its own components or bulk tiers — it is a real size, not a plate');
    expect(s.h.db.t('plateLayout')).toHaveLength(0);
  });

  it('404 for a part of another product; 400 for one unit per plate', async () => {
    const s = setup({ rows: [clickerRow(), sardineRow()] });
    expect(await both(s, 'v-b50', { ...MANUAL, componentId: 'c1' })).toEqual([404, 404]);
    await expect(s.svc.convert(P, 'v-b50', { ...MANUAL, unitsPerPlate: 1 }, ACTOR))
      .rejects.toThrow('One unit per plate is "BASE" itself — deactivate "b50" instead');
  });

  it('409 when the part already has an ACTIVE ×N; an inactive ×N is allowed', async () => {
    const s = setup();
    s.h.db.insert('plateLayout', { id: 'l-old', componentId: 'c-base', name: '×50', unitsPerPlate: 50, plateMinutes: 400, plateGrams: 120, isActive: true, sortOrder: 0, source: 'MANUAL' });
    await expect(s.svc.convert(P, 'v-b50', MANUAL, ACTOR)).rejects.toThrow('A ×50 layout already exists for "BASE" — deactivate "b50" instead');
    expect(opt(s.h, 'v-b50').isActive).toBe(true);
    s.h.db.t('plateLayout')[0].isActive = false;
    await expect(s.svc.convert(P, 'v-b50', MANUAL, ACTOR)).resolves.toBeTruthy();
  });

  it('409 while the conversion is live (plate on or off); after the layout is deleted it converts again, replacing the marker', async () => {
    const s = setup();
    const first = await s.svc.convert(P, 'v-b50', MANUAL, ACTOR);
    const again = 'is already converted to BASE ×50 — delete that layout under "BASE" → Manage to convert it again';
    await expect(s.svc.preview(P, 'v-b50', MANUAL)).rejects.toThrow(`"b50" ${again}`);
    s.h.db.t('plateLayout')[0].isActive = false;
    expect(await both(s, 'v-b50', MANUAL)).toEqual([409, 409]);

    await s.h.db.plateLayout.delete({ where: { id: first.layout.id } });
    const second = await s.svc.convert(P, 'v-b50', { ...MANUAL, unitsPerPlate: 48 }, ACTOR);
    expect(opt(s.h, 'v-b50').convertedLayoutId).toBe(second.layout.id);
    expect(s.h.db.t('auditLog')[1].details).toMatchObject({ previousLayoutId: first.layout.id, wasActive: false });
  });

  it('an already inactive option stays inactive and gets the marker', async () => {
    const s = setup();
    opt(s.h, 'v-c25').isActive = false;
    const out = await s.svc.convert(P, 'v-c25', { componentId: 'c-whisk', unitsPerPlate: 25, plateMinutes: 655, plateGrams: 125.9 }, ACTOR);
    expect(opt(s.h, 'v-c25')).toMatchObject({ isActive: false, convertedLayoutId: out.layout.id });
  });

  it('bad input is a 400 before the upload is touched', async () => {
    const s = setup();
    expect(await statusOf(s.svc.convert(P, 'v-b50', { ...MANUAL, plateGrams: 'lots', assembledUploadId: UPLOAD }, ACTOR))).toBe(400);
    expect(await statusOf(s.svc.preview(P, 'v-b50', { ...MANUAL, componentId: '' }))).toBe(400);
    expect(s.chunk.consume).not.toHaveBeenCalled();
  });

  it('a non-G-code upload → 400', async () => {
    const s = setup({ name: 'plate.3mf' });
    await expect(s.svc.preview(P, 'v-b50', { ...MANUAL, assembledUploadId: UPLOAD })).rejects.toThrow('File must be a G-code file (.gcode, .gco, .g)');
  });
});
