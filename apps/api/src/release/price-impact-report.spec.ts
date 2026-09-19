import { BomResolverService } from '../catalog-core/bom-resolver.service';
import { PricingService } from '../catalog-core/pricing.service';
import { boxRow, SETTINGS } from '../catalog-core/__fixtures__/box-product';
import { fixtureComponent, M } from '../catalog-core/__fixtures__/sardine-tin';
import { fakeCatalogDb, seedProduct } from '../products/__fixtures__/fake-catalog-db';
import { csvCell, PriceImpactReport, toCsv, type Section } from './price-impact-report';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../common/prisma/prisma.service';
import { PriceImpactReportModule, singleConnectionUrl } from './price-impact-report.main';

/** WP11 price-impact report (spec §6 WP11) and §7.1 item 28 "the WP11 report (dry run on the fixture DB)". */

const T0 = new Date('2026-01-01T00:00:00Z');
const legacy = (id: string, productId: string, name: string, basePrice: number | null, extra: Record<string, unknown> = {}) => ({
  id, productId, name, sku: null, kind: 'SIZE', isActive: true, sortOrder: 0, basePrice, estimatedGrams: null, estimatedMinutes: null, createdAt: T0, ...extra,
});

function setup() {
  const db = fakeCatalogDb();
  const box = boxRow();
  box.components[0].stockOnHand = 5;
  box.components[0].stockConfirmedAt = null;
  box.components[0].platedUnits = 12;
  box.components[0].platedMinutes = 243;
  box.components[0].platedGrams = 112.8;
  box.variants = [
    legacy('v-red', box.id, 'Red', 0.93),
    legacy('v-ahmar', box.id, 'أحمر', 1.2),
    legacy('v-large', box.id, 'Large', 2.0),
    legacy('v-gift', box.id, 'Gift box', 0.93),
  ];
  seedProduct(db, box);

  // A four-colour slicer product priced under the old formula (purge counted twice).
  const fish = fixtureComponent('fish', null, 'Fish', 1, 0, 60, [[0, M.white, 20, null], [1, M.orange, 3, null], [2, M.black, 2, null], [3, M.red, 2, null]], [],
    { productId: 'p-fish', platedUnits: 10, platedMinutes: 300, platedGrams: 40 });
  seedProduct(db, {
    id: 'p-fish', name: 'Fish', isActive: true, basePrice: 2.5, colorChanges: 6, baseOptionLabel: null, baseOptionSellable: null,
    standardColourLabel: null, standardColourSellable: null, surplusPolicy: 'KEEP_FOR_STOCK', defaultPrinterId: null, updatedAt: T0,
    colourSlots: [], variants: [legacy('v-fish-xl', 'p-fish', 'XL', 3)], components: [fish], parts: [],
  });

  db.insert('orderItem', { id: 'oi-red', orderId: 'o1', productId: box.id, variantId: 'v-red', sizeOptionId: null, colourOptionId: null });
  db.insert('orderItem', { id: 'oi-gone', orderId: 'o1', productId: 'p-gone', variantId: null, sizeOptionId: null, colourOptionId: null });
  db.insert('orderItem', { id: 'oi-cross', orderId: 'o1', productId: box.id, variantId: 'v-fish-xl', sizeOptionId: null, colourOptionId: null });
  db.insert('quoteItem', { id: 'qi-1', quoteId: 'q1', productId: box.id, sizeOptionId: null, colourOptionId: null });
  db.insert('productionJob', { id: 'j-red', variantId: 'v-red', sizeOptionId: null, colourOptionId: null });

  const resolver = new BomResolverService(db as any);
  const costing: any = { loadSettings: jest.fn(async () => ({ ...SETTINGS })) };
  const pricing = new PricingService(db as any, resolver, costing);
  return { db, report: new PriceImpactReport(db as any, resolver, pricing) };
}

const section = (all: Section[], prefix: string) => all.find((s) => s.name.startsWith(prefix))!;
const rowsOf = (s: Section) => s.rows.map((r) => Object.fromEntries(s.header.map((h, i) => [h, r[i]])));

