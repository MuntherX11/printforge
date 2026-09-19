import PDFDocument from 'pdfkit';
import { BOX_ID, boxRow } from '../catalog-core/__fixtures__/box-product';
import { M, OPT, PRODUCT_ID, sardineRow } from '../catalog-core/__fixtures__/sardine-tin';
import { PdfService } from '../invoices/pdf.service';
import { CUSTOMER_ID, STAFF_ONLY_KEYS, addTier, allKeys, ordersHarness, type OrdersHarness } from '../orders/__fixtures__/orders-harness';
import { addOrder, addSpool, expectStatus } from '../production/__fixtures__/production-harness';
import { CUSTOMER_QUOTE_SELECT } from './quotes.service';

type H = OrdersHarness;
const P = PRODUCT_ID;

function sardine(mutate?: (row: any) => void) {
  const row = sardineRow();
  mutate?.(row);
  const h = ordersHarness([row]);
  addTier(h, P, null, 25, 1.35);
  addTier(h, P, OPT.large, 25, 2.5);
  return h;
}

function box() {
  const h = ordersHarness([boxRow()]);
  addSpool(h.db, M.black, 5000, { id: 'sp-black' });
  return h;
}

const quote = (h: H, lines: Array<Record<string, unknown>>) =>
  h.quotes.create({ customerId: CUSTOMER_ID, items: lines.map((l) => ({ description: '', quantity: 1, ...l })) }) as Promise<any>;

let seq = 0;
function addQuote(h: H, lines: Array<Record<string, unknown>>, status = 'SENT') {
  const q = h.db.insert('quote', {
    quoteNumber: `Q-${String(++seq).padStart(4, '0')}`, customerId: CUSTOMER_ID, status, validUntil: null, notes: null,
    subtotal: 0, tax: 0, total: 0, gcodeMetadata: null, stlMetadata: null, source: 'MANUAL',
  });
  const items = lines.map((l, i) => h.db.insert('quoteItem', {
    quoteId: q.id, productId: null, sizeOptionId: null, colourOptionId: null, description: 'line', quantity: 1, unitPrice: 1, totalPrice: 1,
    listUnitPrice: null, priceSource: null, tierMinQty: null, priceOverrideReason: null, estimatedCost: null, marginPercent: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)), ...l,
  }));
  const subtotal = items.reduce((s, i) => s + i.totalPrice, 0);
  Object.assign(q, { subtotal, total: subtotal });
  return { q, items };
}

const quoteItems = (h: H, quoteId: string) => h.db.t('quoteItem').filter((i: any) => i.quoteId === quoteId);

// ------------------------------------------------------------------- S6

