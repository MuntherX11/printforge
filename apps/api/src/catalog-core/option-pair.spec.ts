import { BomResolverService } from './bom-resolver.service';
import type { ProductConfig } from './catalog-config';
import {
  colourOffered, effectiveOptions, lineDescription, mapLegacyVariantId, pairLabel, relabelDescription,
  standardColourSellable, standardSizeSellable, validatePair, withLineNote, type PairContext,
} from './option-pair';
import { fixtureMaterial, M, OPT, PRODUCT_ID, sardineConfig, SLOT, type FixtureRow } from './__fixtures__/sardine-tin';

const resolver = new BomResolverService({} as any);
const ctxOf = (config: ProductConfig): PairContext => resolver.pairContext(config);
const sardine = (mutate?: (r: FixtureRow) => void) => ctxOf(sardineConfig(mutate));
const opt = (r: FixtureRow, id: string) => r.variants.find((v: any) => v.id === id);

/** Adds Green (no filaments) and Gold (Band → PLA Gold, not made in Large). */
const withGreenGold = (r: FixtureRow) => {
  r.variants.push({ ...opt(r, OPT.red), id: 'v-green', name: 'Green', sortOrder: 5, colourAssignments: [], sizeExclusions: [] });
  r.variants.push({
    ...opt(r, OPT.red), id: 'v-gold', name: 'Gold', sortOrder: 6,
    colourAssignments: [{ colourSlotId: SLOT.band, materialId: M.gold, material: fixtureMaterial(M.gold) }],
    sizeExclusions: [{ sizeKey: OPT.large }],
  });
};

describe('validatePair (§3.1 rule 9)', () => {
  const ctx = sardine(withGreenGold);
  const v = (s: string | null, c: string | null, o: Partial<Parameters<typeof validatePair>[3]> = {}) =>
    () => validatePair(ctx, s, c, { audience: 'STAFF', ...o });

  it('accepts a valid pair and returns the rows', () => {
    const r = validatePair(ctx, OPT.large, OPT.red, { audience: 'CUSTOMER' });
    expect([r.size?.name, r.colour?.name]).toEqual(['Large', 'Red']);
  });

  it('every ownership and kind message, with the prefix', () => {
    const p = { prefix: 'Line 1: ' };
    expect(v('v-other', null, p)).toThrow('Line 1: that size belongs to another product');
    expect(v(OPT.red, null, p)).toThrow('Line 1: "Red" is a colour, not a size');
    expect(v(null, 'v-other', p)).toThrow('Line 1: that colour belongs to another product');
    expect(v(null, OPT.large, p)).toThrow('Line 1: "Large" is a size, not a colour');
  });

  it('inactive product, size and colour rejected unless allowInactive', () => {
    const c = sardine((r) => { r.isActive = false; });
    expect(() => validatePair(c, null, null, { audience: 'STAFF' })).toThrow('"Sardine tin" is inactive');
    expect(() => validatePair(c, null, null, { audience: 'STAFF', allowInactive: true })).not.toThrow();
    const s = sardine((r) => { opt(r, OPT.large).isActive = false; opt(r, OPT.red).isActive = false; });
    expect(() => validatePair(s, OPT.large, null, { audience: 'STAFF' })).toThrow('size "Large" is no longer available');
    expect(() => validatePair(s, null, OPT.red, { audience: 'STAFF' })).toThrow('colour "Red" is no longer available');
    expect(() => validatePair(s, OPT.large, OPT.red, { audience: 'STAFF', allowInactive: true })).not.toThrow();
  });

  it('an excluded pair → 400 for staff and customers; allowInactive (existing lines) passes', () => {
    expect(v(OPT.large, 'v-gold')).toThrow(`"Gold" isn't made in Large`);
    expect(v(OPT.large, 'v-gold', { audience: 'CUSTOMER' })).toThrow(`"Gold" isn't made in Large`);
    expect(v(OPT.large, 'v-gold', { allowInactive: true })).not.toThrow();
    expect(v(null, 'v-gold')).not.toThrow();
  });

  it('a not-set-up colour: CUSTOMER 400 "can\'t be ordered yet", STAFF passes', () => {
    expect(v(OPT.large, 'v-green', { audience: 'CUSTOMER', prefix: 'Line 1: ' })).toThrow(`Line 1: "Large · Green" can't be ordered yet`);
    expect(v(OPT.large, 'v-green')).not.toThrow();
  });

  it('standard size and colour choices', () => {
    const hidden = sardine((r) => { r.baseOptionSellable = null; r.standardColourSellable = null; });
    expect(() => validatePair(hidden, null, OPT.red, { audience: 'CUSTOMER' })).toThrow('choose a size for "Sardine tin"');
    expect(() => validatePair(hidden, OPT.large, null, { audience: 'CUSTOMER' })).toThrow('choose a colour for "Sardine tin"');
    expect(() => validatePair(hidden, null, null, { audience: 'STAFF' })).not.toThrow();
  });
});

