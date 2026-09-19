import PDFDocument from 'pdfkit';
import { BOX_ID, boxRow } from '../catalog-core/__fixtures__/box-product';
import { M, OPT, PRODUCT_ID, fixtureMaterial, key, sardineRow } from '../catalog-core/__fixtures__/sardine-tin';
import { PdfService } from '../invoices/pdf.service';
import { addJobRow, addOrder, addSpool, expectStatus } from '../production/__fixtures__/production-harness';
import { OpenLinesImpactService } from '../catalog-core/open-lines-impact.service';
import { PartsService } from '../parts/parts.service';
import { ProductsService } from '../products/products.service';
import { VariantsService } from '../products/variants.service';
import { CUSTOMER_ID, STAFF_ONLY_KEYS, addTier, allKeys, ordersHarness, setTaxRate, type OrdersHarness } from './__fixtures__/orders-harness';
import { previewPricingLines } from './pricing-preview.controller';

type H = OrdersHarness;

const P = PRODUCT_ID;
const items = (h: H, orderId: string) => h.db.t('orderItem').filter((i: any) => i.orderId === orderId);

/** Sardine tin with the §3.9 illustrative tiers: Regular 25 → 1.350, 50 → 1.200, 100 → 1.000; Large 25 → 2.500. */
function sardine(mutate?: (row: any) => void) {
  const row = sardineRow();
  mutate?.(row);
  const h = ordersHarness([row]);
  addTier(h, P, null, 25, 1.35);
  addTier(h, P, null, 50, 1.2);
  addTier(h, P, null, 100, 1.0);
  addTier(h, P, OPT.large, 25, 2.5);
  for (const m of [M.black, M.silver, M.white, M.orange, M.red, M.blue, M.gold]) addSpool(h.db, m, 5000, { id: `sp-${m}` });
  return h;
}

function box(opts: { basePrice?: number } = {}) {
  const h = ordersHarness([boxRow({ basePrice: opts.basePrice })]);
  addSpool(h.db, M.black, 5000, { id: 'sp-black' });
  return h;
}