describe('S6 quote create (§3.9, §7.1 item 20)', () => {
  it('prices on the server with size tiers and stores the pair and pricing fields', async () => {
    const h = sardine();
    const q = await quote(h, [
      { productId: P, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 20, unitPrice: 99 },
      { productId: P, sizeOptionId: OPT.large, colourOptionId: OPT.blue, quantity: 5 },
      { productId: P, colourOptionId: OPT.red, quantity: 3, unitPrice: 1.25, priceOverride: true, overrideReason: 'Sample' },
    ]);
    expect(q.items.map((i: any) => [i.sizeOptionId, i.colourOptionId, i.priceSource, i.unitPrice, i.totalPrice, i.listUnitPrice, i.tierMinQty, i.priceOverrideReason])).toEqual([
      [OPT.large, OPT.red, 'TIER', 2.5, 50, 2.8, 25, null],
      [OPT.large, OPT.blue, 'TIER', 2.5, 12.5, 2.8, 25, null],
      [null, OPT.red, 'MANUAL', 1.25, 3.75, 1.5, null, 'Sample'],
    ]);
    expect(q.total).toBe(66.25);
    expect('variantId' in q.items[0]).toBe(false);
  });

  it('a misleading client description keeps the server label first; the quote PDF shows it', async () => {
    const h = sardine();
    const q = await quote(h, [{ productId: P, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 1, description: 'Sardine tin — Large — Blue' }]);
    expect(q.items[0].description).toBe('Sardine tin — Large — Red — Sardine tin — Large — Blue');
    const texts: string[] = [];
    const spy = jest.spyOn(PDFDocument.prototype as any, 'text').mockImplementation(function (this: any, ...args: any[]) {
      texts.push(String(args[0]));
      return this;
    });
    try {
      await new PdfService(h.db as any).generateQuotePdf(await h.quotes.findOne(q.id));
    } finally {
      spy.mockRestore();
    }
    expect(texts.some((t) => t.startsWith('Sardine tin — Large — Red'))).toBe(true);
  });

  it('S8 items carry size, colour and the pair label', async () => {
    const h = sardine();
    const q = await quote(h, [{ productId: P, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 1 }]);
    const view: any = await h.quotes.findOne(q.id);
    expect(view.items[0]).toMatchObject({ size: { id: OPT.large, name: 'Large' }, colour: { id: OPT.red, name: 'Red' }, optionLabel: 'Large · Red', priceSource: 'SIZE' });
  });

  it('bounds and pair validation: 101 items → 400, an inactive colour → 400, nothing written', async () => {
    const h = sardine();
    await expectStatus(quote(h, Array.from({ length: 101 }, () => ({ productId: P, quantity: 1 }))), 400, 'at most 100 lines');
    await expect(quote(h, Array.from({ length: 100 }, () => ({ productId: P, quantity: 1 })))).resolves.toBeDefined();
    h.db.t('productVariant').find((v: any) => v.id === OPT.red).isActive = false;
    await expectStatus(quote(h, [{ productId: P, colourOptionId: OPT.red, quantity: 1 }]), 400, 'colour "Red" is no longer available');
    expect(h.db.t('quote')).toHaveLength(1);
  });
});

// ------------------------------------------------------------------- S10

describe('S10 customer quote responses (§0.2, §7.1 item 20)', () => {
  const noLeak = (value: unknown) => {
    const keys = allKeys(value);
    for (const k of STAFF_ONLY_KEYS) expect(keys.has(k)).toBe(false);
  };

  it('request, accept and reject return the findForCustomer shape — no pricing metadata, costs, margins or customer secrets', async () => {
    const h = sardine();
    const origCreate = h.db.quote.create;
    h.db.quote.create = jest.fn(async (a: any) => {
      expect(a.include).toBeUndefined();
      expect(a.select).toBe(CUSTOMER_QUOTE_SELECT);
      const { items, ...data } = a.data;
      const q = await origCreate({ data });
      for (const it of items.create) await h.db.quoteItem.create({ data: { ...it, quoteId: q.id } });
      return h.db.quote.findUnique({ where: { id: q.id }, select: a.select });
    });
    const requested: any = await h.quotes.customerRequestQuote(CUSTOMER_ID, {
      analysis: { fileName: 'part.stl' }, costEstimate: { suggestedPrice: 5, totalCost: 2 },
    } as any);
    noLeak(requested);
    expect(requested.items[0]).toEqual({ id: expect.any(String), description: 'part.stl', quantity: 1, unitPrice: 5, totalPrice: 5 });

    const { q } = addQuote(h, [{ productId: P, quantity: 30, unitPrice: 1.35, totalPrice: 40.5, listUnitPrice: 1.5, priceSource: 'TIER', tierMinQty: 25, priceOverrideReason: 'x', estimatedCost: 10, marginPercent: 60 }]);
    const accepted: any = await h.quotes.customerAccept(q.id, CUSTOMER_ID);
    expect(accepted.status).toBe('ACCEPTED');
    noLeak(accepted);
    expect(Object.keys(accepted).sort()).toEqual(Object.keys(CUSTOMER_QUOTE_SELECT).sort());

    const { q: q2 } = addQuote(h, [{ productId: P, quantity: 1, listUnitPrice: 1.5, priceSource: 'BASE', estimatedCost: 1, marginPercent: 30 }]);
    const rejected: any = await h.quotes.customerReject(q2.id, CUSTOMER_ID);
    expect(rejected.status).toBe('REJECTED');
    noLeak(rejected);
  });
});

// ------------------------------------------------------------------- S7

