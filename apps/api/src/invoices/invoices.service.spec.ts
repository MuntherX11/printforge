import { BadRequestException, ConflictException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import PDFDocument from 'pdfkit';
import { AccountsService } from '../accounting/accounts.service';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { allKeys } from '../orders/__fixtures__/orders-harness';
import { fakeCatalogDb } from '../products/__fixtures__/fake-catalog-db';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { PdfService } from './pdf.service';

const CUSTOMER_ID = 'cust-1';
const secrets = (v: unknown) => ['passwordHash', 'refreshToken'].filter((k) => allKeys(v).has(k));

function harness() {
  const db = fakeCatalogDb();
  db.insert('customer', {
    id: CUSTOMER_ID, name: 'Ali', email: 'ali@example.com', phone: '+968 9000 0000', address: 'Muscat', notes: null,
    portalAccess: true, isApproved: true, isActive: true, lastLoginAt: null, passwordHash: 'secret-hash', refreshToken: 'secret-refresh',
  });
  const order = db.insert('order', {
    orderNumber: 'ORD-0001', status: 'CONFIRMED', customerId: CUSTOMER_ID, subtotal: 10, tax: 0.5, total: 10.5, paidAmount: 0,
  });
  db.insert('orderItem', { orderId: order.id, description: 'Box', quantity: 2, unitPrice: 5, totalPrice: 10 });
  const accounts = { defaultAccount: jest.fn(async () => ({ id: 'acc-1' })), post: jest.fn(async () => undefined) };
  const invoices = new InvoicesService(db as any, accounts as any);
  return { db, order, accounts, invoices };
}

describe('Staff invoice responses never carry the customer login secrets', () => {
  it('create, findAll, findOne and update (mark paid) return the customer without passwordHash or refreshToken', async () => {
    const h = harness();
    const created: any = await h.invoices.create({ orderId: h.order.id } as any);
    expect(created.order.customer).toMatchObject({
      id: CUSTOMER_ID, name: 'Ali', email: 'ali@example.com', phone: '+968 9000 0000', address: 'Muscat',
    });
    expect(created.order.items).toHaveLength(1);
    expect(secrets(created)).toEqual([]);

    const list: any = await h.invoices.findAll({ page: 1, limit: 20 } as any);
    expect(list.data[0].order.customer).toEqual({ id: CUSTOMER_ID, name: 'Ali' });
    expect(secrets(list)).toEqual([]);

    const view: any = await h.invoices.findOne(created.id);
    expect(view.order.customer.email).toBe('ali@example.com');
    expect(secrets(view)).toEqual([]);

    const paid: any = await h.invoices.update(created.id, { status: 'PAID' } as any);
    expect(paid.status).toBe('PAID');
    expect(secrets(paid)).toEqual([]);
    // The deposit still names the customer.
    expect(h.accounts.post).toHaveBeenCalledWith(expect.objectContaining({ description: `Invoice ${created.invoiceNumber} — Ali` }));
  });

  it('the invoice PDF still prints the customer name, email, phone and address', async () => {
    const h = harness();
    const created: any = await h.invoices.create({ orderId: h.order.id } as any);
    const invoice = await h.invoices.findOne(created.id);
    const texts: string[] = [];
    const spy = jest.spyOn(PDFDocument.prototype as any, 'text').mockImplementation(function (this: any, ...args: any[]) {
      texts.push(String(args[0]));
      return this;
    });
    try {
      const buf = await new PdfService(h.db as any).generateInvoicePdf(invoice);
      expect(buf.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
    expect(texts).toEqual(expect.arrayContaining(['Ali', 'ali@example.com', '+968 9000 0000', 'Muscat']));
    expect(texts.some((t) => t.includes('secret-'))).toBe(false);
  });
});

/**
 * PATCH /invoices/:id accepts status and paidAt only, and PAID and CANCELLED
 * are final, so an invoice's payment is posted to the order and the ledger
 * exactly once.
 */
describe('PATCH /invoices/:id', () => {
  async function ledgerHarness() {
    const db = fakeCatalogDb();
    db.insert('customer', { id: CUSTOMER_ID, name: 'Ali', email: null, phone: null, address: null });
    const order = db.insert('order', { orderNumber: 'ORD-0002', status: 'CONFIRMED', customerId: CUSTOMER_ID, subtotal: 10, tax: 0.5, total: 10.5, paidAmount: 0 });
    db.insert('account', { id: 'acc-bank', name: 'Bank', balance: 100, isActive: true, isDefault: true });
    const invoices = new InvoicesService(db as any, new AccountsService(db as any));
    const inv: any = await invoices.create({ orderId: order.id } as any);
    const state = () => ({
      invoice: db.t('invoice').find((i: any) => i.id === inv.id),
      order: db.t('order').find((o: any) => o.id === order.id),
      balance: db.t('account')[0].balance,
      payments: db.t('accountTransaction').filter((t: any) => t.invoiceId === inv.id),
    });
    return { db, invoices, inv, state };
  }

  async function badRequestOf(p: Promise<unknown>): Promise<string> {
    const err = await p.then(() => null, (e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).message;
  }

  it.each<[string, Record<string, unknown>]>([
    ['paidAmount', { paidAmount: 999 }],
    ['paidAmount increment', { paidAmount: { increment: 50 } }],
    ['total', { total: 0.001 }],
    ['order', { order: { update: { paidAmount: 1e6 } } }],
    ['invoiceNumber', { invoiceNumber: 'INV-X' }],
  ])('%s → 400 and nothing changes', async (_label, extra) => {
    const h = await ledgerHarness();
    const before = JSON.stringify(h.state());
    const key = Object.keys(extra)[0];
    expect(await badRequestOf(h.invoices.update(h.inv.id, { status: 'OVERDUE', ...extra }))).toBe(`property ${key} should not exist`);
    expect(JSON.stringify(h.state())).toBe(before);
  });

  it.each<[Record<string, unknown>, string]>([
    [{ status: 'REFUNDED' }, '"status" must be one of: DRAFT, ISSUED, PAID, OVERDUE, CANCELLED'],
    [{ status: { set: 'PAID' } }, '"status" must be one of: DRAFT, ISSUED, PAID, OVERDUE, CANCELLED'],
    [{ status: 'PAID', paidAt: 'yesterday-ish' }, '"paidAt" must be a date'],
    [{ status: 'PAID', paidAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }, '"paidAt" can\'t be in the future'],
    [{ paidAt: '2026-09-01' }, '"paidAt" can only be sent with status PAID'],
  ])('%j → 400 %s, nothing posted', async (body, message) => {
    const h = await ledgerHarness();
    expect(await badRequestOf(h.invoices.update(h.inv.id, body))).toBe(message);
    expect(h.state()).toMatchObject({ invoice: { status: 'ISSUED' }, order: { paidAmount: 0 }, balance: 100, payments: [] });
    expect(h.state().invoice.paidAmount ?? 0).toBe(0);
  });

  it("the Accounting screen's Mark paid still credits the order and the default account once", async () => {
    const h = await ledgerHarness();
    const out: any = await h.invoices.update(h.inv.id, { status: 'PAID' });
    expect(out).toMatchObject({ status: 'PAID', paidAmount: 10.5 });
    expect(out.order.customer.name).toBe('Ali');
    const s = h.state();
    expect(s.order.paidAmount).toBe(10.5);
    expect(s.balance).toBe(110.5);
    expect(s.payments).toEqual([expect.objectContaining({ amount: 10.5, type: 'INVOICE_PAYMENT', description: `Invoice ${h.inv.invoiceNumber} — Ali` })]);
  });

  it('a payment date is kept on the invoice and dates the deposit', async () => {
    const h = await ledgerHarness();
    await h.invoices.update(h.inv.id, { status: 'PAID', paidAt: '2026-09-20T10:00:00Z' });
    const s = h.state();
    expect(new Date(s.invoice.paidAt).toISOString()).toBe('2026-09-20T10:00:00.000Z');
    expect(new Date(s.payments[0].occurredAt).toISOString()).toBe('2026-09-20T10:00:00.000Z');
  });

  it.each([['ISSUED'], ['OVERDUE'], ['DRAFT'], ['CANCELLED']])(
    'PAID → %s → 400: the payment is not reversed or posted a second time',
    async (status) => {
      const h = await ledgerHarness();
      await h.invoices.update(h.inv.id, { status: 'PAID' });
      expect(await badRequestOf(h.invoices.update(h.inv.id, { status }))).toMatch(/^A paid invoice can't be changed/);
      expect(await badRequestOf(h.invoices.update(h.inv.id, { status: 'PAID' }))).toBe('Invoice is already marked as paid');
      const s = h.state();
      expect(s.invoice.status).toBe('PAID');
      expect(s.order.paidAmount).toBe(10.5);
      expect(s.balance).toBe(110.5);
      expect(s.payments).toHaveLength(1);
    },
  );

  it('unpaid moves still work, and a cancelled invoice stays cancelled', async () => {
    const h = await ledgerHarness();
    expect(((await h.invoices.update(h.inv.id, { status: 'OVERDUE' })) as any).status).toBe('OVERDUE');
    expect(((await h.invoices.update(h.inv.id, { status: 'CANCELLED' })) as any).status).toBe('CANCELLED');
    expect(await badRequestOf(h.invoices.update(h.inv.id, { status: 'PAID' }))).toBe('Cannot modify a cancelled invoice');
    expect(h.state()).toMatchObject({ order: { paidAmount: 0 }, balance: 100, payments: [] });
  });

  it('a second Mark paid racing the first → 409 and nothing posted twice', async () => {
    const h = await ledgerHarness();
    const stale = await h.invoices.findOne(h.inv.id);
    await h.invoices.update(h.inv.id, { status: 'PAID' });
    jest.spyOn(h.invoices, 'findOne').mockResolvedValueOnce(stale as any);
    await expect(h.invoices.update(h.inv.id, { status: 'PAID' })).rejects.toBeInstanceOf(ConflictException);
    expect(h.state()).toMatchObject({ order: { paidAmount: 10.5 }, balance: 110.5 });
    expect(h.state().payments).toHaveLength(1);
  });

  it('stays ADMIN-only', () => {
    const reflector = new Reflector();
    expect(reflector.get(GUARDS_METADATA, InvoicesController.prototype.update)).toEqual([RolesGuard]);
    expect(reflector.get(ROLES_KEY, InvoicesController.prototype.update)).toEqual(['ADMIN']);
  });
});