describe('standard size / colour sellable (§3.1 rules 6-7)', () => {
  it('customer standard size: null → hidden while sizes are active; true → offered', () => {
    expect(standardSizeSellable(sardineConfig((r) => { r.baseOptionSellable = null; }), 'CUSTOMER')).toBe(false);
    expect(standardSizeSellable(sardineConfig(), 'CUSTOMER')).toBe(true);
    expect(standardSizeSellable(sardineConfig((r) => { r.baseOptionSellable = null; }), 'STAFF')).toBe(true);
  });
  it('a container product (active sizes, no standard components) sells no standard size', () => {
    const config = sardineConfig((r) => { r.components = r.components.filter((c: any) => c.variantId); });
    expect(standardSizeSellable(config, 'STAFF')).toBe(false);
  });
  it('customer standard colour: null hidden while colours are active; no active colours → offered regardless; staff always', () => {
    const nullSwitch = sardine((r) => { r.standardColourSellable = null; });
    expect(standardColourSellable(nullSwitch, 'CUSTOMER')).toBe(false);
    expect(standardColourSellable(nullSwitch, 'STAFF')).toBe(true);
    expect(standardColourSellable(sardine(), 'CUSTOMER')).toBe(true);
    const noColours = sardine((r) => { r.standardColourSellable = null; r.variants = r.variants.filter((x: any) => x.kind === 'SIZE'); });
    expect(standardColourSellable(noColours, 'CUSTOMER')).toBe(true);
  });
  it('standard colour mixed: not sellable to customers even when the switch is true; staff still offered', () => {
    const mixed = sardine((r) => {
      const c6 = r.components.find((c: any) => c.id === 'c6');
      c6.materialId = M.grey; c6.material = fixtureMaterial(M.grey);
    });
    expect(mixed.standardColourMixed).toBe(true);
    expect(standardColourSellable(mixed, 'CUSTOMER')).toBe(false);
    expect(standardColourSellable(mixed, 'STAFF')).toBe(true);
    expect(() => validatePair(mixed, OPT.large, null, { audience: 'STAFF' })).not.toThrow();
  });
});

describe('colourOffered (§3.1 rule 8)', () => {
  it('CUSTOMER false for not set up, no effect on that size, an unlinked slot on the size, and an excluded pair; STAFF only excluded', () => {
    const ctx = sardine((r) => {
      withGreenGold(r);
      r.variants.push({ ...opt(r, OPT.red), id: 'v-trim', name: 'Trimmed', colourAssignments: [{ colourSlotId: SLOT.band, materialId: M.gold, material: fixtureMaterial(M.gold) }], sizeExclusions: [] });
      r.components.find((c: any) => c.id === 'c7').materials[0].colourSlotId = null; // Large Lid colour 1 unlinked
    });
    expect(colourOffered(ctx, OPT.large, 'v-green', 'CUSTOMER')).toBe(false); // NOT_SET_UP
    expect(colourOffered(ctx, OPT.large, 'v-trim', 'CUSTOMER')).toBe(false); // NO_EFFECT: Band not on Large
    expect(colourOffered(ctx, OPT.large, OPT.red, 'CUSTOMER')).toBe(false); // UNLINKED on Large
    expect(colourOffered(ctx, null, OPT.red, 'CUSTOMER')).toBe(true);
    expect(colourOffered(ctx, OPT.large, 'v-gold', 'CUSTOMER')).toBe(false); // excluded
    expect(colourOffered(ctx, OPT.large, 'v-green', 'STAFF')).toBe(true);
    expect(colourOffered(ctx, OPT.large, OPT.red, 'STAFF')).toBe(true);
    expect(colourOffered(ctx, OPT.large, 'v-gold', 'STAFF')).toBe(false);
  });
  it('the fixed slot counts as decided: a fully linked size offers its set-up colours', () => {
    const ctx = sardine();
    expect(colourOffered(ctx, OPT.large, OPT.red, 'CUSTOMER')).toBe(true);
    expect(colourOffered(ctx, OPT.large, OPT.blue, 'CUSTOMER')).toBe(true);
  });
});

describe('effectiveOptions (§3.2)', () => {
  const variants = new Map<string, any>([
    ['V', { id: 'V', productId: PRODUCT_ID, kind: 'SIZE' }],
  ]);
  const lookups = { variant: (id: string) => variants.get(id), orderItem: (id: string) => (id === 'oi-1' ? { variantId: 'V' } : null) };

  it('new columns win over variantId', () => {
    expect(effectiveOptions({ sizeOptionId: 'S', colourOptionId: null, variantId: 'V' }, lookups)).toEqual({ sizeOptionId: 'S', colourOptionId: null, legacy: false });
  });
  it('legacy variantId follows the CURRENT kind (reclassify and re-read)', () => {
    expect(effectiveOptions({ variantId: 'V' }, lookups)).toEqual({ sizeOptionId: 'V', colourOptionId: null, legacy: true });
    variants.set('V', { id: 'V', productId: PRODUCT_ID, kind: 'COLOUR' });
    expect(effectiveOptions({ variantId: 'V' }, lookups)).toEqual({ sizeOptionId: null, colourOptionId: 'V', legacy: true });
  });
  it('a missing option → LINE_OPTION_MISSING skip', () => {
    expect(effectiveOptions({ variantId: 'gone' }, lookups)).toEqual({ skip: 'LINE_OPTION_MISSING' });
  });
  it('a pre-release order job (orderItemId, no variant, no pair) reads its line: V reclassified → (Standard, V)', () => {
    variants.set('V', { id: 'V', productId: PRODUCT_ID, kind: 'COLOUR' });
    expect(effectiveOptions({ orderItemId: 'oi-1', variantId: null }, lookups)).toEqual({ sizeOptionId: null, colourOptionId: 'V', legacy: true });
    expect(effectiveOptions({ orderItemId: 'oi-x' }, lookups)).toEqual({ sizeOptionId: null, colourOptionId: null, legacy: false });
  });
});

