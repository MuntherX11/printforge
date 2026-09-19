import { BadRequestException } from '@nestjs/common';
import {
  parseAssignments, parseColourLinks, parseComponentCreate, parseComponentMaterials, parseComponentPatch, parseKindChanges,
  parseMinQtys, parseOptionCreate, parseOptionPatch, parsePage, parsePartLine, parseProductPatch, parseReadinessQty,
  parseSlotPatch, parseStockSet, parseTiers, rejectStaleQuery, STALE_PAGE,
} from './product-input';

/** Expect a 400 whose message names `field`. */
function rejects(fn: () => unknown, field: string | RegExp) {
  let err: unknown;
  try { fn(); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(BadRequestException);
  const msg = (err as Error).message;
  if (typeof field === 'string') expect(msg).toContain(field);
  else expect(msg).toMatch(field);
}

/**
 * §7.1 item 37: for a numeric input — both bounds accepted, one past each
 * rejected naming the field, NaN, Infinity and a string rejected.
 */
function bounds(name: string, make: (v: unknown) => unknown, field: string, lo: number, hi: number, step = 1) {
  describe(name, () => {
    it('accepts both bounds', () => {
      expect(() => make(lo)).not.toThrow();
      expect(() => make(hi)).not.toThrow();
    });
    it('rejects one past each bound, naming the field', () => {
      rejects(() => make(lo - step), field);
      rejects(() => make(hi + step), field);
    });
    it('rejects NaN, Infinity and a string', () => {
      rejects(() => make(NaN), field);
      rejects(() => make(Infinity), field);
      rejects(() => make('abc'), field);
    });
  });
}

const comp = (over: Record<string, unknown>) => parseComponentCreate({ description: 'Box', materialId: 'm1', gramsUsed: 5, ...over });

describe('product-input (§4.7 bounds, allowlists)', () => {
  bounds('P1 page', (v) => parsePage(v, undefined), 'page', 1, 100_000);
  bounds('P1 limit', (v) => parsePage(1, v), 'limit', 1, 1000);
  bounds('P6 colorChanges', (v) => parseProductPatch({ colorChanges: v }), 'colorChanges', 0, 10_000);
  bounds('P9 gramsUsed', (v) => comp({ gramsUsed: v }), 'gramsUsed', 0.1, 100_000, 0.01);
  bounds('P9 printMinutes', (v) => comp({ printMinutes: v }), 'printMinutes', 0, 100_000);
  bounds('P9 quantity', (v) => comp({ quantity: v }), 'quantity', 1, 1000);
  bounds('P10 gramsUsed', (v) => parseComponentPatch({ gramsUsed: v }), 'gramsUsed', 0.1, 100_000, 0.01);
  bounds('P10 printMinutes', (v) => parseComponentPatch({ printMinutes: v }), 'printMinutes', 0, 100_000);
  bounds('P10 quantity', (v) => parseComponentPatch({ quantity: v }), 'quantity', 1, 1000);
  bounds('P11 colorIndex', (v) => parseComponentMaterials({ slots: [{ colorIndex: v, materialId: 'm1' }] }), 'colorIndex', 0, 63);
  bounds('P13 stockOnHand', (v) => parseStockSet({ stockOnHand: v, expectedStockOnHand: 0 }), 'stockOnHand', 0, 1_000_000);
  bounds('P13 expectedStockOnHand', (v) => parseStockSet({ stockOnHand: 0, expectedStockOnHand: v }), 'expectedStockOnHand', 0, 1_000_000);
  bounds('P18 minQtys', (v) => parseMinQtys(String(v)), 'minQtys', 2, 1_000_000);
  bounds('P19 minQty', (v) => parseTiers({ tiers: [{ minQty: v, unitPrice: 1 }] }), 'minQty', 2, 1_000_000);
  bounds('P19 unitPrice', (v) => parseTiers({ tiers: [{ minQty: 5, unitPrice: v }] }), 'unitPrice', 0.001, 1_000_000, 0.0005);
  bounds('P20 qty', (v) => parseReadinessQty(v), 'qty', 1, 100_000);
  bounds('C2 sortOrder', (v) => parseSlotPatch({ sortOrder: v }), 'sortOrder', 0, 1000);
  bounds('C4 colorIndex', (v) => parseColourLinks({ links: [{ componentId: 'c1', colorIndex: v, fixed: true }] }), 'colorIndex', 0, 63);
  bounds('O1 sortOrder', (v) => parseOptionCreate({ name: 'Large', kind: 'SIZE', sortOrder: v }), 'sortOrder', 0, 10_000);
  bounds('O2 sortOrder', (v) => parseOptionPatch({ sortOrder: v }), 'sortOrder', 0, 10_000);

  describe('list lengths', () => {
    it('P13 is the only whole-number rule for stock: 2.5 → 400', () => rejects(() => parseStockSet({ stockOnHand: 2.5, expectedStockOnHand: 0 }), 'stockOnHand'));
    it('P18 minQtys: 1–20 distinct values', () => {
      expect(parseMinQtys('25,50,100')).toEqual([25, 50, 100]);
      expect(parseMinQtys(undefined)).toBeUndefined();
      rejects(() => parseMinQtys(Array.from({ length: 21 }, (_, i) => i + 2).join(',')), 'minQtys');
      rejects(() => parseMinQtys('25,25'), 'minQtys');
    });
    it('P19 tiers: a list of at most 20, duplicates named by index', () => {
      rejects(() => parseTiers({ tiers: 'x' }), 'tiers must be a list');
      rejects(() => parseTiers({}), 'tiers must be a list');
      rejects(() => parseTiers({ tiers: Array.from({ length: 21 }, (_, i) => ({ minQty: i + 2, unitPrice: 1 })) }), 'tiers');
      rejects(() => parseTiers({ tiers: [{ minQty: 5, unitPrice: 1 }, { minQty: 5, unitPrice: 2 }] }), 'tiers[1]: duplicate quantity 5');
      expect(parseTiers({ tiers: [{ minQty: 5, unitPrice: 1.23456 }] }).tiers[0].unitPrice).toBe(1.235);
    });
    it('C4 links ≤ 500 and slots ≤ 12', () => {
      const links = (n: number) => Array.from({ length: n }, (_, i) => ({ componentId: `c${i}`, colorIndex: 0, fixed: true }));
      expect(() => parseColourLinks({ links: links(500) })).not.toThrow();
      rejects(() => parseColourLinks({ links: links(501) }), 'links');
      const slots = (n: number) => Array.from({ length: n }, (_, i) => ({ ref: `r${i}`, name: `S${i}` }));
      expect(() => parseColourLinks({ slots: slots(12) })).not.toThrow();
      rejects(() => parseColourLinks({ slots: slots(13) }), 'slots');
      rejects(() => parseColourLinks({}), 'Nothing to save');
    });
    it('O5 slots ≤ 12 and excludedSizeKeys ≤ 31', () => {
      const slots = (n: number) => Array.from({ length: n }, (_, i) => ({ colourSlotId: `s${i}`, materialId: 'm' }));
      expect(() => parseAssignments({ slots: slots(12) })).not.toThrow();
      rejects(() => parseAssignments({ slots: slots(13) }), 'slots');
      const keys = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`);
      expect(() => parseAssignments({ slots: [], excludedSizeKeys: keys(31) })).not.toThrow();
      rejects(() => parseAssignments({ slots: [], excludedSizeKeys: keys(32) }), 'excludedSizeKeys');
    });
    it('O7 changes: 1–60', () => {
      const changes = (n: number) => Array.from({ length: n }, (_, i) => ({ variantId: `v${i}`, kind: 'COLOUR' }));
      expect(() => parseKindChanges({ changes: changes(60) })).not.toThrow();
      rejects(() => parseKindChanges({ changes: changes(61) }), 'changes');
      rejects(() => parseKindChanges({ changes: [] }), 'changes');
    });
  });

  describe('P6 allowlist (§7.1 item 13)', () => {
    it('ignores basePrice, imageUrl, estimated* and unknown keys', () => {
      const out = parseProductPatch({ name: 'Tin', basePrice: 9, imageUrl: '../../etc', estimatedGrams: 3, estimatedMinutes: 4, productId: 'x', foo: 1 });
      expect(out).toEqual({ name: 'Tin' });
    });
    it("turns '' into null for description, sku and the labels", () => {
      expect(parseProductPatch({ description: '', sku: '', baseOptionLabel: '', standardColourLabel: '' })).toEqual({
        description: null, sku: null, baseOptionLabel: null, standardColourLabel: null,
      });
    });
    it('strips HTML from the name and bounds text fields', () => {
      expect(parseProductPatch({ name: '<b>Tin</b>' }).name).toBe('Tin');
      rejects(() => parseProductPatch({ sku: 'x'.repeat(65) }), 'sku');
      rejects(() => parseProductPatch({ baseOptionLabel: 'x'.repeat(41) }), 'baseOptionLabel');
      rejects(() => parseProductPatch({ description: 'x'.repeat(2001) }), 'description');
    });
    it('booleans must be booleans and surplusPolicy an enum', () => {
      rejects(() => parseProductPatch({ isActive: 'yes' }), 'isActive');
      rejects(() => parseProductPatch({ surplusPolicy: 'SOMETIMES' }), 'surplusPolicy');
      expect(parseProductPatch({ standardColourSellable: true, surplusPolicy: 'cancel_on_printer' })).toEqual({ standardColourSellable: true, surplusPolicy: 'CANCEL_ON_PRINTER' });
    });
  });

  describe('components', () => {
    it('P9: −12 g → 400; a missing material id → 400', () => {
      rejects(() => comp({ gramsUsed: -12 }), 'gramsUsed');
      rejects(() => parseComponentCreate({ description: 'Box', gramsUsed: 5 }), 'materialId');
    });
    it('P9: linked and fixed at once → 400; stale variantId → 400', () => {
      rejects(() => comp({ colourSlotId: 's1', colourFixed: true }), /linked .* fixed/);
      rejects(() => comp({ variantId: 'v1' }), STALE_PAGE);
    });
    it('P10 ignores plated*, stockOnHand, productId, variantId and attachmentId', () => {
      expect(parseComponentPatch({ platedUnits: 3, stockOnHand: 9, productId: 'p', variantId: 'v', attachmentId: 'a', description: 'Lid' }))
        .toEqual({ confirm: false, description: 'Lid' });
    });
    it('P11 rejects a repeated colour index', () => {
      rejects(() => parseComponentMaterials({ slots: [{ colorIndex: 1, materialId: 'm' }, { colorIndex: 1, materialId: 'n' }] }), 'Colour 2 appears twice');
    });
  });

  describe('options and stale tabs', () => {
    it('O1 never accepts a price, minutes or grams; kind is required', () => {
      const o = parseOptionCreate({ name: 'Large', kind: 'size', basePrice: 3, estimatedMinutes: 5, estimatedGrams: 6 });
      expect(o).toEqual({ name: 'Large', sku: null, kind: 'SIZE', isActive: true });
      rejects(() => parseOptionCreate({ name: 'Large' }), 'kind');
    });
    it('O1 honours isActive:false and checks keepStandard', () => {
      expect(parseOptionCreate({ name: 'Red', kind: 'COLOUR', isActive: false }).isActive).toBe(false);
      rejects(() => parseOptionCreate({ name: 'Red', kind: 'COLOUR', keepStandard: { label: '', sellInShop: true } }), 'keepStandard.label');
      rejects(() => parseOptionCreate({ name: 'Red', kind: 'COLOUR', keepStandard: { label: 'Black' } }), 'keepStandard.sellInShop');
    });
    it('O2 with kind → 400', () => rejects(() => parseOptionPatch({ kind: 'COLOUR' }), 'Sizes & colours card'));
    it('P12, P19 bodies and P18/P20 queries with variantId → 400 out of date', () => {
      rejects(() => parseTiers({ variantId: 'x', tiers: [] }), STALE_PAGE);
      rejects(() => rejectStaleQuery({ variantId: 'x' }), STALE_PAGE);
    });
    it('P21 quantity: 0, 1001 and 2.5 → 400; 1 and 1000 accepted', () => {
      for (const q of [0, 1001, 2.5, 'abc', NaN]) rejects(() => parsePartLine({ partId: 'p', quantity: q }), 'Quantity must be a whole number from 1 to 1000');
      expect(parsePartLine({ partId: 'p', quantity: 1 }).quantity).toBe(1);
      expect(parsePartLine({ partId: 'p', quantity: 1000 }).quantity).toBe(1000);
    });
  });
});
