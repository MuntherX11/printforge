import { BadRequestException } from '@nestjs/common';
import { CUSTOMER_ID, ordersHarness, type OrdersHarness } from '../orders/__fixtures__/orders-harness';

/**
 * POST /quotes/customer/request and POST /quotes/customer/:id/accept.
 *
 * The request's prices come from the customer's own estimate, so they are
 * bounded here and are never an offer by themselves: the customer can accept
 * their request only after staff have reviewed it and sent it (SENT).
 */

function harness() {
  const h = ordersHarness();
  // The fake database has no nested writes; unfold `items: { create }` like Prisma does.
  const origCreate = h.db.quote.create;
  h.db.quote.create = jest.fn(async (a: any) => {
    const { items, ...data } = a.data;
    const q = await origCreate({ data });
    for (const it of items.create) await h.db.quoteItem.create({ data: { ...it, quoteId: q.id } });
    return h.db.quote.findUnique({ where: { id: q.id }, select: a.select });
  });
  return h;
}

/** What customer/dashboard/quick-quote/page.tsx sends for an STL or G-code file. */
const fileRequest = (price = 4.25) => ({
  analysis: { fileName: 'bracket.gcode', fileType: 'gcode', slicer: 'OrcaSlicer', estimatedTimeSeconds: 3600, filamentUsedGrams: 42.5 },
  costEstimate: { suggestedPrice: price, totalCost: 2.1 },
});

/** What the same page sends for a 3MF file. */
const plateRequest = (prices: number[]) => ({
  plates: prices.map((p, i) => ({
    plateIndex: i + 1, name: `Plate ${i + 1}`, printSeconds: 1800, weightGrams: 20.4, isMultiColor: false,
    breakdown: { suggestedPrice: p, totalCost: 1 },
  })),
});

const row = (h: OrdersHarness, id: string) => h.db.t('quote').find((q: any) => q.id === id);
const itemsOf = (h: OrdersHarness, id: string) => h.db.t('quoteItem').filter((i: any) => i.quoteId === id);

async function badRequestOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(BadRequestException);
  return (err as BadRequestException).message;
}

describe('customer quote request', () => {
  it('saves the file request as a CUSTOMER DRAFT with its lines and the allowlisted analysis', async () => {
    const h = harness();
    const q: any = await h.quotes.customerRequestQuote(CUSTOMER_ID, fileRequest() as any);
    expect(q).toMatchObject({ status: 'DRAFT', source: 'CUSTOMER', total: 4.25 });
    expect(row(h, q.id)).toMatchObject({ customerId: CUSTOMER_ID, subtotal: 4.25, notes: null });
    expect(row(h, q.id).gcodeMetadata).toEqual(fileRequest().analysis);
    expect(itemsOf(h, q.id)).toEqual([expect.objectContaining({
      description: 'bracket.gcode', quantity: 1, unitPrice: 4.25, totalPrice: 4.25, estimatedGrams: 42.5, estimatedMinutes: 60, estimatedCost: 2.1,
    })]);
  });

  it('saves the 3MF request, one line per plate', async () => {
    const h = harness();
    const q: any = await h.quotes.customerRequestQuote(CUSTOMER_ID, plateRequest([1.5, 2.25]) as any);
    expect(row(h, q.id)).toMatchObject({ source: 'CUSTOMER', status: 'DRAFT', subtotal: 3.75, total: 3.75 });
    expect(itemsOf(h, q.id).map((i: any) => [i.description, i.unitPrice, i.estimatedGrams, i.estimatedMinutes])).toEqual([
      ['Plate 1', 1.5, 20, 30],
      ['Plate 2', 2.25, 20, 30],
    ]);
  });

  it.each<[string, unknown, string]>([
    ['an absurd price', fileRequest(1e12), '"costEstimate.suggestedPrice" must be between 0 and 1000000'],
    ['an Infinity price', fileRequest(Infinity), '"costEstimate.suggestedPrice" must be a number'],
    ['an absurd plate price', plateRequest([1, 5e9]), '"plates[1].breakdown.suggestedPrice" must be between 0 and 1000000'],
    ['absurd grams', { ...fileRequest(), analysis: { ...fileRequest().analysis, filamentUsedGrams: 1e9 } }, '"analysis.filamentUsedGrams" must be between 0 and 100000'],
    ['101 plates', plateRequest(Array.from({ length: 101 }, () => 1)), 'A quote request can have at most 100 plates'],
    ['neither plates nor analysis', { notes: 'hi' }, 'Provide either plates (3MF) or analysis + costEstimate'],
  ])('%s → 400 and no quote', async (_label, body, message) => {
    const h = harness();
    expect(await badRequestOf(h.quotes.customerRequestQuote(CUSTOMER_ID, body as any))).toBe(message);
    expect(h.db.t('quote')).toHaveLength(0);
  });

  it('caps notes and a long file name instead of storing them whole', async () => {
    const h = harness();
    const body = { ...fileRequest(), notes: 'n'.repeat(5000) } as any;
    body.analysis.fileName = 'f'.repeat(400);
    const q: any = await h.quotes.customerRequestQuote(CUSTOMER_ID, body);
    expect(row(h, q.id).notes).toHaveLength(2000);
    expect(itemsOf(h, q.id)[0].description).toHaveLength(255);
  });
});