describe('mapLegacyVariantId (§3.1 rule 13)', () => {
  const v = (id: string) => ({ 'v-col': { id: 'v-col', productId: 'p1', kind: 'COLOUR' }, 'v-size': { id: 'v-size', productId: 'p1', kind: 'SIZE' } } as any)[id];
  it('{ variantId: <colour> } → colourOptionId', () => {
    expect(mapLegacyVariantId({ productId: 'p1', variantId: 'v-col' }, v)).toEqual({ productId: 'p1', sizeOptionId: null, colourOptionId: 'v-col' });
    expect(mapLegacyVariantId({ productId: 'p1', variantId: 'v-size' }, v)).toEqual({ productId: 'p1', sizeOptionId: 'v-size', colourOptionId: null });
  });
  it('{ variantId } without productId (customer) takes the product from the option', () => {
    expect(mapLegacyVariantId({ variantId: 'v-col' }, v).productId).toBe('p1');
  });
  it('new columns present → variantId ignored; unknown option → 400', () => {
    expect(mapLegacyVariantId({ productId: 'p1', variantId: 'v-col', sizeOptionId: 'S' }, v)).toEqual({ productId: 'p1', sizeOptionId: 'S', colourOptionId: null });
    expect(() => mapLegacyVariantId({ variantId: 'x' }, v, 'Line 2: ')).toThrow('Line 2: that size or colour no longer exists');
  });
});

describe('labels and line descriptions (§3.1 rule 11, §3.9 step 10)', () => {
  it('pair labels use only the axes the product has', () => {
    const both = sardineConfig();
    const large = both.options.find((o) => o.id === OPT.large)!;
    const red = both.options.find((o) => o.id === OPT.red)!;
    expect(pairLabel(both, large, red)).toBe('Large · Red');
    expect(pairLabel(both, null, null)).toBe('Regular · Black');
    const sizesOnly = sardineConfig((r) => { r.variants = r.variants.filter((x: any) => x.kind === 'SIZE'); });
    expect(pairLabel(sizesOnly, large, null)).toBe('Large');
    const coloursOnly = sardineConfig((r) => { r.variants = r.variants.filter((x: any) => x.kind === 'COLOUR'); });
    expect(pairLabel(coloursOnly, null, red)).toBe('Red');
  });

  const label = lineDescription({ name: 'Sardine tin' }, { name: 'Large' }, { name: 'Red' });
  it('lineDescription omits standard axes', () => {
    expect(label).toBe('Sardine tin — Large — Red');
    expect(lineDescription({ name: 'Sardine tin' }, null, { name: 'Red' })).toBe('Sardine tin — Red');
    expect(lineDescription({ name: 'Sardine tin' }, null, null)).toBe('Sardine tin');
  });
  it('withLineNote: the label always comes first', () => {
    expect(withLineNote(label, '')).toBe('Sardine tin — Large — Red');
    expect(withLineNote(label, 'Sardine tin — Large — Red — gift wrap')).toBe('Sardine tin — Large — Red — gift wrap');
    expect(withLineNote(label, 'gift wrap')).toBe('Sardine tin — Large — Red — gift wrap');
    expect(withLineNote(label, 'Sardine tin — Large — Blue')).toBe('Sardine tin — Large — Red — Sardine tin — Large — Blue');
    expect(withLineNote(label, 'Sardine tin — Large — Blue, gift wrap')).toBe('Sardine tin — Large — Red — Sardine tin — Large — Blue, gift wrap');
    expect(withLineNote(label, '<b>gift</b> wrap<script>')).toBe('Sardine tin — Large — Red — gift wrap');
    const long = withLineNote(label, 'x'.repeat(300));
    expect(long.length).toBe(200);
    expect(long.startsWith(`${label} — x`)).toBe(true);
  });
  it('relabelDescription (S11): prefix replaced and note kept; pre-release text becomes the note', () => {
    const large = lineDescription({ name: 'Sardine tin' }, { name: 'Large' }, null);
    expect(relabelDescription('Sardine tin — Large — gift box', large, label)).toBe('Sardine tin — Large — Red — gift box');
    expect(relabelDescription('Sardine tin — Large', large, label)).toBe('Sardine tin — Large — Red');
    expect(relabelDescription('Tin order', large, label)).toBe('Sardine tin — Large — Red — Tin order');
  });
});
