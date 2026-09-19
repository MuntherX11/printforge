import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { boxRow, BOX_ID } from '../catalog-core/__fixtures__/box-product';
import { fixtureMaterial, M, OPT, PRODUCT_ID, sardineRow, SLOT } from '../catalog-core/__fixtures__/sardine-tin';
import { addJob, addOrderLine, addQuoteLine, productsHarness, statusOf } from './__fixtures__/products-harness';

const P = PRODUCT_ID;
const T0 = new Date('2026-01-01T00:00:00Z');
const option = (id: string, name: string, kind: 'SIZE' | 'COLOUR', extra: Record<string, any> = {}) => ({
  id, productId: extra.productId ?? P, name, sku: null, kind, isActive: true, sortOrder: 0, basePrice: null, estimatedGrams: null, estimatedMinutes: null,
  createdAt: T0, colourAssignments: [], sizeExclusions: [], ...extra,
});
const assign = (slot: string, m: string) => ({ colourSlotId: slot, materialId: m, material: fixtureMaterial(m) });

/** Sardine without its colours, plus legacy sizes. */
function legacy(...extra: any[]) {
  const row = sardineRow();
  row.variants = row.variants.filter((v: any) => v.kind === 'SIZE').concat(extra);
  return row;
}

/** Box product (standard components only) with legacy sizes, both switches null. */
function boxWith(...variants: any[]) {
  const row = boxRow();
  row.variants = variants.map((v) => ({ ...v, productId: BOX_ID }));
  return row;
}