describe('customer accept of their own request', () => {
  it('refuses a customer-priced request still in DRAFT, even at 0.000, and leaves it DRAFT', async () => {
    const h = harness();
    const q: any = await h.quotes.customerRequestQuote(CUSTOMER_ID, fileRequest(0) as any);
    expect(await badRequestOf(h.quotes.customerAccept(q.id, CUSTOMER_ID)))
      .toBe('This quote is still being reviewed. You can accept it once we send it to you.');
    expect(row(h, q.id).status).toBe('DRAFT');
    // Reject stays available.
    expect((await h.quotes.customerReject(q.id, CUSTOMER_ID) as any).status).toBe('REJECTED');
  });

  it('accepts it once staff have reviewed and sent it', async () => {
    const h = harness();
    const q: any = await h.quotes.customerRequestQuote(CUSTOMER_ID, fileRequest() as any);
    row(h, q.id).status = 'SENT';
    const out: any = await h.quotes.customerAccept(q.id, CUSTOMER_ID);
    expect(out).toMatchObject({ status: 'ACCEPTED', source: 'CUSTOMER' });
  });

  it('still lets a customer accept a staff-made DRAFT quote, as before', async () => {
    const h = harness();
    const staff = h.db.insert('quote', {
      quoteNumber: 'QT-0100', customerId: CUSTOMER_ID, status: 'DRAFT', source: 'MANUAL', validUntil: null, notes: null,
      subtotal: 5, tax: 0, total: 5, gcodeMetadata: null, stlMetadata: null,
    });
    expect((await h.quotes.customerAccept(staff.id, CUSTOMER_ID) as any).status).toBe('ACCEPTED');
  });

  it('my-quotes carries source so the portal can hide Accept on a request under review', async () => {
    const h = harness();
    await h.quotes.customerRequestQuote(CUSTOMER_ID, fileRequest() as any);
    const list: any = await h.quotes.findForCustomer(CUSTOMER_ID, { page: 1, limit: 20 } as any);
    expect(list.data[0]).toMatchObject({ status: 'DRAFT', source: 'CUSTOMER' });
  });
});

/**
 * The customer can accept their request only once staff send it, so its
 * validity window starts when it is sent. It used to keep the window set when
 * the customer asked (quote_validity_days, default 3): a request reviewed on
 * day 4 showed "Quote Ready" with an Accept that answered "Quote has expired",
 * Convert was refused too, and no screen could set a new date.
 */