const line = (l: Record<string, unknown>) => ({ description: '', quantity: 1, ...l });
const order = (h: H, lines: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  h.orders.create({ customerId: CUSTOMER_ID, items: lines.map(line), ...extra }) as Promise<any>;

// ------------------------------------------------------------------ S2 pricing

describe('S2 server pricing (§3.9, §7.1 item 19)', () => {
  it('ignores a client unitPrice without override: unitPrice 0 on a priced product stores the list price', async () => {
    const h = box();
    const o = await order(h, [{ productId: BOX_ID, quantity: 2, unitPrice: 0 }]);
    expect(o.items[0]).toMatchObject({ unitPrice: 0.93, totalPrice: 1.86, priceSource: 'BASE', listUnitPrice: 0.93, tierMinQty: null, priceOverrideReason: null });
    expect(o.total).toBe(1.86);
  });

  it('a manual override is recorded MANUAL with its reason, the list price and the tier that would have applied', async () => {
    const h = sardine();
    const o = await order(h, [{ productId: P, colourOptionId: OPT.red, quantity: 60, unitPrice: 1.1, priceOverride: true, overrideReason: '  Loyal customer  ' }]);
    expect(o.items[0]).toMatchObject({ unitPrice: 1.1, totalPrice: 66, priceSource: 'MANUAL', listUnitPrice: 1.5, tierMinQty: 50, priceOverrideReason: 'Loyal customer' });
  });

  it('3 × 1.350 = 4.050 exactly, with subtotal, tax and total rounded separately', async () => {
    const h = box({ basePrice: 1.35 });
    setTaxRate(h, '5');
    const o = await order(h, [{ productId: BOX_ID, quantity: 3 }]);
    expect(o.items[0].totalPrice).toBe(4.05);
    expect([o.subtotal, o.tax, o.total]).toEqual([4.05, 0.203, 4.253]);
  });

  it('tiers count all colour lines of one size together: Regular·Red 15 + Regular·Black 10 → both TIER 25 at 1.350', async () => {
    const h = sardine();
    const o = await order(h, [{ productId: P, colourOptionId: OPT.red, quantity: 15 }, { productId: P, quantity: 10 }]);
    const [red, black] = o.items;
    expect(red).toMatchObject({ priceSource: 'TIER', tierMinQty: 25, unitPrice: 1.35, totalPrice: 20.25, colourOptionId: OPT.red, sizeOptionId: null });
    expect(black).toMatchObject({ priceSource: 'TIER', tierMinQty: 25, unitPrice: 1.35, totalPrice: 13.5, colourOptionId: null });
  });

  it('different sizes never count together: Regular·Red 15 + Large·Red 15 → no tier (1.500 and 2.800)', async () => {
    const h = sardine();
    const o = await order(h, [{ productId: P, colourOptionId: OPT.red, quantity: 15 }, { productId: P, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 15 }]);
    expect(o.items.map((i: any) => [i.priceSource, i.unitPrice, i.tierMinQty])).toEqual([['BASE', 1.5, null], ['SIZE', 2.8, null]]);
  });

  it('Large·Red 20 + Large·Blue 5 + Regular·Red 30 → Large TIER 25 at 2.500, Regular TIER 25 at 1.350; an override line still counts', async () => {
    const h = sardine();
    const o = await order(h, [
      { productId: P, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 20 },
      { productId: P, sizeOptionId: OPT.large, colourOptionId: OPT.blue, quantity: 5 },
      { productId: P, colourOptionId: OPT.red, quantity: 30 },
    ]);
    expect(o.items.map((i: any) => [i.priceSource, i.unitPrice])).toEqual([['TIER', 2.5], ['TIER', 2.5], ['TIER', 1.35]]);

    const o2 = await order(h, [
      { productId: P, colourOptionId: OPT.red, quantity: 30, unitPrice: 1, priceOverride: true },
      { productId: P, quantity: 10 },
    ]);
    expect(o2.items.map((i: any) => [i.priceSource, i.unitPrice, i.tierMinQty])).toEqual([['MANUAL', 1, 25], ['TIER', 1.35, 25]]);
  });

  it('custom lines keep the client price and description and never count toward a tier', async () => {
    const h = sardine();
    const o = await order(h, [{ description: 'Custom <b>engraving</b>', quantity: 30, unitPrice: 0.5 }, { productId: P, quantity: 10 }]);
    expect(o.items[0]).toMatchObject({ productId: null, description: 'Custom engraving', unitPrice: 0.5, priceSource: 'MANUAL', listUnitPrice: null });
    expect(o.items[1]).toMatchObject({ priceSource: 'BASE', unitPrice: 1.5 });
  });

  it('records the pair, the variantId mirror and priceWarnings (never blocking)', async () => {
    const h = sardine();
    const o = await order(h, [{ productId: P, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 2, unitPrice: 0.01, priceOverride: true }]);
    expect(o.items[0]).toMatchObject({ sizeOptionId: OPT.large, colourOptionId: OPT.red, variantId: OPT.large });
    expect(o.priceWarnings).toEqual([{ line: 1, codes: ['BELOW_COST'] }]);
    const o2 = await order(h, [{ productId: P, colourOptionId: OPT.red, quantity: 1 }]);
    expect(o2.items[0].variantId).toBe(OPT.red);
  });

  it('quantity 0 and 2.5 → 400', async () => {
    const h = box();
    await expectStatus(order(h, [{ productId: BOX_ID, quantity: 0 }]), 400, 'Line 1: quantity must be a whole number from 1 to 100000');
    await expectStatus(order(h, [{ productId: BOX_ID, quantity: 2.5 }]), 400, 'quantity must be a whole number');
    expect(h.db.t('order')).toHaveLength(0);
  });

  it('pair validation: a size of another product, an inactive colour on a new line, a missing product → 400 and nothing written', async () => {
    const h = ordersHarness([sardineRow(), boxRow()]);
    await expectStatus(order(h, [{ productId: BOX_ID, sizeOptionId: OPT.large, quantity: 1 }]), 400, 'Line 1: that size belongs to another product');
    await expectStatus(order(h, [{ productId: BOX_ID, colourOptionId: OPT.red, quantity: 1 }]), 400, 'Line 1: that colour belongs to another product');
    h.db.t('productVariant').find((v: any) => v.id === OPT.blue).isActive = false;
    await expectStatus(order(h, [{ productId: P, colourOptionId: OPT.blue, quantity: 1 }]), 400, 'colour "Blue" is no longer available');
    await expectStatus(order(h, [{ productId: P, sizeOptionId: OPT.red, quantity: 1 }]), 400, '"Red" is a colour, not a size');
    await expectStatus(order(h, [{ productId: 'p-gone', quantity: 1 }]), 400, 'Line 1: product not found');
    await expectStatus(order(h, [{ productId: P, colourOptionId: 'v-gone', quantity: 1 }]), 400, 'Line 1: that size or colour no longer exists');
    await expectStatus(order(h, [{ colourOptionId: OPT.red, quantity: 1, unitPrice: 1, description: 'x' }]), 400, 'choose the product for this size or colour');
    expect(h.db.t('order')).toHaveLength(0);
  });

  it('takes FOR SHARE on the product and every option row before resolving', async () => {
    const h = sardine();
    await order(h, [{ productId: P, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 1 }]);
    expect(h.db.locks).toEqual([
      { table: 'Product', mode: 'SHARE', ids: [P] },
      { table: 'ProductVariant', mode: 'SHARE', ids: [OPT.large, OPT.red] },
    ]);
  });
});

// --------------------------------------------------------- descriptions (item 40)

describe('Line descriptions (§3.9 step 10, §7.1 item 40)', () => {
  it('S2 with a misleading client description stores the server label first; the invoice PDF and My orders show it', async () => {
    const h = sardine();
    const o = await order(h, [
      { productId: P, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 1, description: 'Sardine tin — Large — Blue, gift wrap' },
      { productId: P, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 1, description: 'Sardine tin — Large — Red — gift wrap' },
      { description: 'Custom stand', quantity: 1, unitPrice: 2 },
    ]);
    expect(o.items.map((i: any) => i.description)).toEqual([
      'Sardine tin — Large — Red — Sardine tin — Large — Blue, gift wrap',
      'Sardine tin — Large — Red — gift wrap',
      'Custom stand',
    ]);

    const texts: string[] = [];
    const spy = jest.spyOn(PDFDocument.prototype as any, 'text').mockImplementation(function (this: any, ...args: any[]) {
      texts.push(String(args[0]));
      return this;
    });
    try {
      const pdf = new PdfService(h.db as any);
      const buf = await pdf.generateInvoicePdf({ invoiceNumber: 'INV-1', createdAt: new Date(), subtotal: o.subtotal, tax: o.tax, total: o.total, paidAmount: 0, order: { ...o, customer: { name: 'Ali' } } });
      expect(buf.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
    expect(texts.some((t) => t.startsWith('Sardine tin — Large — Red'))).toBe(true);

    const mine: any[] = await h.orders.findForCustomer(CUSTOMER_ID);
    expect(mine[0].items[0].description.startsWith('Sardine tin — Large — Red')).toBe(true);
  });

  it('S5 ignores any client description key', async () => {
    const h = sardine();
    const o: any = await h.orders.createForCustomer(CUSTOMER_ID, { items: [{ productId: P, colourOptionId: OPT.red, quantity: 2, description: 'FREE' }] });
    expect(o.items[0].description).toBe('Sardine tin — Red');
  });
});

// -------------------------------------------------------------------- S5

describe('S5 customer orders (§3.9, §4.5, §7.1 item 19)', () => {
  it('maps the legacy { variantId }-only body (§3.1 rule 13) and charges the standard price, never a tier', async () => {
    const h = sardine();
    const o: any = await h.orders.createForCustomer(CUSTOMER_ID, { items: [{ variantId: OPT.large, quantity: 30 }] });
    const [stored] = items(h, o.id);
    expect(stored).toMatchObject({
      productId: P, sizeOptionId: OPT.large, colourOptionId: null, variantId: OPT.large,
      unitPrice: 2.8, listUnitPrice: 2.8, priceSource: 'SIZE', tierMinQty: null, description: 'Sardine tin — Large',
    });
    expect(o.total).toBe(84);
  });

  it('the response contains none of listUnitPrice, priceSource, tierMinQty, priceOverrideReason or customer', async () => {
    const h = sardine();
    const o: any = await h.orders.createForCustomer(CUSTOMER_ID, { items: [{ productId: P, colourOptionId: OPT.red, quantity: 1 }] });
    const keys = allKeys(o);
    for (const k of STAFF_ONLY_KEYS) expect(keys.has(k)).toBe(false);
    expect(Object.keys(o).sort()).toEqual(['createdAt', 'id', 'items', 'orderNumber', 'status', 'subtotal', 'tax', 'total']);
    expect(Object.keys(o.items[0]).sort()).toEqual(['description', 'quantity', 'totalPrice', 'unitPrice']);
    const mine: any[] = await h.orders.findForCustomer(CUSTOMER_ID);
    for (const k of STAFF_ONLY_KEYS) expect(allKeys(mine).has(k)).toBe(false);
  });

  it('a variant of an inactive product → 400; the standard size when not sold to customers → 400', async () => {
    const h = sardine((row) => { row.isActive = false; });
    await expectStatus(h.orders.createForCustomer(CUSTOMER_ID, { items: [{ variantId: OPT.large, quantity: 1 }] }), 400, 'is inactive');
    const h2 = sardine((row) => { row.baseOptionSellable = false; });
    await expectStatus(h2.orders.createForCustomer(CUSTOMER_ID, { items: [{ productId: P, quantity: 1 }] }), 400, 'choose a size');
    expect(h2.db.t('order')).toHaveLength(0);
  });

  it('bounds: 51 items or quantity 51 → 400; quantity 50 accepted', async () => {
    const h = sardine();
    const many = Array.from({ length: 51 }, () => ({ productId: P, quantity: 1 }));
    await expectStatus(h.orders.createForCustomer(CUSTOMER_ID, { items: many }), 400, 'at most 50 lines');
    await expectStatus(h.orders.createForCustomer(CUSTOMER_ID, { items: [{ productId: P, quantity: 51 }] }), 400, 'items[0].quantity');
    for (const q of [0, 2.5, NaN, Infinity, 'abc']) await expectStatus(h.orders.createForCustomer(CUSTOMER_ID, { items: [{ productId: P, quantity: q }] }), 400, 'items[0].quantity');
    await expect(h.orders.createForCustomer(CUSTOMER_ID, { items: [{ productId: P, quantity: 50 }] })).resolves.toBeDefined();
  });
});

// ------------------------------------------------------------- S4 and S3

describe('S4 print files and availability, S3 check-stock (§7.1 item 19)', () => {
  function withFiles() {
    const h = sardine((row) => {
      const c = (id: string) => row.components.find((x: any) => x.id === id);
      c('c1').attachmentId = 'att-c1';
      c('c6').attachmentId = 'att-c6';
      c('c6').plateLayouts[0].attachmentId = 'att-l6';
    });
    for (const [id, name] of [['att-c1', 'Box.gcode'], ['att-c6', 'Large Box.gcode'], ['att-l6', 'Large Box x4.gcode']]) {
      h.db.insert('attachment', { id, originalName: name, sizeBytes: 1234 });
    }
    return h;
  }

  it('print files are the size\'s component and layout files, with printIn per the line\'s colour', async () => {
    const h = withFiles();
    const { order: o } = addOrder(h.db, [{ productId: P, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 3, description: 'Sardine tin — Large — Red' }], 'PENDING');
    const view: any = await h.orders.findOne(o.id);
    expect(view.printFiles.map((f: any) => [f.component, f.kind, f.unitsPerPlate, f.filename, f.quantity])).toEqual([
      ['Large Box', 'COMPONENT', null, 'Large Box.gcode', 3],
      ['Large Box', 'PLATE_LAYOUT', 4, 'Large Box x4.gcode', 3],
    ]);
    expect(view.printFiles[0].printIn).toEqual([{ colorIndex: 0, materialLabel: 'PLA Red', slicedFor: 'PLA Black' }]);
    expect(view.printFiles[0].optionLabel).toBe('Large · Red');
    expect(view.items[0]).toMatchObject({ size: { id: OPT.large, name: 'Large' }, colour: { id: OPT.red, name: 'Red' }, optionLabel: 'Large · Red' });
  });

  it('availability includes multicolour slots and the colour option\'s materials', async () => {
    const h = sardine();
    const { order: o } = addOrder(h.db, [{ productId: P, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 1, description: 'x' }], 'PENDING');
    const view: any = await h.orders.findOne(o.id);
    const ids = view.materialAvailability.map((m: any) => m.materialId).sort();
    expect(ids).toEqual([M.orange, M.red, M.silver, M.white].sort());
    expect(ids).not.toContain(M.black);
  });

  it('a legacy line (variantId only) shows its option by current kind', async () => {
    const h = sardine();
    const { order: o } = addOrder(h.db, [{ productId: P, variantId: OPT.red, quantity: 1, description: 'Sardine tin — Red' }], 'PENDING');
    const view: any = await h.orders.findOne(o.id);
    expect(view.items[0]).toMatchObject({ size: null, colour: { id: OPT.red, name: 'Red' }, optionLabel: 'Regular · Red' });
  });

  it('check-stock with sizeOptionId/colourOptionId; an orphan line of another open order is skipped with a warning', async () => {
    const h = sardine();
    addOrder(h.db, [{ productId: 'p-gone', quantity: 5, description: 'Old thing' }], 'CONFIRMED');
    const out: any = await h.orders.checkStock({ items: [{ productId: P, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 30 }] });
    const red = out.materials.find((m: any) => m.materialId === M.red);
    expect(red.gramsNeeded).toBe(1071); // §3.6.1: 8 × 84.0 + 5 × 79.8 (check-stock takes nothing from printed stock)
    expect(out.warnings.map((w: any) => w.code)).toContain('LINE_PRODUCT_MISSING');
  });

  it('a line whose variantId belongs to another product is skipped with LINE_OPTION_MISMATCH in S3 and S4; the other lines are planned (§7.1 item 28)', async () => {
    const h = ordersHarness([sardineRow(), boxRow({ withRed: true })]);
    // A pre-release line of the Sardine tin pointing at the Box's "Red" option.
    const { order: bad } = addOrder(h.db, [
      { productId: P, variantId: 'v-box-red', quantity: 2, description: 'Sardine tin — Red' },
      { productId: P, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 1, description: 'Sardine tin — Large — Red' },
    ], 'CONFIRMED');

    const view: any = await h.orders.findOne(bad.id);
    expect(view.warnings.map((w: any) => w.code)).toContain('LINE_OPTION_MISMATCH');
    expect(view.printFiles.every((f: any) => f.orderItemId !== view.items[0].id)).toBe(true);
    expect(view.materialAvailability.map((m: any) => m.materialId)).toContain(M.red);

    const out: any = await h.orders.checkStock({ items: [{ productId: BOX_ID, quantity: 1 }] });
    expect(out.warnings.map((w: any) => w.code)).toContain('LINE_OPTION_MISMATCH');
    expect(out.materials.map((m: any) => m.materialId)).toEqual([M.black]);
  });

  it('S3 reserves the same figure as freeFilament for a line with jobs on old components (JOBS_ON_OLD_COMPONENTS, §7.1 item 31)', async () => {
    const h = box();
    const { order: o, items: [it] } = addOrder(h.db, [{ productId: BOX_ID, quantity: 24, description: 'Box' }], 'CONFIRMED');
    const j = addJobRow(h.db, { orderId: o.id, orderItemId: it.id, productId: BOX_ID, status: 'QUEUED', quantityToProduce: 24 });
    h.db.insert('jobPlate', {
      jobId: j.id, componentId: 'old-box', layoutId: null, colourKey: `0:${M.black}`, slots: [], label: 'Old box single',
      unitsPerPlate: 1, plateCount: 24, unitsRequired: 24, plateMinutes: 34, plateGrams: 9.4, attachmentId: null, gcodeFilename: null, sortOrder: 0,
    });
    h.db.insert('jobMaterial', { jobId: j.id, materialId: M.black, gramsUsed: 80, costPerGram: 0.01, colorIndex: 0, spoolId: null, slicedMaterialId: null });

    const free = await h.planner.freeFilament([M.black]);
    expect(free.materials.get(M.black)!.reserved).toBe(80);
    const out: any = await h.orders.checkStock({ items: [{ productId: BOX_ID, quantity: 1 }] });
    const black = out.materials.find((m: any) => m.materialId === M.black);
    expect(black.reservedStock).toBe(80);
    expect(out.warnings.map((w: any) => w.code)).toContain('JOBS_ON_OLD_COMPONENTS');
  });

  it('check-stock validates pairs and bounds (§4.7): 101 items, −1, 2.5, 100001, NaN, Infinity, a string → 400; 0 or missing skipped', async () => {
    const h = sardine();
    const many = Array.from({ length: 101 }, () => ({ productId: P, quantity: 1 }));
    await expectStatus(h.orders.checkStock({ items: many }), 400, 'Check at most 100 lines at a time');
    for (const q of [-1, 2.5, 100001, NaN, Infinity, 'abc']) {
      await expectStatus(h.orders.checkStock({ items: [{ productId: P, quantity: 1 }, { productId: P, quantity: q }] }), 400, 'items[1]: quantity must be a whole number from 1 to 100000');
    }
    const skipped: any = await h.orders.checkStock({ items: [{ productId: P, quantity: 0 }, { productId: P }, { productId: P, quantity: '' }] });
    expect(skipped).toEqual({ materials: [], shortages: [], ok: true, warnings: [] });
    await expect(h.orders.checkStock({ items: [{ productId: P, quantity: 100000 }] })).resolves.toBeDefined();
    await expectStatus(h.orders.checkStock({ items: [{ productId: P, sizeOptionId: OPT.red, quantity: 1 }] }), 400, 'items[0]: "Red" is a colour, not a size');
  });
});

// ---------------------------------------------------------------- bounds

describe('S2 bounds (§4.7, §7.1 item 37)', () => {
  it('101 items → 400; 100 accepted', async () => {
    const h = box();
    const mk = (n: number) => Array.from({ length: n }, () => ({ productId: BOX_ID, quantity: 1 }));
    await expectStatus(order(h, mk(101)), 400, 'at most 100 lines');
    await expect(order(h, mk(100))).resolves.toBeDefined();
    await expectStatus(order(h, []), 400, 'Add at least one line');
  });

  it('quantity 1 and 100000 accepted; 100001, NaN, Infinity, a string → 400', async () => {
    const h = box();
    await expect(order(h, [{ productId: BOX_ID, quantity: 1 }])).resolves.toBeDefined();
    await expect(order(h, [{ productId: BOX_ID, quantity: 100000 }])).resolves.toBeDefined();
    for (const q of [100001, NaN, Infinity, 'abc']) await expectStatus(order(h, [{ productId: BOX_ID, quantity: q }]), 400, 'quantity must be a whole number from 1 to 100000');
  });

  it('override unitPrice 0 and 1000000 accepted; −0.001, 1000001, NaN, a string → 400', async () => {
    const h = box();
    const ov = (unitPrice: unknown) => order(h, [{ productId: BOX_ID, quantity: 1, unitPrice, priceOverride: true }]);
    await expect(ov(0)).resolves.toBeDefined();
    await expect(ov(1000000)).resolves.toBeDefined();
    for (const p of [-0.001, 1000001, NaN, 'abc']) await expectStatus(ov(p), 400, 'price must be a number from 0 to 1000000');
  });
});

// ----------------------------------------------------------------- S9 cancel

describe('S9 cancel releases printed stock in the same transaction (§3.6, §7.1 item 19)', () => {
  it('PLAN_ALLOCATE −2 Box → CANCELLED → Box +2 and PLAN_RELEASE; a second cancel releases nothing', async () => {
    const h = box();
    const { order: o, items: [it] } = addOrder(h.db, [{ productId: BOX_ID, quantity: 3, description: 'Box' }], 'CONFIRMED');
    h.db.insert('componentStockMovement', { componentId: 'box', colourKey: key([0, M.black]), baseColumn: true, delta: -2, balanceAfter: 0, reason: 'PLAN_ALLOCATE', orderItemId: it.id });

    const view: any = await h.orders.findOne(o.id);
    expect(view.stockAllocations).toEqual([{ orderItemId: it.id, componentId: 'box', componentDescription: 'Box', colourLabel: 'PLA Black', units: 2 }]);

    const out: any = await h.orders.update(o.id, { status: 'CANCELLED' });
    expect(out.status).toBe('CANCELLED');
    expect(out.stockReleased).toEqual([{ componentDescription: 'Box', colourLabel: 'PLA Black', units: 2 }]);
    expect(h.db.t('productComponent').find((c: any) => c.id === 'box').stockOnHand).toBe(2);
    expect(h.db.t('componentStockMovement').filter((m: any) => m.reason === 'PLAN_RELEASE')).toHaveLength(1);

    const again: any = await h.orders.update(o.id, { status: 'CANCELLED' });
    expect(again.stockReleased).toEqual([]);
    expect(h.db.t('productComponent').find((c: any) => c.id === 'box').stockOnHand).toBe(2);
  });

  it('a release failure rolls the status change back', async () => {
    const h = box();
    const { order: o } = addOrder(h.db, [{ productId: BOX_ID, quantity: 3, description: 'Box' }], 'CONFIRMED');
    jest.spyOn(h.stock, 'releaseForOrder').mockRejectedValueOnce(new Error('db down'));
    await expect(h.orders.update(o.id, { status: 'CANCELLED' })).rejects.toThrow('db down');
    expect(h.db.t('order').find((x: any) => x.id === o.id).status).toBe('CONFIRMED');
  });
});

// ------------------------------------------------------------------ S11 order

describe('S11 order line colour change (§3.6.1, §3.9, §7.1 item 36)', () => {
  async function planned() {
    const h = sardine((row) => {
      row.components.find((c: any) => c.id === 'c6').colourStock = [{ colourKey: key([0, M.red]), stockOnHand: 2 }];
    });
    const { order: o, items: [it] } = addOrder(h.db, [{
      productId: P, sizeOptionId: OPT.large, colourOptionId: OPT.red, variantId: OPT.large, quantity: 30,
      unitPrice: 2.5, totalPrice: 75, listUnitPrice: 2.8, priceSource: 'TIER', tierMinQty: 25, description: 'Sardine tin — Large — Red',
    }], 'CONFIRMED');
    const plan = await h.planning.planWithSuggestions(o.id);
    expect(plan.jobsCreated).toBe(4);
    return { h, o, it };
  }
  const body = { colours: [{ colourOptionId: OPT.red, quantity: 20 }, { colourOptionId: OPT.blue, quantity: 10 }] };

  it('dry run lists 4 queued jobs and 2 Large Box (PLA Red) and writes nothing', async () => {
    const { h, o, it } = await planned();
    const before = JSON.stringify(h.db.tables());
    const dry: any = await h.orders.changeLineColour(o.id, it.id, body, true);
    expect(dry.dryRun).toBe(true);
    expect(dry.cancelledJobs).toHaveLength(4);
    expect(dry.stockReleased).toEqual([{ componentDescription: 'Large Box', colourLabel: 'PLA Red', units: 2 }]);
    expect(dry.lines.map((l: any) => [l.colourOptionId, l.quantity, l.totalPrice])).toEqual([[OPT.red, 20, 50], [OPT.blue, 10, 25]]);
    expect(JSON.stringify(h.db.tables())).toBe(before);
  });

  it('without confirm → 400 and nothing written', async () => {
    const { h, o, it } = await planned();
    const before = JSON.stringify(h.db.tables());
    await expectStatus(h.orders.changeLineColour(o.id, it.id, body), 400, 'Confirm the jobs and stock listed first');
    expect(JSON.stringify(h.db.tables())).toBe(before);
  });

  it('with confirm: 4 QUEUED jobs CANCELLED, PLAN_RELEASE +2 to (C6, "0:<Red>"), lines Red ×20 and Blue ×10 at the original unitPrice', async () => {
    const { h, o, it } = await planned();
    const out: any = await h.orders.changeLineColour(o.id, it.id, { ...body, confirm: true });
    expect(out.cancelledJobs).toHaveLength(4);
    expect(h.db.t('productionJob').filter((j: any) => j.orderItemId === it.id).every((j: any) => j.status === 'CANCELLED')).toBe(true);
    const rel = h.db.t('componentStockMovement').filter((m: any) => m.reason === 'PLAN_RELEASE');
    expect(rel).toEqual([expect.objectContaining({ componentId: 'c6', colourKey: key([0, M.red]), delta: 2, orderItemId: it.id })]);
    expect(h.db.t('componentColourStock').find((r: any) => r.componentId === 'c6' && r.colourKey === key([0, M.red])).stockOnHand).toBe(2);
    expect(out.stockReleased).toEqual([{ componentDescription: 'Large Box', colourLabel: 'PLA Red', units: 2 }]);

    const lines = items(h, o.id).map((i: any) => [i.colourOptionId, i.quantity, i.unitPrice, i.totalPrice, i.priceSource, i.tierMinQty, i.listUnitPrice, i.sizeOptionId, i.variantId, i.description]);
    expect(lines).toEqual([
      [OPT.red, 20, 2.5, 50, 'TIER', 25, 2.8, OPT.large, OPT.large, 'Sardine tin — Large — Red'],
      [OPT.blue, 10, 2.5, 25, 'TIER', 25, 2.8, OPT.large, OPT.large, 'Sardine tin — Large — Blue'],
    ]);
    expect(out.items).toHaveLength(2);
  });

  it('with one job IN_PROGRESS → 409 and nothing written (also on a dry run)', async () => {
    const { h, o, it } = await planned();
    h.db.t('productionJob').find((j: any) => j.orderItemId === it.id).status = 'IN_PROGRESS';
    const before = JSON.stringify(h.db.tables());
    await expectStatus(h.orders.changeLineColour(o.id, it.id, { ...body, confirm: true }), 409, 'Jobs for this line have started — swap the filament on the job instead');
    await expectStatus(h.orders.changeLineColour(o.id, it.id, body, true), 409);
    expect(JSON.stringify(h.db.tables())).toBe(before);
  });

  it('a job that starts between the check and the cancel (WP6 re-read) → 409 and the whole transaction rolls back', async () => {
    const { h, o, it } = await planned();
    const jobs = h.db.t('productionJob').filter((j: any) => j.orderItemId === it.id);
    const orig = h.db.productionJob.updateMany;
    h.db.productionJob.updateMany = jest.fn(async (a: any) => {
      jobs[0].status = 'IN_PROGRESS'; // a printer bridge won the row first
      return orig(a);
    });
    const before = h.db.t('orderItem').map((i: any) => ({ ...i }));
    await expectStatus(h.orders.changeLineColour(o.id, it.id, { ...body, confirm: true }), 409, 'Jobs for this line have started');
    h.db.productionJob.updateMany = orig;
    expect(h.db.t('orderItem').map((i: any) => [i.id, i.quantity, i.colourOptionId])).toEqual(before.map((i: any) => [i.id, i.quantity, i.colourOptionId]));
    expect(h.db.t('componentStockMovement').filter((m: any) => m.reason === 'PLAN_RELEASE')).toHaveLength(0);
  });

  it('validation: sum ≠ quantity, duplicate colour, excluded or inactive colour, custom line, cancelled order, foreign item', async () => {
    const h = sardine();
    const { order: o, items: [it, custom] } = addOrder(h.db, [
      { productId: P, sizeOptionId: OPT.large, quantity: 30, unitPrice: 2.5, description: 'Sardine tin — Large' },
      { quantity: 2, description: 'Custom' },
    ], 'CONFIRMED');
    await expectStatus(h.orders.changeLineColour(o.id, it.id, { colours: [{ colourOptionId: OPT.red, quantity: 20 }] }), 400, 'The colours must add up to 30');
    await expectStatus(h.orders.changeLineColour(o.id, it.id, { colours: [{ colourOptionId: OPT.red, quantity: 15 }, { colourOptionId: OPT.red, quantity: 15 }] }), 400, 'only once');
    await expectStatus(h.orders.changeLineColour(o.id, custom.id, { colours: [{ colourOptionId: OPT.red, quantity: 2 }] }), 400, 'Only product lines have colours');
    await expectStatus(h.orders.changeLineColour('other-order', it.id, { colours: [{ colourOptionId: OPT.red, quantity: 30 }] }), 404);
    h.db.insert('colourSizeExclusion', { variantId: OPT.blue, sizeKey: OPT.large });
    await expectStatus(h.orders.changeLineColour(o.id, it.id, { colours: [{ colourOptionId: OPT.blue, quantity: 30 }] }), 400, '"Blue" isn\'t made in Large');
    h.db.t('productVariant').find((v: any) => v.id === OPT.red).isActive = false;
    await expectStatus(h.orders.changeLineColour(o.id, it.id, { colours: [{ colourOptionId: OPT.red, quantity: 30 }] }), 400, 'colour "Red" is no longer available');
    for (const bad of [[], Array.from({ length: 31 }, (_, i) => ({ colourOptionId: `c${i}`, quantity: 1 }))]) {
      await expectStatus(h.orders.changeLineColour(o.id, it.id, { colours: bad }), 400, 'colours must list 1 to 30 colours');
    }
    for (const q of [0, 2.5, 100001, 'abc']) {
      await expectStatus(h.orders.changeLineColour(o.id, it.id, { colours: [{ colourOptionId: null, quantity: q }] }), 400, 'colours[0].quantity');
    }
    h.db.t('order').find((x: any) => x.id === o.id).status = 'CANCELLED';
    await expectStatus(h.orders.changeLineColour(o.id, it.id, { colours: [{ colourOptionId: null, quantity: 30 }] }), 409, 'cancelled');
  });

  it('a line with nothing planned needs no confirm; a legacy variantId line is written with its pair columns', async () => {
    const h = sardine();
    const { order: o, items: [it] } = addOrder(h.db, [{ productId: P, variantId: OPT.large, quantity: 5, unitPrice: 2.8, description: 'Sardine tin — Large' }], 'PENDING');
    await h.orders.changeLineColour(o.id, it.id, { colours: [{ colourOptionId: OPT.red, quantity: 5 }] });
    expect(items(h, o.id)[0]).toMatchObject({ sizeOptionId: OPT.large, colourOptionId: OPT.red, variantId: OPT.large, quantity: 5, totalPrice: 14, description: 'Sardine tin — Large — Red' });
  });
});

// ------------------------------------------------------------ O7 vs S2 (item 33)

describe('O7 vs S2 (§3.1 rule 3, §7.1 item 33, S2 half)', () => {
  function tealBox() {
    const row = boxRow();
    row.variants.push({
      id: 'v-teal', productId: BOX_ID, name: 'Teal', sku: null, kind: 'SIZE', isActive: true, sortOrder: 0, basePrice: null,
      estimatedGrams: null, estimatedMinutes: null, createdAt: new Date(0), colourAssignments: [], sizeExclusions: [],
    });
    const h = ordersHarness([row]);
    const prisma = h.db as any;
    const impact = new OpenLinesImpactService(prisma, h.resolver, h.planner);
    const products = new ProductsService(prisma, h.resolver, h.pricing, h.planner, new PartsService(prisma));
    const variants = new VariantsService(prisma, products, h.pricing, h.resolver, impact);
    const o7 = () => variants.setKinds(BOX_ID, { changes: [{ variantId: 'v-teal', kind: 'COLOUR' }], keepStandard: { colour: { label: 'Black', sellInShop: true } } });
    return { h, o7 };
  }
  const s2 = (h: H) => order(h, [{ productId: BOX_ID, sizeOptionId: 'v-teal', quantity: 3 }]);

  it('S2 first (holding FOR SHARE), O7 waits: after S2 commits, O7 rewrites the new line to colourOptionId = V', async () => {
    const { h, o7 } = tealBox();
    // Barrier: O7 starts only once S2 holds its FOR SHARE lock on V, and waits for S2's commit.
    let o7p: Promise<any> | null = null;
    const raw = h.db.$queryRaw.getMockImplementation()!;
    h.db.$queryRaw.mockImplementation(async (q: any) => {
      if (!o7p && /lock:ProductVariant:SHARE/.test(q?.sql ?? '')) o7p = o7();
      return raw(q);
    });
    const placed = await s2(h);
    expect(o7p).not.toBeNull();
    const reclassified = await o7p;
    expect((placed as any).items[0]).toMatchObject({ sizeOptionId: 'v-teal', priceSource: 'SIZE', unitPrice: 0.93, totalPrice: 2.79 });
    expect((reclassified as any).rewritten.orderLines).toBe(1);
    expect(h.db.t('orderItem')[0]).toMatchObject({ sizeOptionId: null, colourOptionId: 'v-teal', variantId: 'v-teal' });
  });

  it('O7 first: S2 re-reads V\'s kind under its lock → 400 "V" is a colour, not a size', async () => {
    const { h, o7 } = tealBox();
    await o7();
    await expectStatus(s2(h), 400, 'Line 1: "Teal" is a colour, not a size');
  });

  it('a kind change landing while S2 takes its lock is seen by S2 (it resolves on the locked rows)', async () => {
    const { h } = tealBox();
    const raw = h.db.$queryRaw.getMockImplementation()!;
    h.db.$queryRaw.mockImplementation(async (q: any) => {
      if (/lock:ProductVariant:SHARE/.test(q?.sql ?? '')) h.db.t('productVariant').find((v: any) => v.id === 'v-teal').kind = 'COLOUR';
      return raw(q);
    });
    await expectStatus(s2(h), 400, 'Line 1: "Teal" is a colour, not a size');
    expect(h.db.t('order')).toHaveLength(0);
  });
});

// ------------------------------------------- legacy options (items 28 and 33)

describe('Legacy options across reclassification (§7.1 items 28 and 33)', () => {
  const V = 'v-red-legacy';
  function redBox() {
    const row = boxRow();
    row.variants.push({
      id: V, productId: BOX_ID, name: 'Red', sku: null, kind: 'SIZE', isActive: true, sortOrder: 0, basePrice: 0.93,
      estimatedGrams: null, estimatedMinutes: null, createdAt: new Date(0), colourAssignments: [], sizeExclusions: [],
    });
    const h = ordersHarness([row]);
    if (!h.db.t('material').some((m: any) => m.id === M.red)) h.db.insert('material', fixtureMaterial(M.red));
    addSpool(h.db, M.black, 5000, { id: 'sp-black' });
    addSpool(h.db, M.red, 5000, { id: 'sp-red' });
    const prisma = h.db as any;
    const impact = new OpenLinesImpactService(prisma, h.resolver, h.planner);
    const products = new ProductsService(prisma, h.resolver, h.pricing, h.planner, new PartsService(prisma));
    const variants = new VariantsService(prisma, products, h.pricing, h.resolver, impact);
    const o7 = () => variants.setKinds(BOX_ID, { changes: [{ variantId: V, kind: 'COLOUR' }], keepStandard: { colour: { label: 'Black', sellInShop: true } } }) as Promise<any>;
    const assignRed = () => h.db.insert('colourOptionSlot', { variantId: V, colourSlotId: 'slot-body', materialId: M.red });
    return { h, o7, assignRed };
  }
  const pairOf = (row: any) => [row.sizeOptionId, row.colourOptionId];
  const codes = (plan: any, row: any) => [...plan.warnings, ...row.warnings].map((w: any) => w.code);

  it('a pre-release line { variantId: V } plans as size V on the fallback BOM; after O7 makes V a colour it plans as (Standard, V) in PLA Red (item 28)', async () => {
    const { h, o7, assignRed } = redBox();
    const { order: o } = addOrder(h.db, [{ productId: BOX_ID, variantId: V, quantity: 12, description: 'Box — Red' }], 'CONFIRMED');
    const before: any = await h.planning.previewPlan(o.id);
    expect(pairOf(before.rows[0])).toEqual([V, null]);
    expect(before.rows[0].fallbackToBase).toBe(true);
    expect(codes(before, before.rows[0])).toContain('SIZE_OPTION_NO_COMPONENTS');
    expect(before.rows[0].filament.map((f: any) => f.materialId)).toEqual([M.black]);

    await o7();
    assignRed();
    const after: any = await h.planning.previewPlan(o.id);
    expect(pairOf(after.rows[0])).toEqual([null, V]);
    expect(after.rows[0].fallbackToBase).toBe(false);
    expect(after.rows[0].filament.map((f: any) => [f.materialId, f.slicedMaterialId])).toEqual([[M.red, M.black]]);
    expect(h.db.t('orderItem')[0]).toMatchObject({ variantId: V, sizeOptionId: null, colourOptionId: null }); // derived, never backfilled
  });

  it('a post-deploy order does not lock a legacy option: S5 { variantId: Red } and a J5 job on an old Red line, then O7 → rewritten 1/1 and both orders plan (Standard, Red) (item 33)', async () => {
    const { h, o7, assignRed } = redBox();
    const shop: any = await h.orders.createForCustomer(CUSTOMER_ID, { items: [{ variantId: V, quantity: 2 }] });
    expect(items(h, shop.id)[0]).toMatchObject({ productId: BOX_ID, sizeOptionId: V, colourOptionId: null, variantId: V });

    const { order: old } = addOrder(h.db, [{ productId: BOX_ID, variantId: V, quantity: 12, description: 'Box — Red' }], 'CONFIRMED');
    const plan: any = await h.planning.previewPlan(old.id);
    const res: any = await h.planning.createFromPlan(old.id, { planVersion: plan.planVersion });
    expect(res.jobsCreated).toBe(1);
    const job = h.db.t('productionJob').find((j: any) => j.orderId === old.id);
    expect([job.sizeOptionId, job.colourOptionId]).toEqual([V, null]);

    const out = await o7();
    expect(out.rewritten).toEqual({ orderLines: 1, quoteLines: 0, jobs: 1 });
    expect(h.db.t('productionJob').find((j: any) => j.id === job.id)).toMatchObject({ sizeOptionId: null, colourOptionId: V, variantId: V });
    assignRed();
    for (const id of [shop.id, old.id]) {
      const p: any = await h.planning.previewPlan(id);
      expect(p.rows.map(pairOf)).toEqual([[null, V]]);
    }
  });
});

// -------------------------------------------------------------------- S1

describe('S1 pricing preview (§4.5)', () => {
  it('prices the whole document with tier hints, floors and margins; per-line errors are returned, not thrown', async () => {
    const h = sardine();
    h.db.t('productVariant').find((v: any) => v.id === OPT.blue).isActive = false;
    const out = await previewPricingLines(h.pricing, h.resolver, {
      lines: [
        { productId: P, colourOptionId: OPT.red, quantity: 15 },
        { productId: P, quantity: 10 },
        { productId: P, colourOptionId: OPT.blue, quantity: 5 },
        { productId: P, colourOptionId: OPT.red, quantity: 3, unitPrice: 1, priceOverride: true },
        { quantity: 2, unitPrice: 4 },
        { productId: P, quantity: 0 },
      ],
    });
    const [red, black, blue, manual, custom, zero] = out.lines;
    expect(red).toMatchObject({
      listUnitPrice: 1.5, tierMinQty: 25, tierUnitPrice: 1.35, tierQuantity: 28, tierLineCount: 3, tierSizeLabel: 'Regular',
      autoUnitPrice: 1.35, effectiveUnitPrice: 1.35, priceSource: 'TIER', pairLabel: 'Regular · Red', error: null,
    });
    expect(red.unitCostFloor).toBeGreaterThan(0);
    expect(red.marginPct).toBeCloseTo(((1.35 - red.unitCostFloor!) / 1.35) * 100, 0);
    expect(black).toMatchObject({ priceSource: 'TIER', pairLabel: 'Regular · Black', error: null });
    expect(blue).toMatchObject({ error: 'colour "Blue" is no longer available', priceSource: null });
    expect(manual).toMatchObject({ priceSource: 'MANUAL', effectiveUnitPrice: 1, autoUnitPrice: 1.35, tierMinQty: 25 });
    expect(custom).toMatchObject({ priceSource: 'MANUAL', effectiveUnitPrice: 4, autoUnitPrice: null, pairLabel: null, error: null });
    expect(zero.error).toBe('quantity must be a whole number from 1 to 100000');
  });

  it('≤100 lines', async () => {
    const h = sardine();
    await expectStatus(previewPricingLines(h.pricing, h.resolver, { lines: Array.from({ length: 101 }, () => ({ productId: P, quantity: 1 })) }), 400, 'at most 100 lines');
    expect((await previewPricingLines(h.pricing, h.resolver, { lines: [] })).lines).toEqual([]);
  });
});