describe('S7 quote conversion (§3.9, §7.1 items 20 and 39)', () => {
  it('copies the pair, description and every pricing field verbatim (plus the variantId mirror), even for a since-deactivated product', async () => {
    const h = sardine();
    const { q, items } = addQuote(h, [
      { productId: P, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 25, unitPrice: 2.5, totalPrice: 62.5, listUnitPrice: 2.8, priceSource: 'TIER', tierMinQty: 25, description: 'Sardine tin — Large — Red — gift' },
      { productId: P, colourOptionId: OPT.blue, quantity: 3, unitPrice: 1, totalPrice: 3, listUnitPrice: 1.5, priceSource: 'MANUAL', tierMinQty: null, priceOverrideReason: 'Friend', description: 'Sardine tin — Blue' },
    ]);
    h.db.t('product').find((p: any) => p.id === P).isActive = false;
    h.db.t('productVariant').find((v: any) => v.id === OPT.red).isActive = false;
    const out: any = await h.quotes.convertToOrder(q.id, { autoCreateJobs: false });
    const lines = h.db.t('orderItem').filter((i: any) => i.orderId === out.id);
    const pick = (i: any) => [i.productId, i.sizeOptionId, i.colourOptionId, i.description, i.quantity, i.unitPrice, i.totalPrice, i.listUnitPrice, i.priceSource, i.tierMinQty, i.priceOverrideReason];
    expect(lines.map(pick)).toEqual(items.map(pick));
    expect(lines.map((i: any) => i.variantId)).toEqual([OPT.large, OPT.blue]);
    expect(out.total).toBe(65.5);
    expect(h.db.t('quote').find((x: any) => x.id === q.id).status).toBe('ACCEPTED');
    expect(out.planning).toEqual({ jobsCreated: 0, warnings: [] });
    expect(h.db.t('productionJob')).toHaveLength(0);
  });

  it('product line planned by planWithSuggestions (same jobs as J4 → J5 without edits); the custom line gets 2 placeholders', async () => {
    const h = box();
    const { q } = addQuote(h, [
      { productId: BOX_ID, quantity: 30, unitPrice: 0.93, totalPrice: 27.9, listUnitPrice: 0.93, priceSource: 'BASE', description: 'Box' },
      { quantity: 2, unitPrice: 5, totalPrice: 10, priceSource: 'MANUAL', description: 'Custom stand' },
    ]);
    const out: any = await h.quotes.convertToOrder(q.id, { autoCreateJobs: true });
    const jobs = h.db.t('productionJob').filter((j: any) => j.orderId === out.id);
    const [productLine, customLine] = h.db.t('orderItem').filter((i: any) => i.orderId === out.id);
    const placeholders = jobs.filter((j: any) => j.orderItemId === customLine.id);
    expect(placeholders.map((j: any) => [j.name, j.status, j.productId ?? null, j.componentId ?? null])).toEqual([
      ['Custom stand (1/2)', 'QUEUED', null, null],
      ['Custom stand (2/2)', 'QUEUED', null, null],
    ]);
    const planned = jobs.filter((j: any) => j.orderItemId === productLine.id);
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.every((j: any) => j.componentId === 'box' && j.productId === BOX_ID)).toBe(true);
    expect(out.planning.jobsCreated).toBe(planned.length + 2);

    // The same order planned by hand: J4 then J5 with the returned planVersion and no edits.
    const h2 = box();
    const { order: o2 } = addOrder(h2.db, [{ productId: BOX_ID, quantity: 30, description: 'Box' }], 'PENDING');
    const preview: any = await h2.planning.previewPlan(o2.id);
    await h2.planning.createFromPlan(o2.id, { planVersion: preview.planVersion, rows: preview.rows.map((r: any) => ({ rowKey: r.rowKey })) });
    const summary = (hh: H, orderId: string) => hh.db.t('productionJob').filter((j: any) => j.orderId === orderId && j.componentId).map((j: any) => ({
      plates: hh.db.t('jobPlate').filter((p: any) => p.jobId === j.id).map((p: any) => [p.unitsPerPlate, p.plateCount, p.unitsRequired]),
      grams: hh.db.t('jobMaterial').filter((m: any) => m.jobId === j.id).map((m: any) => [m.materialId, m.gramsUsed]),
      quantity: j.quantityToProduce,
    }));
    expect(summary(h, out.id)).toEqual(summary(h2, o2.id));
    expect(out.status).not.toBe('IN_PRODUCTION');
  });

  it('planWithSuggestions throwing → order and lines exist, jobsCreated 0 and JOBS_NOT_PLANNED; the quote is ACCEPTED with its order linked', async () => {
    const h = box();
    const { q } = addQuote(h, [{ productId: BOX_ID, quantity: 3, unitPrice: 0.93, totalPrice: 2.79, priceSource: 'BASE', description: 'Box' }]);
    jest.spyOn(h.planning, 'planWithSuggestions').mockRejectedValueOnce(new Error('planner exploded'));
    const out: any = await h.quotes.convertToOrder(q.id, {});
    expect(out.items).toHaveLength(1);
    expect(out.planning.jobsCreated).toBe(0);
    expect(out.planning.warnings).toEqual([{ code: 'JOBS_NOT_PLANNED', message: "Production wasn't planned for 1 lines (planner exploded) — plan it from the order" }]);
    const stored = h.db.t('quote').find((x: any) => x.id === q.id);
    expect(stored.status).toBe('ACCEPTED');
    expect(h.db.t('order').find((o: any) => o.id === out.id).quoteId).toBe(q.id);
    expect(h.db.t('productionJob')).toHaveLength(0);
  });

  it('autoCreateJobs: false → no jobs; a second conversion → 409; a DRAFT quote → 400', async () => {
    const h = box();
    const { q } = addQuote(h, [{ productId: BOX_ID, quantity: 3, unitPrice: 0.93, totalPrice: 2.79, description: 'Box' }, { quantity: 2, unitPrice: 1, totalPrice: 2, description: 'Custom' }]);
    const out: any = await h.quotes.convertToOrder(q.id, { autoCreateJobs: false });
    expect(out.planning).toEqual({ jobsCreated: 0, warnings: [] });
    expect(h.db.t('productionJob')).toHaveLength(0);
    await expectStatus(h.quotes.convertToOrder(q.id, {}), 409);
    const { q: draft } = addQuote(h, [{ productId: BOX_ID, quantity: 1, description: 'Box' }], 'DRAFT');
    await expectStatus(h.quotes.convertToOrder(draft.id, {}), 400, 'Quote must be SENT or ACCEPTED to convert');
  });

  it('a line whose product has vanished → 400 and nothing converted', async () => {
    const h = box();
    const { q } = addQuote(h, [{ productId: 'p-gone', quantity: 1, description: 'Old' }]);
    await expectStatus(h.quotes.convertToOrder(q.id, {}), 400, 'Line 1: product not found');
    expect(h.db.t('order')).toHaveLength(0);
    expect(h.db.t('quote').find((x: any) => x.id === q.id).status).toBe('SENT');
  });
});