describe('VariantsService (§7.1 items 14, 33, 35, 41)', () => {
  describe('O1/O2', () => {
    it('a product takes sizes and colours together; the 31st size (inactive counted) → 400', async () => {
      const row = sardineRow();
      for (let i = 0; i < 29; i++) row.variants.push(option(`s${i}`, `S${i}`, 'SIZE', { isActive: i % 2 === 0 }));
      const h = productsHarness([row]);
      await expect(h.variants.create(P, { name: 'One more', kind: 'SIZE' })).rejects.toThrow('A product can have at most 30 sizes');
      const c: any = await h.variants.create(P, { name: 'Green', kind: 'COLOUR' });
      expect(c).toMatchObject({ kind: 'COLOUR', isActive: true, warnings: [{ code: 'COLOUR_OPTION_NOT_SET_UP' }] });
    });

    it('COLOUR on a product without components → 400; isActive:false honoured', async () => {
      const row = boxWith();
      row.components = [];
      const h = productsHarness([row]);
      await expect(h.variants.create(BOX_ID, { name: 'Red', kind: 'COLOUR' })).rejects.toThrow("Add the product's components before adding colours");
      const s: any = await h.variants.create(BOX_ID, { name: 'Large', kind: 'SIZE', isActive: false });
      expect(s.isActive).toBe(false);
    });

    it('O2 with kind → 400; price fields are ignored', async () => {
      const h = productsHarness([sardineRow()]);
      await expect(h.variants.update(P, OPT.large, { kind: 'COLOUR' })).rejects.toThrow('Change an option between size and colour on the Sizes & colours card');
      await h.variants.update(P, OPT.large, { basePrice: 99, estimatedGrams: 5, name: 'Big' });
      expect(h.db.t('productVariant').find((v: any) => v.id === OPT.large)).toMatchObject({ name: 'Big', basePrice: 2.8, estimatedGrams: null });
      expect(await statusOf(h.variants.update(P, 'nope', { name: 'x' }))).toBe(404);
    });

    it('deterministic sort per kind: default sortOrder is max+1 within the kind', async () => {
      const h = productsHarness([sardineRow()]);
      const a: any = await h.variants.create(P, { name: 'Small', kind: 'SIZE' });
      const b: any = await h.variants.create(P, { name: 'Gold', kind: 'COLOUR' });
      expect(a.sortOrder).toBe(1);
      expect(b.sortOrder).toBe(2);
      await h.variants.create(P, { name: 'Amber', kind: 'COLOUR', sortOrder: 2 });
      const d = await h.products.findOne(P);
      expect(d.sizes.map((s) => s.name)).toEqual(['Large', 'Small']);
      expect(d.colours.map((c) => c.name)).toEqual(['Red', 'Blue', 'Amber', 'Gold']);
    });

    it('O1 keepStandard: first COLOUR writes the standard colour label and switch; a second colour → 400', async () => {
      const h = productsHarness([boxWith()]);
      await h.variants.create(BOX_ID, { name: 'Red', kind: 'COLOUR', keepStandard: { label: 'Black', sellInShop: true } });
      expect(h.db.t('product')[0]).toMatchObject({ standardColourLabel: 'Black', standardColourSellable: true });
      await expect(h.variants.create(BOX_ID, { name: 'Blue', kind: 'COLOUR', keepStandard: { label: 'Black', sellInShop: true } }))
        .rejects.toThrow("keepStandard isn't needed for colours");
      expect(h.db.t('productVariant')).toHaveLength(1);
    });

    it('O1 keepStandard: first SIZE writes baseOptionLabel and baseOptionSellable', async () => {
      const h = productsHarness([boxWith()]);
      await h.variants.create(BOX_ID, { name: 'Large', kind: 'SIZE', keepStandard: { label: 'Regular', sellInShop: false } });
      expect(h.db.t('product')[0]).toMatchObject({ baseOptionLabel: 'Regular', baseOptionSellable: false });
      await expect(h.variants.create(BOX_ID, { name: 'Mini', kind: 'SIZE', keepStandard: { label: 'Regular', sellInShop: true } })).rejects.toThrow("keepStandard isn't needed for sizes");
    });
  });

  describe('O7 reclassification (§3.1 rule 3)', () => {
    it('reclassifies two of three legacy options (one inactive) in one call', async () => {
      const h = productsHarness([legacy(option('v-r', 'Red', 'SIZE', { basePrice: 1.5 }), option('v-b', 'Blue', 'SIZE', { isActive: false }), option('v-s', 'Small', 'SIZE'))]);
      const out = await h.variants.setKinds(P, { changes: [{ variantId: 'v-r', kind: 'COLOUR' }, { variantId: 'v-b', kind: 'COLOUR' }] });
      const kind = (id: string) => h.db.t('productVariant').find((v: any) => v.id === id).kind;
      expect([kind('v-r'), kind('v-b'), kind('v-s')]).toEqual(['COLOUR', 'COLOUR', 'SIZE']);
      expect(out.rewritten).toEqual({ orderLines: 0, quoteLines: 0, jobs: 0 });
      expect(out.colours.map((c) => c.id)).toEqual(['v-b', 'v-r']); // sortOrder, then name
      expect(out.warnings.filter((w) => w.code === 'COLOUR_HIDDEN_UNTIL_SET_UP')).toHaveLength(2);
      expect(out.warnings.some((w) => w.code === 'LEGACY_PRICE_IGNORED')).toBe(false);
      expect(h.db.locks[0]).toEqual({ table: 'ProductVariant', mode: 'UPDATE', ids: ['v-r', 'v-b'] });
    });

    const blocked = async (setup: (h: ReturnType<typeof productsHarness>) => void, id: string, kind: 'SIZE' | 'COLOUR', message: string, extra: any[] = []) => {
      const row = legacy(option('v-x', 'Plain', 'SIZE'), ...extra);
      const h = productsHarness([row]);
      setup(h);
      const before = JSON.stringify(h.db.t('productVariant'));
      await expect(h.variants.setKinds(P, { changes: [{ variantId: id, kind }, { variantId: 'v-x', kind: 'COLOUR' }] })).rejects.toThrow(message);
      expect(JSON.stringify(h.db.t('productVariant'))).toBe(before);
    };

    it('blocked (409, nothing written): a size with own components', () =>
      blocked(() => undefined, OPT.large, 'COLOUR', '"Large" can\'t become a colour: it has its own components.'));
    it('blocked: a size with own tiers', () =>
      blocked((h) => h.db.insert('variantPriceTier', { variantId: 'v-t', minQty: 10, unitPrice: 1 }), 'v-t', 'COLOUR', '"Tiered" can\'t become a colour: it has its own bulk tiers.', [option('v-t', 'Tiered', 'SIZE')]));
    it('blocked: a size used by a line that already has a colour', () =>
      blocked((h) => addOrderLine(h.db, { productId: P, sizeOptionId: 'v-y', colourOptionId: 'v-c' }), 'v-y', 'COLOUR', 'it is used as a size with a colour on 1 orders, quotes or jobs.',
        [option('v-y', 'Yellow', 'SIZE'), option('v-c', 'Cyan', 'COLOUR')]));
    it('blocked: a colour with assignments', () =>
      blocked(() => undefined, 'v-c', 'SIZE', '"Cyan" can\'t become a size: it has filament assignments — clear them first.', [option('v-c', 'Cyan', 'COLOUR', { colourAssignments: [assign(SLOT.tin, M.red)] })]));
    it('blocked: a colour referenced by a ProductionJob.colourOptionId', () =>
      blocked((h) => addJob(h.db, { colourOptionId: 'v-c' }), 'v-c', 'SIZE', 'it is used as a colour on 1 orders, quotes or jobs made since the update.', [option('v-c', 'Cyan', 'COLOUR')]));

    it('a size referenced only by a legacy OrderItem.variantId is not blocked', async () => {
      const h = productsHarness([legacy(option('v-r', 'Red', 'SIZE'))]);
      addOrderLine(h.db, { productId: P, variantId: 'v-r' });
      await expect(h.variants.setKinds(P, { changes: [{ variantId: 'v-r', kind: 'COLOUR' }] })).resolves.toBeDefined();
    });

    it('rewrites order, quote and job rows that use it as a size with no colour; prices unchanged', async () => {
      const h = productsHarness([legacy(option('v-r', 'Red', 'SIZE', { basePrice: 1.1 }))]);
      h.db.insert('colourSizeExclusion', { variantId: 'v-other', sizeKey: 'v-r' });
      const o = addOrderLine(h.db, { productId: P, sizeOptionId: 'v-r', variantId: 'v-r', unitPrice: 2.5, tierMinQty: 25 });
      const q = addQuoteLine(h.db, { productId: P, sizeOptionId: 'v-r', unitPrice: 2.5 });
      const j = addJob(h.db, { productId: P, sizeOptionId: 'v-r', variantId: 'v-r' });
      const out = await h.variants.setKinds(P, { changes: [{ variantId: 'v-r', kind: 'COLOUR' }] });
      expect(out.rewritten).toEqual({ orderLines: 1, quoteLines: 1, jobs: 1 });
      const find = (t: string, id: string) => h.db.t(t).find((r: any) => r.id === id);
      expect(find('orderItem', o.id)).toMatchObject({ sizeOptionId: null, colourOptionId: 'v-r', variantId: 'v-r', unitPrice: 2.5, tierMinQty: 25 });
      expect(find('quoteItem', q.id)).toMatchObject({ sizeOptionId: null, colourOptionId: 'v-r', unitPrice: 2.5 });
      expect(find('productionJob', j.id)).toMatchObject({ sizeOptionId: null, colourOptionId: 'v-r', variantId: 'v-r' });
      expect(out.warnings.find((w) => w.code === 'LINES_RECLASSIFIED')!.message).toBe('"Red" was on 3 orders, quotes or jobs as a size — they now read as colour "Red"');
      expect(out.warnings.find((w) => w.code === 'LEGACY_PRICE_IGNORED')!.message).toBe('"Red" had its own price 1.100 — colours use their size\'s price (1.500)');
      expect(h.db.t('colourSizeExclusion')).toHaveLength(0);
    });

    it('already that kind → 400; another product\'s option → 404; COLOUR target without components → 400', async () => {
      const h = productsHarness([sardineRow(), boxRow()]);
      await expect(h.variants.setKinds(P, { changes: [{ variantId: OPT.red, kind: 'COLOUR' }] })).rejects.toThrow('"Red" is already a colour');
      expect(await statusOf(h.variants.setKinds(BOX_ID, { changes: [{ variantId: OPT.large, kind: 'COLOUR' }] }))).toBe(404);
      const empty = boxWith(option('v-r', 'Red', 'SIZE'));
      empty.components = [];
      const h2 = productsHarness([empty]);
      await expect(h2.variants.setKinds(BOX_ID, { changes: [{ variantId: 'v-r', kind: 'COLOUR' }] })).rejects.toThrow("Add the product's components before adding colours");
    });
  });

  describe('O7 keep-selling step (§7.1 item 41)', () => {
    const keyring = () => boxWith(option('v-small', 'Small', 'SIZE', { basePrice: 0.8 }), option('v-red', 'Red', 'SIZE', { basePrice: 1.1, sortOrder: 1 }));

    it('"Keyring": without keepStandard → 400 and nothing written; with it → labels written and P4 offers Small in Black', async () => {
      const h = productsHarness([keyring()]);
      await expect(h.variants.setKinds(BOX_ID, { changes: [{ variantId: 'v-red', kind: 'COLOUR' }] })).rejects.toThrow('Choose whether customers keep buying "Box" as sliced');
      expect(h.db.t('productVariant').find((v: any) => v.id === 'v-red').kind).toBe('SIZE');
      await h.variants.setKinds(BOX_ID, { changes: [{ variantId: 'v-red', kind: 'COLOUR' }], keepStandard: { colour: { label: 'Black', sellInShop: true } } });
      expect(h.db.t('product')[0]).toMatchObject({ standardColourLabel: 'Black', standardColourSellable: true });
      const d = await h.products.catalogDetail(BOX_ID);
      expect(d.sizes.map((s) => s.label)).toEqual(['Small']);
      expect(d.colours).toEqual([{ colourOptionId: null, label: 'Black', swatches: ['#111111'], sizeOptionIds: ['v-small'] }]);
    });

    it('"Tag": both options → COLOUR, not sold as sliced → P4 lists the standard size and no colours', async () => {
      const h = productsHarness([boxWith(option('v-red', 'Red', 'SIZE', { basePrice: 1.1 }), option('v-blue', 'Blue', 'SIZE', { basePrice: 1.1 }))]);
      await h.variants.setKinds(BOX_ID, { changes: [{ variantId: 'v-red', kind: 'COLOUR' }, { variantId: 'v-blue', kind: 'COLOUR' }], keepStandard: { colour: { label: 'Black', sellInShop: false } } });
      const d = await h.products.catalogDetail(BOX_ID);
      expect(d.sizes.map((s) => [s.sizeOptionId, s.price])).toEqual([[null, 0.93]]);
      expect(d.colours).toEqual([]);
    });

    it('keepStandard.colour when the product already has a colour → 400', async () => {
      const h = productsHarness([boxWith(option('v-red', 'Red', 'SIZE'), option('v-blue', 'Blue', 'COLOUR'))]);
      await expect(h.variants.setKinds(BOX_ID, { changes: [{ variantId: 'v-red', kind: 'COLOUR' }], keepStandard: { colour: { label: 'Black', sellInShop: true } } }))
        .rejects.toThrow("keepStandard isn't needed for colours");
    });

    it('keepStandard.size is required when COLOUR → SIZE creates the first size, and it is written', async () => {
      const row = boxWith(option('v-big', 'Big', 'COLOUR'));
      row.standardColourSellable = true;
      const h = productsHarness([row]);
      await expect(h.variants.setKinds(BOX_ID, { changes: [{ variantId: 'v-big', kind: 'SIZE' }] })).rejects.toThrow('Choose whether customers keep buying "Box" in its standard size');
      await h.variants.setKinds(BOX_ID, { changes: [{ variantId: 'v-big', kind: 'SIZE' }], keepStandard: { size: { label: 'Regular', sellInShop: true } } });
      expect(h.db.t('product')[0]).toMatchObject({ baseOptionLabel: 'Regular', baseOptionSellable: true });
    });

    it('conditions are read inside the lock: an O1 colour committed first → no keepStandard needed', async () => {
      const setup = () => {
        const h = productsHarness([keyring()]);
        const raw = h.db.$queryRaw.getMockImplementation()!;
        let done = false;
        h.db.$queryRaw.mockImplementation(async (q: any) => {
          if (!done && /lock:ProductVariant:UPDATE/.test(q.sql)) {
            done = true;
            h.db.insert('productVariant', option('v-new', 'Green', 'COLOUR', { productId: BOX_ID }));
          }
          return raw(q);
        });
        return h;
      };
      await expect(setup().variants.setKinds(BOX_ID, { changes: [{ variantId: 'v-red', kind: 'COLOUR' }] })).resolves.toBeDefined();
      await expect(setup().variants.setKinds(BOX_ID, { changes: [{ variantId: 'v-red', kind: 'COLOUR' }], keepStandard: { colour: { label: 'Black', sellInShop: true } } }))
        .rejects.toThrow("keepStandard isn't needed for colours");
    });
  });

  describe('O5 assignments', () => {
    it('a size → 400; a slot of another product → 400; an unknown material → 404', async () => {
      const h = productsHarness([sardineRow(), boxRow()]);
      await expect(h.variants.setAssignments(P, OPT.large, { slots: [] })).rejects.toThrow('Only colours assign filaments — sizes have their own components');
      await expect(h.variants.setAssignments(P, OPT.red, { slots: [{ colourSlotId: 'slot-body', materialId: M.red }] })).rejects.toThrow('Unknown colour slot');
      expect(await statusOf(h.variants.setAssignments(P, OPT.red, { slots: [{ colourSlotId: SLOT.tin, materialId: 'm-nope' }] }))).toBe(404);
    });

    it('null removes a row; an assignment equal to a component\'s own material is stored; type change warns', async () => {
      const h = productsHarness([sardineRow()]);
      h.db.insert('material', { id: 'm-petg', name: 'PETG Red', type: 'PETG', color: 'Red', colorHex: '#FF0000', brand: null, costPerGram: 0.02 });
      const out: any = await h.variants.setAssignments(P, OPT.red, { slots: [{ colourSlotId: SLOT.tin, materialId: M.black }, { colourSlotId: SLOT.band, materialId: null }, { colourSlotId: SLOT.trim, materialId: 'm-petg' }] });
      const rows = h.db.t('colourOptionSlot').filter((r: any) => r.variantId === OPT.red);
      expect(rows.map((r: any) => [r.colourSlotId, r.materialId]).sort()).toEqual([[SLOT.tin, M.black], [SLOT.trim, 'm-petg']].sort());
      expect(out.warnings.filter((w: any) => w.code === 'MATERIAL_TYPE_DIFFERS').map((w: any) => w.message)).toEqual(['Different plastic from the file (PLA → PETG)']);
      expect(h.db.locks).toContainEqual({ table: 'ProductVariant', mode: 'SHARE', ids: [OPT.red] });
    });

    it('excludedSizeKeys (§7.1 item 35): one row per key; every active size → 400; unknown → 400; O4 of the size deletes them', async () => {
      const h = productsHarness([sardineRow()]);
      await h.variants.setAssignments(P, OPT.red, { slots: [{ colourSlotId: SLOT.tin, materialId: M.red }], excludedSizeKeys: [OPT.large] });
      expect(h.db.t('colourSizeExclusion').map((e: any) => [e.variantId, e.sizeKey])).toEqual([[OPT.red, OPT.large]]);
      await expect(h.variants.setAssignments(P, OPT.red, { slots: [], excludedSizeKeys: ['standard', OPT.large] })).rejects.toThrow('"Red" must be made in at least one size');
      await expect(h.variants.setAssignments(P, OPT.red, { slots: [], excludedSizeKeys: ['v-nope'] })).rejects.toThrow('Unknown size');
      const mini = await h.variants.create(P, { name: 'Mini', kind: 'SIZE' });
      await h.variants.setAssignments(P, OPT.blue, { slots: [{ colourSlotId: SLOT.tin, materialId: M.blue }], excludedSizeKeys: [mini.id] });
      await h.variants.remove(P, mini.id);
      expect(h.db.t('colourSizeExclusion').map((e: any) => e.sizeKey)).toEqual([OPT.large]);
    });

    it('open-line impact (§7.1 item 35): no confirm → 400, nothing written; dryRun → impact; confirm → written with OPEN_LINES_AFFECTED', async () => {
      const h = productsHarness([sardineRow()]);
      h.db.insert('material', fixtureMaterial(M.crimson));
      addOrderLine(h.db, { productId: P, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 30, description: 'Sardine tin — Large — Red' });
      const body = { slots: [{ colourSlotId: SLOT.tin, materialId: M.crimson }, { colourSlotId: SLOT.band, materialId: M.gold }] };
      const before = JSON.stringify(h.db.t('colourOptionSlot'));
      const dry: any = await h.variants.setAssignments(P, OPT.red, body, true);
      expect(dry.impact).toHaveLength(1);
      expect(dry.impact[0]).toMatchObject({ kind: 'ORDER', quantity: 30, changes: ['Tin: PLA Red → PLA Crimson on Large Box, Large Lid'] });
      await expect(h.variants.setAssignments(P, OPT.red, body)).rejects.toThrow('This change affects 1 open order or quote lines — review them and confirm');
      expect(JSON.stringify(h.db.t('colourOptionSlot'))).toBe(before);
      const out: any = await h.variants.setAssignments(P, OPT.red, { ...body, confirm: true });
      expect(out.warnings.map((w: any) => w.code)).toContain('OPEN_LINES_AFFECTED');
      expect(h.db.t('colourOptionSlot').find((r: any) => r.variantId === OPT.red && r.colourSlotId === SLOT.tin).materialId).toBe(M.crimson);
    });
  });

  describe('O5 vs O7 and O4 (§7.1 item 33)', () => {
    it('O5 first → O7 409 (assignments); O7 first → O5 400', async () => {
      const h = productsHarness([legacy(option('v-c', 'Cyan', 'COLOUR'))]);
      await h.variants.setAssignments(P, 'v-c', { slots: [{ colourSlotId: SLOT.tin, materialId: M.silver }] });
      await expect(h.variants.setKinds(P, { changes: [{ variantId: 'v-c', kind: 'SIZE' }] })).rejects.toThrow('it has filament assignments');
      const h2 = productsHarness([legacy(option('v-c', 'Cyan', 'COLOUR'))]);
      await h2.variants.setKinds(P, { changes: [{ variantId: 'v-c', kind: 'SIZE' }] });
      await expect(h2.variants.setAssignments(P, 'v-c', { slots: [] })).rejects.toThrow('Only colours assign filaments — sizes have their own components');
    });

    it('O5 re-reads the kind under FOR SHARE: a kind change between check and write → 400', async () => {
      const h = productsHarness([sardineRow()]);
      const raw = h.db.$queryRaw.getMockImplementation()!;
      h.db.$queryRaw.mockImplementation(async (q: any) => {
        if (/lock:ProductVariant:SHARE/.test(q.sql)) h.db.t('productVariant').find((v: any) => v.id === OPT.blue).kind = 'SIZE';
        return raw(q);
      });
      await expect(h.variants.setAssignments(P, OPT.blue, { slots: [] })).rejects.toThrow('Only colours assign filaments');
    });

    it('O4 of a colour that (by a hand-written row) owns a component with a movement → 409', async () => {
      const row = sardineRow();
      row.components.push({ ...row.components[0], id: 'c-odd', variantId: OPT.red, materials: [], plateLayouts: [], colourStock: [] });
      const h = productsHarness([row]);
      h.db.insert('componentStockMovement', { componentId: 'c-odd', colourKey: `0:${M.black}`, baseColumn: true, delta: 1, balanceAfter: 1, reason: 'MANUAL_ADJUST' });
      await expect(h.variants.remove(P, OPT.red)).rejects.toThrow('"Red" has printed stock records — deactivate it instead');
    });
  });

  describe('O4 delete', () => {
    it.each([
      ['an order line by variantId', (h: any) => addOrderLine(h.db, { variantId: OPT.blue })],
      ['an order line by sizeOptionId', (h: any) => addOrderLine(h.db, { sizeOptionId: OPT.blue })],
      ['an order line by colourOptionId', (h: any) => addOrderLine(h.db, { colourOptionId: OPT.blue })],
      ['a quote line by sizeOptionId', (h: any) => addQuoteLine(h.db, { sizeOptionId: OPT.blue })],
      ['a quote line by colourOptionId', (h: any) => addQuoteLine(h.db, { colourOptionId: OPT.blue })],
      ['a job by variantId', (h: any) => addJob(h.db, { variantId: OPT.blue })],
      ['a job by sizeOptionId', (h: any) => addJob(h.db, { sizeOptionId: OPT.blue })],
      ['a job by colourOptionId', (h: any) => addJob(h.db, { colourOptionId: OPT.blue })],
    ])('history through %s → 409', async (_name, seed) => {
      const h = productsHarness([sardineRow()]);
      seed(h);
      await expect(h.variants.remove(P, OPT.blue)).rejects.toThrow('"Blue" has been ordered, quoted or produced — deactivate it instead');
      expect(h.db.t('productVariant').some((v: any) => v.id === OPT.blue)).toBe(true);
    });

    it('a size whose component has stock or movements → 409', async () => {
      const h = productsHarness([sardineRow()]);
      h.db.t('productComponent').find((c: any) => c.id === 'c9').stockOnHand = 2;
      await expect(h.variants.remove(P, OPT.large)).rejects.toThrow('"Large" has printed stock records — deactivate it instead');
    });

    it('a colour without history → deleted with its assignments, no stock change', async () => {
      const h = productsHarness([sardineRow()]);
      h.db.t('productComponent').find((c: any) => c.id === 'c1').stockOnHand = 7;
      await h.variants.remove(P, OPT.blue);
      expect(h.db.t('productVariant').some((v: any) => v.id === OPT.blue)).toBe(false);
      expect(h.db.t('colourOptionSlot').some((r: any) => r.variantId === OPT.blue)).toBe(false);
      expect(h.db.t('productComponent').find((c: any) => c.id === 'c1').stockOnHand).toBe(7);
      expect(h.db.t('componentStockMovement')).toHaveLength(0);
    });

    it("a size without history → its components go, and their unreferenced files are unlinked after commit", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-var-'));
      const old = process.env.UPLOAD_DIR;
      process.env.UPLOAD_DIR = tmp;
      try {
        const h = productsHarness([sardineRow()]);
        fs.writeFileSync(path.join(tmp, 'lbox.gcode'), 'g');
        fs.writeFileSync(path.join(tmp, 'shared.gcode'), 'g');
        const own = h.db.insert('attachment', { entityType: 'product', entityId: P, storagePath: 'lbox.gcode', filename: 'lbox.gcode', originalName: 'lbox.gcode', sizeBytes: 1 });
        const shared = h.db.insert('attachment', { entityType: 'product', entityId: P, storagePath: 'shared.gcode', filename: 'shared.gcode', originalName: 'shared.gcode', sizeBytes: 1 });
        h.db.t('productComponent').find((c: any) => c.id === 'c6').attachmentId = own.id;
        h.db.t('plateLayout').find((l: any) => l.id === 'l7').attachmentId = shared.id;
        const j = addJob(h.db, { status: 'DONE' });
        h.db.insert('jobPlate', { jobId: j.id, componentId: null, attachmentId: shared.id });
        await h.variants.remove(P, OPT.large);
        expect(h.db.t('productComponent').filter((c: any) => c.variantId === OPT.large)).toHaveLength(0);
        expect(h.db.t('attachment').map((a: any) => a.id)).toEqual([shared.id]);
        expect(fs.existsSync(path.join(tmp, 'lbox.gcode'))).toBe(false);
        expect(fs.existsSync(path.join(tmp, 'shared.gcode'))).toBe(true);
      } finally {
        process.env.UPLOAD_DIR = old;
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it('O3 history counts every option column; O6 colour returns its cells without applying a price', async () => {
    const h = productsHarness([sardineRow()]);
    addQuoteLine(h.db, { colourOptionId: OPT.red });
    expect(await h.variants.history(P, OPT.red)).toEqual({ orderLines: 0, quoteLines: 1, jobs: 0, stockRecords: 0, canDelete: false });
    const spy = jest.spyOn(h.pricing, 'recalcPricing');
    const cells: any = await h.variants.calculate(P, OPT.red);
    expect(cells.map((c: any) => c.sizeOptionId)).toEqual([null, OPT.large]);
    expect(spy).not.toHaveBeenCalled();
    const size: any = await h.variants.calculate(P, OPT.large);
    expect(size.applied).toHaveLength(1);
    expect(size.sizeOptionId).toBe(OPT.large);
  });
});