describe('sending a customer request restarts its validity window', () => {
  const DAY = 86_400_000;
  const daysFromNow = (d: unknown) => (new Date(d as any).getTime() - Date.now()) / DAY;

  async function lateRequest(h: OrdersHarness) {
    const q: any = await h.quotes.customerRequestQuote(CUSTOMER_ID, fileRequest() as any);
    // Four days later: the window set at request time has run out.
    row(h, q.id).validUntil = new Date(Date.now() - DAY);
    return q;
  }

  it('DRAFT → SENT after the window: the customer can accept it and staff can convert it', async () => {
    const h = harness();
    const q = await lateRequest(h);
    const sent: any = await h.quotes.update(q.id, { status: 'SENT' });
    expect(sent.status).toBe('SENT');
    expect(daysFromNow(row(h, q.id).validUntil)).toBeCloseTo(3, 1);
    expect((await h.quotes.customerAccept(q.id, CUSTOMER_ID) as any).status).toBe('ACCEPTED');

    const other = await lateRequest(h);
    await h.quotes.update(other.id, { status: 'SENT' });
    const order: any = await h.quotes.convertToOrder(other.id, { autoCreateJobs: false });
    expect(order.orderNumber).toBeTruthy();
  });

  it('a request the midnight job already EXPIRED can be sent again, with a new window', async () => {
    const h = harness();
    const q = await lateRequest(h);
    expect(await h.quotes.expireOldQuotes()).toBe(1);
    expect(row(h, q.id).status).toBe('EXPIRED');
    await h.quotes.update(q.id, { status: 'SENT' });
    expect(row(h, q.id).status).toBe('SENT');
    expect((await h.quotes.customerAccept(q.id, CUSTOMER_ID) as any).status).toBe('ACCEPTED');
  });

  it('uses the quote_validity_days setting, and a validUntil sent with the status wins', async () => {
    const h = harness();
    h.db.insert('systemSetting', { key: 'quote_validity_days', value: '7' });
    const q = await lateRequest(h);
    await h.quotes.update(q.id, { status: 'SENT' });
    expect(daysFromNow(row(h, q.id).validUntil)).toBeCloseTo(7, 1);

    const r = await lateRequest(h);
    await h.quotes.update(r.id, { status: 'SENT', validUntil: '2099-01-01T00:00:00Z' });
    expect(new Date(row(h, r.id).validUntil).toISOString()).toBe('2099-01-01T00:00:00.000Z');
  });

  it("a staff quote's validity is left alone, and re-saving SENT doesn't extend a request", async () => {
    const h = harness();
    const until = new Date(Date.now() + 2 * DAY);
    const staff = h.db.insert('quote', {
      quoteNumber: 'QT-0200', customerId: CUSTOMER_ID, status: 'DRAFT', source: 'QUICK_QUOTE', validUntil: until, notes: null,
      subtotal: 5, tax: 0, total: 5, gcodeMetadata: null, stlMetadata: null,
    });
    await h.quotes.update(staff.id, { status: 'SENT' });
    expect(new Date(row(h, staff.id).validUntil).getTime()).toBe(until.getTime());

    const q: any = await h.quotes.customerRequestQuote(CUSTOMER_ID, fileRequest() as any);
    row(h, q.id).status = 'SENT';
    row(h, q.id).validUntil = until;
    await h.quotes.update(q.id, { status: 'SENT' });
    expect(new Date(row(h, q.id).validUntil).getTime()).toBe(until.getTime());
  });

  it.each<[Record<string, unknown>, string]>([
    [{ status: 'SENT', total: 0 }, 'property total should not exist'],
    [{ status: 'SENT', items: { deleteMany: {} } }, 'property items should not exist'],
    [{ status: 'PAID' }, '"status" must be one of: DRAFT, SENT, ACCEPTED, REJECTED, EXPIRED'],
    [{ validUntil: 'soon' }, 'validUntil must be a date'],
    [{ notes: ['a'] }, '"notes" must be text'],
  ])('PATCH %j → 400 %s and the quote is unchanged', async (body, message) => {
    const h = harness();
    const q = await lateRequest(h);
    const before = JSON.stringify(row(h, q.id));
    expect(await badRequestOf(h.quotes.update(q.id, body))).toBe(message);
    expect(JSON.stringify(row(h, q.id))).toBe(before);
  });
});
