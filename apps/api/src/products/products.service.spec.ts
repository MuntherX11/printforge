import { ConflictException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CellCost } from '@printforge/types';
import { boxRow, BOX_ID } from '../catalog-core/__fixtures__/box-product';
import { fixtureMaterial, M, OPT, PRODUCT_ID, sardineRow, SLOT } from '../catalog-core/__fixtures__/sardine-tin';
import { colourCostWarnings } from '../catalog-core/pricing-core';
import { addJob, addOrderLine, productsHarness, statusOf } from './__fixtures__/products-harness';

const P = PRODUCT_ID;
const colour = (id: string, name: string, assignments: Array<[string, string]>, extra: Record<string, unknown> = {}) => ({
  id, productId: P, name, sku: null, kind: 'COLOUR', isActive: true, sortOrder: 5, basePrice: null, estimatedGrams: null, estimatedMinutes: null,
  createdAt: new Date(0), colourAssignments: assignments.map(([s, m]) => ({ colourSlotId: s, materialId: m, material: fixtureMaterial(m) })), sizeExclusions: [], ...extra,
});

describe('ProductsService (§7.1 items 13, 29, 42)', () => {
  describe('P6 update', () => {
    it('ignores basePrice, imageUrl, estimated* and unknown keys', async () => {
      const h = productsHarness([sardineRow()]);
      await h.products.update(P, { name: 'Tin', basePrice: 9, imageUrl: '../../etc', estimatedGrams: 1, estimatedMinutes: 2, foo: 'x' });
      const row = h.db.t('product')[0];
      expect(row).toMatchObject({ name: 'Tin', basePrice: 1.5, imageUrl: null, estimatedGrams: 0, estimatedMinutes: 0 });
      expect(row.foo).toBeUndefined();
    });

    it("stores '' as null", async () => {
      const h = productsHarness([{ ...sardineRow(), description: 'x', sku: 'TIN' }]);
      await h.products.update(P, { description: '', sku: '' });
      expect(h.db.t('product')[0]).toMatchObject({ description: null, sku: null });
    });

    it('a SKU used by an option → 409 naming it', async () => {
      const row = sardineRow();
      row.variants[0].sku = 'TIN-L';
      const h = productsHarness([row]);
      await expect(h.products.update(P, { sku: 'TIN-L' })).rejects.toThrow(ConflictException);
      await expect(h.products.update(P, { sku: 'TIN-L' })).rejects.toThrow('SKU "TIN-L" is already used by "Sardine tin — Large"');
    });

    it('reprices only when the printer or colour changes change', async () => {
      const h = productsHarness([sardineRow()]);
      const spy = jest.spyOn(h.pricing, 'recalcPricing');
      await h.products.update(P, { name: 'Tin 2', baseOptionSellable: true });
      expect(spy).not.toHaveBeenCalled();
      await h.products.update(P, { colorChanges: 3 });
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('P7/P8 history and delete (§3.10)', () => {
    let tmp: string;
    const oldDir = process.env.UPLOAD_DIR;
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-prod-'));
      process.env.UPLOAD_DIR = tmp;
    });
    afterEach(() => {
      process.env.UPLOAD_DIR = oldDir;
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('with history → 409 with the counts, nothing deleted', async () => {
      const h = productsHarness([sardineRow()]);
      addOrderLine(h.db, { productId: P });
      addOrderLine(h.db, { colourOptionId: OPT.red });
      await expect(h.products.remove(P)).rejects.toThrow('"Sardine tin" has 2 order lines, 0 quote lines and 0 jobs — deactivate it instead');
      expect(h.db.t('product')).toHaveLength(1);
    });

    it('counts a job linked only by componentId and one linked only by a JobPlate', async () => {
      const h = productsHarness([sardineRow()]);
      addJob(h.db, { componentId: 'c6' });
      const j = addJob(h.db, {});
      h.db.insert('jobPlate', { jobId: j.id, componentId: 'c2', attachmentId: null });
      expect(await h.products.history(P)).toEqual({ orderLines: 0, quoteLines: 0, jobs: 2, canDelete: false });
    });

    it('without history → deletes the product and its files, attachments too', async () => {
      const h = productsHarness([sardineRow()]);
      const key = 'a'.repeat(32) + '.png';
      fs.mkdirSync(path.join(tmp, 'product-images'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'product-images', key), 'img');
      fs.writeFileSync(path.join(tmp, 'file.gcode'), 'g');
      h.db.insert('productImage', { productId: P, storageKey: key, sortOrder: 0 });
      h.db.insert('attachment', { entityType: 'product', entityId: P, storagePath: 'file.gcode', filename: 'file.gcode', originalName: 'file.gcode', sizeBytes: 1 });
      expect(await h.products.remove(P)).toEqual({ deleted: true });
      expect(h.db.t('product')).toHaveLength(0);
      expect(h.db.t('productComponent')).toHaveLength(0);
      expect(h.db.t('productVariant')).toHaveLength(0);
      expect(h.db.t('attachment')).toHaveLength(0);
      expect(fs.existsSync(path.join(tmp, 'product-images', key))).toBe(false);
      expect(fs.existsSync(path.join(tmp, 'file.gcode'))).toBe(false);
    });

    it('re-counts inside the row lock: a line inserted after the P7 check → 409', async () => {
      const h = productsHarness([sardineRow()]);
      expect((await h.products.history(P)).canDelete).toBe(true);
      const raw = h.db.$queryRaw.getMockImplementation()!;
      h.db.$queryRaw.mockImplementation(async (q: any) => {
        if (/lock:Product:UPDATE/.test(q.sql)) addOrderLine(h.db, { productId: P });
        return raw(q);
      });
      await expect(h.products.remove(P)).rejects.toThrow('has 1 order lines');
      expect(h.db.t('product')).toHaveLength(1);
      expect(h.db.locks.some((l: any) => l.table === 'Product' && l.mode === 'UPDATE')).toBe(true);
    });
  });

  describe('components (P9–P15)', () => {
    it('P9 bounds and material: −12 g → 400; unknown material → 404', async () => {
      const h = productsHarness([sardineRow()]);
      expect(await statusOf(h.components.add(P, { description: 'Clip', materialId: M.black, gramsUsed: -12 }))).toBe(400);
      expect(await statusOf(h.components.add(P, { description: 'Clip', gramsUsed: 2 }))).toBe(400);
      expect(await statusOf(h.components.add(P, { description: 'Clip', materialId: 'm-nope', gramsUsed: 2 }))).toBe(404);
    });

    it('P9 on a size: sortOrder max+1 in the size, confirmed stock, size row read FOR SHARE', async () => {
      const h = productsHarness([sardineRow()]);
      const c = await h.components.add(P, { description: 'Large Clip', materialId: M.black, gramsUsed: 2, printMinutes: 5, sizeOptionId: OPT.large });
      expect(c).toMatchObject({ variantId: OPT.large, sortOrder: 4, stockConfirmed: true });
      expect(h.db.locks).toContainEqual({ table: 'ProductVariant', mode: 'SHARE', ids: [OPT.large] });
    });

    it('P9 with a colour id as sizeOptionId → 400', async () => {
      const h = productsHarness([sardineRow()]);
      await expect(h.components.add(P, { description: 'Clip', materialId: M.black, gramsUsed: 2, sizeOptionId: OPT.red }))
        .rejects.toThrow("Colours use each size's components — add the component to a size");
    });

    it('ownership: a component of product B via product A → 404 on P10, P11, P13 and P15', async () => {
      const h = productsHarness([sardineRow(), boxRow()]);
      expect(await statusOf(h.components.update(P, 'box', { description: 'x' }))).toBe(404);
      expect(await statusOf(h.components.setMaterials(P, 'box', { slots: [{ colorIndex: 0, materialId: M.red }] }))).toBe(404);
      expect(await statusOf(h.components.setStock(P, 'box', { stockOnHand: 1, expectedStockOnHand: 0 }))).toBe(404);
      h.db.t('productComponent').find((c: any) => c.id === 'box').thumbnailAttachmentId = 'att-1';
      expect(await statusOf(h.images.resolveComponentThumbnail(P, 'box'))).toBe(404);
      expect(await statusOf(h.components.remove(P, 'box'))).toBe(404);
    });

    it('P10 colourSlotId on a multicolour component → 400; a link-only P10 does not reprice', async () => {
      const h = productsHarness([sardineRow()]);
      await expect(h.components.update(P, 'c2', { colourSlotId: SLOT.tin })).rejects.toThrow('Link multicolour parts per colour');
      await expect(h.components.update(P, 'c2', { materialId: M.red })).rejects.toThrow('Use the colour slots editor for multicolour components');
      const spy = jest.spyOn(h.pricing, 'recalcPricing');
      const out: any = await h.components.update(P, 'c4', { colourSlotId: SLOT.band, description: 'Key 2' });
      expect(out).toMatchObject({ colourSlotId: SLOT.band, description: 'Key 2' });
      expect(spy).not.toHaveBeenCalled();
      await h.components.update(P, 'c4', { gramsUsed: 2 });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('P10 material change with base stock 5 → STOCK_REKEYED and the ledger rows', async () => {
      const h = productsHarness([sardineRow()]);
      h.db.t('productComponent').find((c: any) => c.id === 'c1').stockOnHand = 5;
      h.db.insert('material', fixtureMaterial(M.grey));
      const out: any = await h.components.update(P, 'c1', { materialId: M.grey });
      expect(out.warnings.map((w: any) => w.code)).toContain('STOCK_REKEYED');
      expect(out.warnings.find((w: any) => w.code === 'STOCK_REKEYED').message).toBe('5 printed units in the old colour kept as PLA Black');
      const moves = h.db.t('componentStockMovement');
      expect(moves.map((m: any) => [m.reason, m.colourKey, m.baseColumn, m.delta])).toEqual([
        ['FILAMENT_REKEY', `0:${M.black}`, true, -5],
        ['FILAMENT_REKEY', `0:${M.black}`, false, 5],
      ]);
      expect(h.db.t('productComponent').find((c: any) => c.id === 'c1')).toMatchObject({ materialId: M.grey, stockOnHand: 0 });
      expect(out.colourStock).toContainEqual(expect.objectContaining({ colourKey: `0:${M.black}`, stockOnHand: 5 }));
    });

    it('P13: stale expectedStockOnHand → 409; a same-value set on the base column confirms it', async () => {
      const h = productsHarness([sardineRow()]);
      const comp = h.db.t('productComponent').find((c: any) => c.id === 'c1');
      Object.assign(comp, { stockOnHand: 4, stockConfirmedAt: null });
      await expect(h.components.setStock(P, 'c1', { colourKey: null, stockOnHand: 10, expectedStockOnHand: 3 })).rejects.toThrow('Printed stock is now 4 — reload');
      const ok = await h.components.setStock(P, 'c1', { colourKey: `0:${M.black}`, stockOnHand: 4, expectedStockOnHand: 4, note: 'Stock is correct' });
      expect(ok.stockOnHand).toBe(4);
      expect(ok.movementId).toBeTruthy();
      expect(h.db.t('productComponent').find((c: any) => c.id === 'c1').stockConfirmedAt).not.toBeNull();
      await expect(h.components.setStock(P, 'c1', { colourKey: `0:${M.black}|1:${M.red}`, stockOnHand: 1, expectedStockOnHand: 0 })).rejects.toThrow('Unknown colour for "Box"');
    });

    it('P14: blocked by an open job → 409; by printed stock > 0 → 409', async () => {
      const h = productsHarness([sardineRow()]);
      const j = addJob(h.db, { status: 'IN_PROGRESS' });
      h.db.insert('jobPlate', { jobId: j.id, componentId: 'c4', attachmentId: null });
      await expect(h.components.remove(P, 'c4')).rejects.toThrow('"Key" is used by 1 open jobs — finish or cancel them first');
      h.db.insert('componentColourStock', { componentId: 'c5', colourKey: `0:${M.red}|1:${M.white}`, stockOnHand: 3 });
      await expect(h.components.remove(P, 'c5')).rejects.toThrow('"Band" has 3 printed units in stock — set its stock to 0 first');
      expect(h.db.t('productComponent')).toHaveLength(9);
    });

    it('last component removal keeps the price and flags it', async () => {
      const h = productsHarness([boxRow()]);
      await h.components.remove(BOX_ID, 'box');
      expect(h.db.t('product')[0].basePrice).toBe(0.93);
      const cost: any = await h.products.cost(BOX_ID);
      expect(cost.sizes[0]).toMatchObject({ complete: false, storedPrice: 0.93, computedPrice: null, priceUpToDate: false });
      expect(cost.sizes[0].problems.map((p: any) => p.code)).toContain('NO_COMPONENTS');
    });

    it('POST /calculate on a product without components does not change basePrice', async () => {
      const row = boxRow({ basePrice: 2 });
      row.components = [];
      const h = productsHarness([row]);
      const out: any = await h.products.calculate(BOX_ID);
      expect(h.db.t('product')[0].basePrice).toBe(2);
      expect(out.applied).toEqual([{ sizeOptionId: null, applied: false, price: null }]);
      expect(out.costVersion).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  describe('P19/P18/P20 stale tabs and kinds', () => {
    it('P19 variantId → 400 and the standard tiers are unchanged; a colour → 400', async () => {
      const row = sardineRow();
      (row as any).priceTiers = [{ id: 't1', minQty: 10, unitPrice: 1.2 }];
      const h = productsHarness([row]);
      await expect(h.products.setPriceTiers(P, { variantId: 'x', tiers: [] })).rejects.toThrow('This page is out of date — reload it');
      expect(h.db.t('priceTier')).toHaveLength(1);
      await expect(h.products.setPriceTiers(P, { sizeOptionId: OPT.red, tiers: [] })).rejects.toThrow("Colours share their size's tiers — set tiers on the size");
      const tiers = await h.products.setPriceTiers(P, { sizeOptionId: OPT.large, tiers: [{ minQty: 50, unitPrice: 2 }, { minQty: 25, unitPrice: 2.5 }] });
      expect(tiers.map((t: any) => t.minQty)).toEqual([25, 50]);
      expect(h.db.locks).toContainEqual({ table: 'ProductVariant', mode: 'SHARE', ids: [OPT.large] });
    });

    it('P18/P20 with a variantId parameter → 400', async () => {
      const h = productsHarness([sardineRow()]);
      await expect(h.products.bulkFloor(P, { variantId: 'x' })).rejects.toThrow('out of date');
      await expect(h.products.readiness(P, { variantId: 'x' })).rejects.toThrow('out of date');
    });

    it('P16 returns a costVersion, sizes and cells; a pair returns its breakdown', async () => {
      const h = productsHarness([sardineRow()]);
      const all: any = await h.products.cost(P);
      expect(all.sizes).toHaveLength(2);
      expect(all.cells).toHaveLength(6);
      const one: any = await h.products.cost(P, { sizeOptionId: 'standard', colourOptionId: OPT.red });
      expect(one.pair).toMatchObject({ sizeOptionId: null, colourOptionId: OPT.red, computedPrice: null });
      await expect(h.products.cost(P, { sizeOptionId: 'nope', colourOptionId: 'standard' })).rejects.toThrow('Size not found');
    });
  });

  describe('P3/P4 customer catalog (§3.1 rules 6–8, 10)', () => {
    const sizesOnly = () => {
      const row = sardineRow();
      row.variants = row.variants.filter((v: any) => v.kind === 'SIZE');
      row.baseOptionSellable = null;
      return row;
    };

    it('a product with sizes and baseOptionSellable null has no standard size; after P6 true it does', async () => {
      const h = productsHarness([sizesOnly()]);
      expect((await h.products.catalogDetail(P)).sizes.map((s) => s.sizeOptionId)).toEqual([OPT.large]);
      expect((await h.products.catalog())[0]).toMatchObject({ optionCount: 1, fromPrice: 2.8 });
      await h.products.update(P, { baseOptionSellable: true });
      expect((await h.products.catalogDetail(P)).sizes.map((s) => [s.sizeOptionId, s.label, s.price])).toEqual([[null, 'Regular', 1.5], [OPT.large, 'Large', 2.8]]);
      const grid = (await h.products.catalog())[0] as any;
      expect(grid).toMatchObject({ optionCount: 2, fromPrice: 1.5 });
      expect(grid.colourCount).toBeUndefined();
      expect(grid.imageUrl).toBeUndefined();
    });

    it('both axes: standardColourSellable null hides the standard colour; swatches carry no names', async () => {
      const row = sardineRow();
      row.standardColourSellable = null;
      const h = productsHarness([row]);
      const d = await h.products.catalogDetail(P);
      expect(d.hasSizes).toBe(true);
      expect(d.sizes.map((s) => s.sizeOptionId)).toEqual([null, OPT.large]);
      expect(d.colours.map((c) => c.colourOptionId)).toEqual([OPT.red, OPT.blue]);
      expect(d.colours[0]).toEqual({ colourOptionId: OPT.red, label: 'Red', swatches: ['#C4402A', '#D4AF37'], sizeOptionIds: [null, OPT.large] });
      await h.products.update(P, { standardColourSellable: true });
      const d2 = await h.products.catalogDetail(P);
      expect(d2.colours[0]).toMatchObject({ colourOptionId: null, label: 'Black' });
      expect(JSON.stringify(d2)).not.toMatch(/PLA|costPerGram|marginPct|imageUrl/);
    });

    it('hasSizes with one offered size; excluded and not-offered sizes omitted; a colour offered nowhere omitted', async () => {
      const row = sardineRow();
      row.baseOptionSellable = false;
      row.variants.find((v: any) => v.id === OPT.red).sizeExclusions = [{ sizeKey: OPT.large }];
      row.variants.push(colour('v-green', 'Green', []));
      const h = productsHarness([row]);
      const d = await h.products.catalogDetail(P);
      expect(d.hasSizes).toBe(true);
      expect(d.sizes.map((s) => s.sizeOptionId)).toEqual([OPT.large]);
      expect(d.colours.map((c) => c.colourOptionId)).toEqual([null, OPT.blue]);
      row.baseOptionSellable = true;
      const h2 = productsHarness([row]);
      const d2 = await h2.products.catalogDetail(P);
      expect(d2.colours.find((c) => c.colourOptionId === OPT.red)!.sizeOptionIds).toEqual([null]);
      expect(d2.colours.some((c) => c.colourOptionId === 'v-green')).toBe(false);
    });

    it('404 when inactive or no priced size', async () => {
      const row = sardineRow();
      row.isActive = false;
      const h = productsHarness([row]);
      expect(await statusOf(h.products.catalogDetail(P))).toBe(404);
    });
  });

  describe('ProductDetail and P2 fields (§7.1 item 42)', () => {
    it('COLOUR_COSTS_MORE: Red at +5.9 % → none; "Silk" at +29.0 % → the exact message', async () => {
      const red = productsHarness([boxRow({ withRed: true })]);
      expect((await red.products.findOne(BOX_ID)).warnings.filter((w) => w.code === 'COLOUR_COSTS_MORE')).toEqual([]);
      const silk = boxRow({ withRed: true });
      silk.variants[0] = { ...silk.variants[0], id: 'v-silk', name: 'Silk', colourAssignments: [{ colourSlotId: 'slot-body', materialId: M.gold, material: fixtureMaterial(M.gold) }] };
      const h = productsHarness([silk]);
      const w = (await h.products.findOne(BOX_ID)).warnings.filter((x) => x.code === 'COLOUR_COSTS_MORE');
      expect(w.map((x) => x.message)).toEqual(['"Silk" costs 29.0 % more than the standard colour on Standard (cost 0.480, price 0.930, margin 48.4 %)']);
      silk.variants[0].isActive = false;
      expect((await productsHarness([silk]).products.findOne(BOX_ID)).warnings.filter((x) => x.code === 'COLOUR_COSTS_MORE')).toEqual([]);
      silk.variants[0].isActive = true;
      silk.variants[0].sizeExclusions = [{ sizeKey: 'standard' }];
      expect((await productsHarness([silk]).products.findOne(BOX_ID)).warnings.filter((x) => x.code === 'COLOUR_COSTS_MORE')).toEqual([]);
    });

    it('the 10 % threshold is strict (injected cells); the standard colour never warns', () => {
      const cell = (delta: number, over: Partial<CellCost> = {}): CellCost => ({
        sizeOptionId: null, colourOptionId: 'c', sizeLabel: 'Standard', colourLabel: 'X', active: true, excluded: false, offeredToCustomers: true,
        complete: true, costPerUnit: 1, price: 2, marginPct: 50, deltaVsStandardPct: delta, problems: [], warnings: [], ...over,
      });
      expect(colourCostWarnings([cell(10.0)])).toEqual([]);
      expect(colourCostWarnings([cell(10.1)])).toHaveLength(1);
      expect(colourCostWarnings([cell(29, { excluded: true }), cell(29, { active: false }), cell(29, { colourOptionId: null })])).toEqual([]);
    });

    describe('P2 colours on the Sardine fixture with Green, Gold and an unlinked Large Lid colour 2', () => {
      const setup = (linkLargeLid = false) => {
        const row = sardineRow();
        row.variants.push(colour('v-green', 'Green', []));
        row.variants.push(colour('v-gold', 'Gold', [[SLOT.band, M.gold]], { sizeExclusions: [{ sizeKey: OPT.large }] }));
        const lid = row.components.find((c: any) => c.id === 'c7');
        if (!linkLargeLid) lid.materials[1] = { ...lid.materials[1], colourSlotId: null, colourFixed: null };
        return productsHarness([row]);
      };

      it('filamentNames, sizeKeys, customerSizeKeys and notSetUp', async () => {
        const h = setup();
        const [p]: any[] = await h.products.active();
        const by = (id: string) => p.colours.find((c: any) => c.id === id);
        expect(by(OPT.red)).toMatchObject({ filamentNames: ['PLA Red', 'PLA Gold'], sizeKeys: ['standard', OPT.large], customerSizeKeys: ['standard'], notSetUp: false });
        expect(by('v-gold')).toMatchObject({ sizeKeys: ['standard'], customerSizeKeys: ['standard'] });
        expect(by('v-green')).toMatchObject({ filamentNames: [], notSetUp: true, sizeKeys: ['standard', OPT.large], customerSizeKeys: [] });
        expect(p.standardColourLabelBySize).toBeNull();
        expect(p.sizes).toEqual([{ id: OPT.large, name: 'Large', sku: null, basePrice: 2.8, sortOrder: 0, sellableToCustomers: true }]);
        expect(p.variants.map((v: any) => v.kind)).toContain('COLOUR');
      });

      it("after the Large slot is linked, Red's customerSizeKeys include Large", async () => {
        const h = setup();
        await h.slots.saveLinks(P, { links: [{ componentId: 'c7', colorIndex: 1, colourSlotId: SLOT.trim }] }, false);
        const [p]: any[] = await h.products.active();
        expect(p.colours.find((c: any) => c.id === OPT.red).customerSizeKeys).toEqual(['standard', OPT.large]);
      });

      it('standardColourLabelBySize while mixed (Large Box re-sliced in PLA Grey)', async () => {
        const row = sardineRow();
        const box = row.components.find((c: any) => c.id === 'c6');
        box.materialId = M.grey;
        box.material = fixtureMaterial(M.grey);
        const [p]: any[] = await productsHarness([row]).products.active();
        // WP2's label lists every linked own filament of the size (Tin, Trim and Band), not only Tin's.
        expect(p.standardColourLabelBySize).toEqual({ standard: 'As sliced (PLA Black, PLA Silver)', [OPT.large]: 'As sliced (PLA Grey, PLA Black, PLA Silver)' });
        const d = await productsHarness([row]).products.findOne(P);
        expect(d.standardColourMixed).toBe(true);
        expect(d.standardColourSellableToCustomers).toBe(false);
        expect(d.warnings.map((w) => w.code)).toContain('SLOT_STANDARD_MIXED');
      });
    });

    it('ProductDetail: sizes, colours, slots, unlinked slots, kind-change blockers', async () => {
      const row = sardineRow();
      row.variants.push({ ...colour('v-old', 'Green', []), kind: 'SIZE', basePrice: 1.7 });
      row.components.find((c: any) => c.id === 'c1').colourSlotId = null;
      const h = productsHarness([row]);
      addOrderLine(h.db, { productId: P, sizeOptionId: OPT.large, colourOptionId: OPT.red });
      const d = await h.products.findOne(P);
      expect(d.components.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
      expect(d.unlinkedSlots).toEqual([{ componentId: 'c1', description: 'Box', colorIndex: 0 }]);
      const large = d.sizes.find((s) => s.id === OPT.large)!;
      expect(large.kindChange.allowed).toBe(false);
      expect(large.kindChange.blockers).toEqual([
        '"Large" can\'t become a colour: it has its own components.',
        '"Large" can\'t become a colour: it is used as a size with a colour on 1 orders, quotes or jobs.',
      ]);
      const old = d.sizes.find((s) => s.id === 'v-old')!;
      expect(old).toMatchObject({ notSetUp: true, likelyColour: true, kindChange: { allowed: true, blockers: [] } });
      const red = d.colours.find((c) => c.id === OPT.red)!;
      expect(red.kindChange.blockers).toEqual([
        '"Red" can\'t become a size: it has filament assignments — clear them first.',
        '"Red" can\'t become a size: it is used as a colour on 1 orders, quotes or jobs made since the update.',
      ]);
      expect(red.setup.warnings.map((w) => w.code)).toContain('COLOUR_SLOT_UNLINKED');
      expect(d.colourSlots.find((s) => s.id === SLOT.trim)!.links.map((l) => l.componentId).sort()).toEqual(['c2', 'c4', 'c7', 'c9']);
      expect(d.components[2].thumbnailUrl).toBeNull();
      expect(d.baseSellable).toBe(true);
    });
  });
});