describe('PriceImpactReport', () => {
  it('is read-only: no table changes', async () => {
    const { db, report } = setup();
    const before = JSON.stringify(db.tables());
    await report.build();
    expect(JSON.stringify(db.tables())).toBe(before);
  });

  it('prices: one row per standard size and size; box unchanged, the slicer multicolour product drops with the purge cause', async () => {
    const { report } = setup();
    const prices = rowsOf(section(await report.build(), 'prices'));
    const box = prices.find((r) => r.productId === 'p-box' && r.size === 'Standard')!;
    expect(box).toMatchObject({ storedPrice: '0.930', newCost: '0.372', newPrice: '0.930', deltaPct: 0, complete: true, flag: '' });
    expect(prices.filter((r) => r.productId === 'p-box').map((r) => r.size)).toEqual(['Standard', 'Gift box', 'Large', 'Red', 'أحمر']);
    const legacySize = prices.find((r) => r.size === 'Large')!;
    expect(legacySize.likelyCause).toContain('legacy size without its own components');
    const fish = prices.find((r) => r.productId === 'p-fish' && r.size === 'Standard')!;
    expect(fish.flag).toBe('DROP');
    expect(fish.deltaPct as number).toBeLessThan(-10);
    expect(fish.likelyCause).toContain('purge no longer double-counted');
    expect(fish.likelyCause).toContain('multicolour');
  });

  it('existing variants: "Red" and "أحمر" are likelyColour with suggestedKind COLOUR (§7.1 item 28)', async () => {
    const { report } = setup();
    const all = await report.build();
    const v = rowsOf(section(all, 'existing variants'));
    const by = (name: string) => v.find((r) => r.variant === name)!;
    expect(by('Red')).toMatchObject({ likelyColour: true, suggestedKind: 'COLOUR', orderLines: 1, quoteLines: 0, jobs: 1, hasBaseComponents: true, currentKind: 'SIZE' });
    expect(by('أحمر')).toMatchObject({ likelyColour: true, suggestedKind: 'COLOUR' });
    expect(by('Large')).toMatchObject({ likelyColour: false, suggestedKind: 'SIZE' });
    // same price as the standard and the product has base components → COLOUR
    expect(by('Gift box')).toMatchObject({ likelyColour: false, suggestedKind: 'COLOUR' });
    const summary = rowsOf(section(all, 'existing variants: per-product summary'));
    expect(summary.find((r) => r.productId === 'p-box')).toMatchObject({
      sizesIfClassified: 1,
      coloursIfClassified: 3,
      shopPriceChanges: '"أحمر" 1.200 → 0.930 in the shop after classification',
    });
  });

  it('suspect lines: missing product and an option of another product, with ids', async () => {
    const { report } = setup();
    const s = rowsOf(section(await report.build(), 'suspect lines'));
    expect(s).toEqual(expect.arrayContaining([
      { table: 'OrderItem', reason: 'PRODUCT_MISSING', count: 1, ids: 'oi-gone' },
      { table: 'OrderItem', reason: 'OPTION_OF_ANOTHER_PRODUCT (variantId)', count: 1, ids: 'oi-cross' },
    ]));
    expect(s).toHaveLength(2);
  });

  it('BF-1 dry run: an existing ×12 layout is skipped; stale grams become an inactive review layout', async () => {
    const { report } = setup();
    const l = rowsOf(section(await report.build(), 'BF-1'));
    expect(l[0]).toMatchObject({ componentId: 'fish', outcome: 'INACTIVE_REVIEW' });
    expect(String(l[0].note)).toContain('plate grams differ by');
    expect(l.find((r) => r.componentId === 'box')).toMatchObject({ outcome: 'SKIP', note: 'layout exists' });
  });

  it('stock to confirm: unconfirmed column flagged mayMixColours when a colour-like option was on old jobs', async () => {
    const { report } = setup();
    const s = rowsOf(section(await report.build(), 'stock to confirm'));
    expect(s).toEqual([expect.objectContaining({ componentId: 'box', stockOnHand: 5, confirmed: false, mayMixColours: true, colourLikeOptionsOnOldJobs: 'Red' })]);
  });

  it('CSV: quotes, formula-safe text, sections', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK(1)')).toBe("'=HYPERLINK(1)");
    expect(csvCell('-12.5')).toBe('-12.5');
    expect(csvCell(-12.5)).toBe('-12.5');
    expect(csvCell(null)).toBe('');
    expect(toCsv([{ name: 'x', header: ['a'], rows: [[1]] }])).toBe('# section: x (1 rows)\na\n1\n');
  });

  it('forces a single database connection', () => {
    expect(singleConnectionUrl('postgresql://u:p@db:5432/pf_restore?schema=public')).toBe('postgresql://u:p@db:5432/pf_restore?schema=public&connection_limit=1');
    expect(() => singleConnectionUrl(undefined)).toThrow('DATABASE_URL');
  });

  it('the CLI module wires the report without Redis or the HTTP app', async () => {
    const mod = await Test.createTestingModule({ imports: [PriceImpactReportModule] }).overrideProvider(PrismaService).useValue(fakeCatalogDb()).compile();
    expect(mod.get(PriceImpactReport)).toBeInstanceOf(PriceImpactReport);
    await mod.close();
  });
});