// ------------------------------------------------------------------- S11

describe('S11 quote line colour change (§3.9, §7.1 items 36 and 40)', () => {
  const tierLine = (description: string) => ({
    productId: P, sizeOptionId: OPT.large, colourOptionId: null, quantity: 25, unitPrice: 2.5, totalPrice: 62.5,
    listUnitPrice: 2.8, priceSource: 'TIER', tierMinQty: 25, description,
  });
  const split = { colours: [{ colourOptionId: OPT.red, quantity: 15 }, { colourOptionId: OPT.blue, quantity: 10 }] };

  it('Q-0031: Large ×25 at TIER 25 2.500 → Red 15 + Blue 10 at 2.500, TIER 25, totals 37.500 + 25.000, quote total unchanged', async () => {
    const h = sardine();
    const { q, items: [it] } = addQuote(h, [tierLine('Sardine tin — Large')]);
    const out: any = await h.quotes.changeLineColour(q.id, it.id, split);
    const lines = quoteItems(h, q.id).map((i: any) => [i.colourOptionId, i.quantity, i.unitPrice, i.totalPrice, i.priceSource, i.tierMinQty, i.listUnitPrice, i.sizeOptionId, i.description]);
    expect(lines).toEqual([
      [OPT.red, 15, 2.5, 37.5, 'TIER', 25, 2.8, OPT.large, 'Sardine tin — Large — Red'],
      [OPT.blue, 10, 2.5, 25, 'TIER', 25, 2.8, OPT.large, 'Sardine tin — Large — Blue'],
    ]);
    expect(out.total).toBe(62.5);
    expect(out.items).toHaveLength(2);
    expect(out).toMatchObject({ cancelledJobs: [], stockReleased: [] });
  });

  it('descriptions: a note is kept with the label replaced; a pre-release description becomes the note', async () => {
    const h = sardine();
    const { q, items: [a, b] } = addQuote(h, [tierLine('Sardine tin — Large — gift box'), tierLine('Tin order')]);
    await h.quotes.changeLineColour(q.id, a.id, split);
    await h.quotes.changeLineColour(q.id, b.id, split);
    expect(quoteItems(h, q.id).map((i: any) => i.description).sort()).toEqual([
      'Sardine tin — Large — Blue — Tin order',
      'Sardine tin — Large — Blue — gift box',
      'Sardine tin — Large — Red — Tin order',
      'Sardine tin — Large — Red — gift box',
    ]);
  });

  it('dry run writes nothing; sum ≠ quantity, duplicate, excluded or inactive colour, custom line → 400; ACCEPTED quote → 409; SENT allowed', async () => {
    const h = sardine();
    const { q, items: [it, custom] } = addQuote(h, [tierLine('Sardine tin — Large'), { quantity: 2, description: 'Custom' }], 'DRAFT');
    const before = JSON.stringify(h.db.tables());
    const dry: any = await h.quotes.changeLineColour(q.id, it.id, split, true);
    expect(dry.lines.map((l: any) => l.description)).toEqual(['Sardine tin — Large — Red', 'Sardine tin — Large — Blue']);
    expect(JSON.stringify(h.db.tables())).toBe(before);

    await expectStatus(h.quotes.changeLineColour(q.id, it.id, { colours: [{ colourOptionId: OPT.red, quantity: 24 }] }), 400, 'The colours must add up to 25');
    await expectStatus(h.quotes.changeLineColour(q.id, it.id, { colours: [{ colourOptionId: OPT.red, quantity: 20 }, { colourOptionId: OPT.red, quantity: 5 }] }), 400, 'only once');
    await expectStatus(h.quotes.changeLineColour(q.id, custom.id, { colours: [{ colourOptionId: OPT.red, quantity: 2 }] }), 400, 'Only product lines have colours');
    h.db.insert('colourSizeExclusion', { variantId: OPT.blue, sizeKey: OPT.large });
    await expectStatus(h.quotes.changeLineColour(q.id, it.id, split), 400, '"Blue" isn\'t made in Large');
    h.db.t('productVariant').find((v: any) => v.id === OPT.red).isActive = false;
    await expectStatus(h.quotes.changeLineColour(q.id, it.id, { colours: [{ colourOptionId: OPT.red, quantity: 25 }] }), 400, 'colour "Red" is no longer available');
    expect(JSON.stringify(h.db.t('quoteItem'))).toBe(JSON.stringify(JSON.parse(before).quoteItem));

    const { q: sent, items: [s] } = addQuote(h, [tierLine('Sardine tin — Large')], 'SENT');
    await expect(h.quotes.changeLineColour(sent.id, s.id, { colours: [{ colourOptionId: null, quantity: 25 }] })).resolves.toBeDefined();
    const { q: acc, items: [x] } = addQuote(h, [tierLine('Sardine tin — Large')], 'ACCEPTED');
    await expectStatus(h.quotes.changeLineColour(acc.id, x.id, { colours: [{ colourOptionId: null, quantity: 25 }] }), 409);
    await expectStatus(h.quotes.changeLineColour(q.id, x.id, { colours: [{ colourOptionId: null, quantity: 25 }] }), 404);
  });
});
