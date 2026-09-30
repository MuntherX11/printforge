import { BadRequestException, ConflictException, Logger, NotFoundException, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { AccountsService } from '../accounting/accounts.service';
import { AuditInterceptor } from '../audit/audit.interceptor';
import type { AuditService } from '../audit/audit.service';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { PrismaService } from '../common/prisma/prisma.service';
import { allKeys } from '../orders/__fixtures__/orders-harness';
import { fakeCatalogDb } from '../products/__fixtures__/fake-catalog-db';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

/**
 * POST /invoices/:id/unpay: a PAID invoice back to ISSUED in one transaction,
 * reversing the order's paidAmount and the invoice's ledger entries (in the
 * account they sit in) with one audit row, or refusing with nothing changed.
 */

const ADMIN = { id: 'user-admin', name: 'Admin', role: 'ADMIN' };
const ACCOUNTING = { id: 'user-acc', name: 'Aisha', role: 'ACCOUNTING' };
const REASON = 'Marked by mistake';
const secrets = (v: unknown) => ['passwordHash', 'refreshToken'].filter((k) => allKeys(v).has(k));

interface AccountSeed { id: string; name: string; balance: number; isDefault: boolean }

async function harness(opts: { total?: number; accounts?: AccountSeed[] } = {}) {
  const db = fakeCatalogDb();
  db.insert('user', { id: ADMIN.id, name: ADMIN.name, email: 'admin@example.com', role: 'ADMIN', passwordHash: 'secret-hash' });
  db.insert('user', { id: ACCOUNTING.id, name: ACCOUNTING.name, email: 'acc@example.com', role: 'ACCOUNTING', passwordHash: 'secret-hash' });
  db.insert('customer', { id: 'cust-1', name: 'Ali', email: null, phone: null, address: null, passwordHash: 'secret-hash', refreshToken: 'secret-refresh' });
  const total = opts.total ?? 10.5;
  const order = db.insert('order', { orderNumber: 'ORD-0034', status: 'CONFIRMED', customerId: 'cust-1', subtotal: total, tax: 0, total, paidAmount: 0 });
  for (const a of opts.accounts ?? [{ id: 'acc-bank', name: 'Bank', balance: 100, isDefault: true }]) db.insert('account', { isActive: true, ...a });
  const prisma = db as unknown as PrismaService;
  const invoices = new InvoicesService(prisma, new AccountsService(prisma));
  const inv = await invoices.create({ orderId: order.id });
  const num: string = inv.invoiceNumber;
  const state = () => ({
    invoice: db.t('invoice').find((i: { id: string }) => i.id === inv.id),
    order: db.t('order').find((o: { id: string }) => o.id === order.id),
    balances: Object.fromEntries(db.t('account').map((a: AccountSeed) => [a.id, a.balance])),
    ledger: db.t('accountTransaction').filter((t: { invoiceId: string }) => t.invoiceId === inv.id),
    audits: db.t('auditLog'),
  });
  const pay = (actor = ADMIN) => invoices.update(inv.id, { status: 'PAID' }, actor);
  const undo = (actor = ADMIN, body: unknown = { reason: REASON }) => invoices.unpay(inv.id, body, actor);
  return { db, invoices, order, inv, num, state, pay, undo };
}

async function errorOf(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(() => null, (e: Error) => e);
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

/** A 409's machine-readable code and message, as the exception filter sends them. */
async function conflictOf(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  const err = await errorOf(p);
  expect(err).toBeInstanceOf(ConflictException);
  return (err as ConflictException).getResponse() as { code: string; message: string };
}

afterEach(() => jest.restoreAllMocks());

describe('POST /invoices/:id/unpay', () => {
  it('moves a PAID invoice back to ISSUED: the order, the account and one audit row are reversed with it', async () => {
    const h = await harness();
    await h.pay();
    const out = await h.undo();
    const s = h.state();
    expect(s.invoice).toMatchObject({ status: 'ISSUED', paidAmount: 0, paidAt: null });
    expect(s.order).toMatchObject({ paidAmount: 0, status: 'CONFIRMED' });
    expect(s.balances).toEqual({ 'acc-bank': 100 });
    expect(s.ledger.map((t: { type: string; amount: number; description: string }) => [t.type, t.amount, t.description])).toEqual([
      ['INVOICE_PAYMENT', 10.5, `Invoice ${h.num} — Ali`],
      ['ADJUSTMENT', -10.5, `Payment undone: Invoice ${h.num} — ${REASON} (Admin)`],
    ]);
    const adj = s.ledger[1];
    expect(adj).toMatchObject({ accountId: 'acc-bank', reference: h.num, invoiceId: h.inv.id, balanceAfter: 100 });
    expect(s.audits).toHaveLength(1);
    expect(s.audits[0]).toMatchObject({
      userId: ADMIN.id, action: 'Invoice.payment_undone', entityType: 'Invoice', entityId: h.inv.id,
      details: {
        invoiceNumber: h.num, orderId: h.order.id, orderNumber: 'ORD-0034', reason: REASON, amount: 10.5,
        orderPaidAmount: { before: 10.5, after: 0 },
        entries: [{ transactionId: adj.id, accountId: 'acc-bank', amount: -10.5, balanceAfter: 100 }],
      },
    });
    expect(typeof s.audits[0].details.paidAtWas).toBe('string');
    expect(out.reversed).toEqual({ amount: 10.5, orderPaidAmount: 0, entries: [{ accountId: 'acc-bank', accountName: 'Bank', amount: -10.5, balanceAfter: 100 }] });
    expect(out.invoice).toMatchObject({ id: h.inv.id, status: 'ISSUED', paidAmount: 0 });
    expect(out.invoice?.order.customer.name).toBe('Ali');
    expect(secrets(out)).toEqual([]);
  });

  it('pay, undo, pay, undo (ACCOUNTING too): back to where it started, four entries netting to 0, two audit rows', async () => {
    const h = await harness();
    await h.pay(ACCOUNTING);
    await h.undo(ADMIN);
    await h.pay(ACCOUNTING);
    await h.undo(ACCOUNTING, { reason: 'Transfer bounced' });
    const s = h.state();
    expect(s.order.paidAmount).toBe(0);
    expect(s.balances).toEqual({ 'acc-bank': 100 });
    expect(s.ledger.map((t: { amount: number }) => t.amount)).toEqual([10.5, -10.5, 10.5, -10.5]);
    expect(s.ledger[3].description).toBe(`Payment undone: Invoice ${h.num} — Transfer bounced (Aisha)`);
    expect(s.audits.map((a: { userId: string }) => a.userId)).toEqual([ADMIN.id, ACCOUNTING.id]);
  });

  it('takes the money back out of the account it landed in, not the current default', async () => {
    const h = await harness({ accounts: [
      { id: 'acc-bank', name: 'Bank', balance: 100, isDefault: true },
      { id: 'acc-cash', name: 'Cash', balance: 50, isDefault: false },
    ] });
    await h.pay();
    for (const a of h.db.t('account')) a.isDefault = a.id === 'acc-cash';
    const out = await h.undo();
    expect(h.state().balances).toEqual({ 'acc-bank': 100, 'acc-cash': 50 });
    expect(out.reversed.entries).toEqual([{ accountId: 'acc-bank', accountName: 'Bank', amount: -10.5, balanceAfter: 100 }]);
  });

  it('paid while no account existed: the invoice and the order are reversed and the ledger is left alone', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const h = await harness({ accounts: [] });
    await h.pay();
    h.db.insert('account', { id: 'acc-new', name: 'New bank', balance: 20, isActive: true, isDefault: true });
    const out = await h.undo();
    const s = h.state();
    expect(out.reversed).toEqual({ amount: 10.5, orderPaidAmount: 0, entries: [] });
    expect(s.invoice.status).toBe('ISSUED');
    expect(s.order.paidAmount).toBe(0);
    expect(s.ledger).toEqual([]);
    expect(s.balances).toEqual({ 'acc-new': 20 });
    expect(s.audits).toHaveLength(1);
  });

  it('a 0.000 invoice undoes cleanly, with nothing to reverse in the ledger', async () => {
    const h = await harness({ total: 0 });
    await h.pay();
    expect(h.state().ledger).toEqual([expect.objectContaining({ type: 'INVOICE_PAYMENT', amount: 0 })]);
    const out = await h.undo();
    const s = h.state();
    expect(out.reversed).toEqual({ amount: 0, orderPaidAmount: 0, entries: [] });
    expect(s.invoice).toMatchObject({ status: 'ISSUED', paidAmount: 0, paidAt: null });
    expect(s.order.paidAmount).toBe(0);
    expect(s.ledger.filter((t: { type: string }) => t.type === 'ADJUSTMENT')).toEqual([]);
  });

  it('works on a cancelled order, which stays cancelled', async () => {
    const h = await harness();
    await h.pay();
    h.state().order.status = 'CANCELLED';
    await h.undo();
    const s = h.state();
    expect(s.invoice.status).toBe('ISSUED');
    expect(s.order).toMatchObject({ status: 'CANCELLED', paidAmount: 0 });
    expect(s.balances).toEqual({ 'acc-bank': 100 });
  });

  it('keeps a 200-character reason whole (after trimming)', async () => {
    const h = await harness();
    await h.pay();
    const reason = 'r'.repeat(200);
    await h.undo(ADMIN, { reason: `  ${reason}  ` });
    expect(h.state().audits[0].details.reason).toBe(reason);
  });

  it.each<[string, unknown, string]>([
    ['no reason', {}, 'Give a reason for undoing this payment'],
    ['no body', undefined, 'Give a reason for undoing this payment'],
    ['a null reason', { reason: null }, 'Give a reason for undoing this payment'],
    ['a blank reason', { reason: '   ' }, 'Give a reason for undoing this payment'],
    ['a number', { reason: 42 }, '"reason" must be text'],
    ['201 characters', { reason: 'x'.repeat(201) }, '"reason" must be 200 characters or fewer'],
    ['an extra key', { reason: 'x', amount: 5 }, 'property amount should not exist'],
  ])('%s → 400, nothing changes', async (_label, body, message) => {
    const h = await harness();
    await h.pay();
    const before = JSON.stringify(h.state());
    const err = await errorOf(h.invoices.unpay(h.inv.id, body, ADMIN));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe(message);
    expect(JSON.stringify(h.state())).toBe(before);
  });

  it.each([['ISSUED'], ['DRAFT'], ['CANCELLED']])('a %s invoice → 400, nothing posted', async (status) => {
    const h = await harness();
    h.state().invoice.status = status;
    const before = JSON.stringify(h.state());
    const err = await errorOf(h.undo());
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe(`${h.num} isn't marked paid, so there's no payment to undo.`);
    expect(JSON.stringify(h.state())).toBe(before);
  });

  it('an unknown invoice → 404', async () => {
    const h = await harness();
    const err = await errorOf(h.invoices.unpay('inv-missing', { reason: REASON }, ADMIN));
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.message).toBe('Invoice not found');
  });

  it('an order showing less paid than the invoice added → 409 ORDER_PAID_TOO_LOW, rolled back', async () => {
    const h = await harness();
    await h.pay();
    h.state().order.paidAmount = 5;
    const before = JSON.stringify(h.state());
    expect(await conflictOf(h.undo())).toEqual({
      code: 'ORDER_PAID_TOO_LOW',
      message: 'Order ORD-0034 shows only 5.000 paid, less than the 10.500 this invoice added, so undoing it would leave the order below zero. Nothing was changed.',
    });
    expect(JSON.stringify(h.state())).toBe(before);
    expect(h.state().invoice.status).toBe('PAID');
  });

  it.each<[number, number]>([[7, 10.5], [-2, -2]])('paidAmount %d against a total of %d → 409 PAYMENT_MISMATCH', async (paid, total) => {
    const h = await harness();
    await h.pay();
    Object.assign(h.state().invoice, { paidAmount: paid, total });
    const before = JSON.stringify(h.state());
    expect(await conflictOf(h.undo())).toEqual({
      code: 'PAYMENT_MISMATCH',
      message: `${h.num} records ${paid.toFixed(3)} paid against a total of ${total.toFixed(3)}, so it isn't clear what to reverse. Nothing was changed.`,
    });
    expect(JSON.stringify(h.state())).toBe(before);
  });

  it('a pre-v2.17.1 double payment in the ledger → 409 LEDGER_MISMATCH, nothing changed', async () => {
    const h = await harness();
    await h.pay();
    h.db.insert('accountTransaction', {
      accountId: 'acc-bank', amount: 10.5, balanceAfter: 121, type: 'INVOICE_PAYMENT', description: `Invoice ${h.num}`, invoiceId: h.inv.id,
    });
    h.db.t('account')[0].balance = 121;
    const before = JSON.stringify(h.state());
    expect(await conflictOf(h.undo())).toEqual({
      code: 'LEDGER_MISMATCH',
      message: `The accounts hold 21.000 for ${h.num}, not the 10.500 it records as paid, so undoing it would leave the accounts out of step. Nothing was changed.`,
    });
    expect(JSON.stringify(h.state())).toBe(before);
    expect(h.state()).toMatchObject({ balances: { 'acc-bank': 121 }, order: { paidAmount: 10.5 }, invoice: { status: 'PAID' } });
  });

  it('locks Invoice, Order, then Account, all FOR NO KEY UPDATE, with the long transaction options', async () => {
    const h = await harness();
    await h.pay();
    h.db.locks.length = 0;
    h.db.$queryRaw.mockClear();
    h.db.$transaction.mockClear();
    await h.undo();
    expect(h.db.locks).toEqual([
      { table: 'Invoice', mode: 'NO_KEY_UPDATE', ids: [h.inv.id] },
      { table: 'Order', mode: 'NO_KEY_UPDATE', ids: [h.order.id] },
      { table: 'Account', mode: 'NO_KEY_UPDATE', ids: ['acc-bank'] },
    ]);
    const sqls: string[] = h.db.$queryRaw.mock.calls.map(([q]: [{ sql: string }]) => q.sql).filter((t: string) => t.includes('lock:'));
    expect(sqls).toHaveLength(3);
    for (const sql of sqls) {
      expect(sql).toContain('FOR NO KEY UPDATE');
      expect(sql).not.toMatch(/FOR UPDATE/);
    }
    expect(h.db.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30_000, maxWait: 10_000 });
  });

  it('a second undo (double click, or two users) → 400 and a single reversal', async () => {
    const h = await harness();
    await h.pay();
    await h.undo();
    const err = await errorOf(h.undo(ACCOUNTING));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe(`${h.num} isn't marked paid, so there's no payment to undo.`);
    const s = h.state();
    expect(s.ledger.filter((t: { type: string }) => t.type === 'ADJUSTMENT')).toHaveLength(1);
    expect(s.audits).toHaveLength(1);
    expect(s.balances).toEqual({ 'acc-bank': 100 });
  });

  it('is ADMIN and ACCOUNTING, answers 200', () => {
    const reflector = new Reflector();
    expect(reflector.get(GUARDS_METADATA, InvoicesController.prototype.unpay)).toEqual([RolesGuard]);
    expect(reflector.get(ROLES_KEY, InvoicesController.prototype.unpay)).toEqual(['ADMIN', 'ACCOUNTING']);
    expect(reflector.get(HTTP_CODE_METADATA, InvoicesController.prototype.unpay)).toBe(200);
  });
});

describe('GET /invoices: the latest undo under each row', () => {
  it('names who undid it, when and why; null when never undone; no customer secrets', async () => {
    const h = await harness();
    const other = h.db.insert('order', { orderNumber: 'ORD-0035', status: 'CONFIRMED', customerId: 'cust-1', subtotal: 3, tax: 0, total: 3, paidAmount: 0 });
    const untouched = await h.invoices.create({ orderId: other.id });
    await h.pay();
    await h.undo();
    await h.pay();
    const list = await h.invoices.findAll({ page: 1, limit: 20 });
    const row = list.data.find((r) => r.id === h.inv.id);
    expect(row?.status).toBe('PAID');
    expect(row?.paymentUndone).toEqual({ at: h.state().audits[0].createdAt.toISOString(), by: 'Admin', reason: REASON });
    expect(list.data.find((r) => r.id === untouched.id)?.paymentUndone).toBeNull();
    expect(secrets(list)).toEqual([]);
  });
});

describe('AccountsService.post', () => {
  it('locks the account FOR NO KEY UPDATE before reading its balance and writing the entry', async () => {
    const h = await harness();
    const findUnique = jest.spyOn(h.db.account, 'findUnique');
    const create = jest.spyOn(h.db.accountTransaction, 'create');
    h.db.$queryRaw.mockClear();
    await new AccountsService(h.db as unknown as PrismaService).post({ accountId: 'acc-bank', amount: 5, type: 'ADJUSTMENT', description: 'Bank fee' });
    expect(h.db.locks).toEqual([{ table: 'Account', mode: 'NO_KEY_UPDATE', ids: ['acc-bank'] }]);
    const sql: string = h.db.$queryRaw.mock.calls[0][0].sql;
    expect(sql).toContain('FOR NO KEY UPDATE');
    expect(sql).not.toMatch(/FOR UPDATE/);
    expect(h.db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(findUnique.mock.invocationCallOrder[0]);
    expect(findUnique.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
    expect(h.state().balances).toEqual({ 'acc-bank': 105 });
  });
});

describe('AuditInterceptor', () => {
  async function actionsLogged(method: string, url: string, routePath: string): Promise<string[]> {
    const log = jest.fn(async (_row: { action: string }) => undefined);
    const interceptor = new AuditInterceptor({ log } as unknown as AuditService);
    const request = { method, url, route: { path: routePath }, params: { id: 'inv-1' }, user: { id: ADMIN.id }, body: { reason: REASON } };
    const ctx = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of({ id: 'inv-1' }) };
    await lastValueFrom(interceptor.intercept(ctx, next));
    return log.mock.calls.map(([row]) => row.action);
  }

  it('skips unpay, whose service writes its own row', async () => {
    expect(await actionsLogged('POST', '/api/invoices/inv-1/unpay', '/api/invoices/:id/unpay')).toEqual([]);
    expect(await actionsLogged('POST', '/api/invoices/inv-1/unpay?x=1', '/api/invoices/:id/unpay')).toEqual([]);
  });

  it('still logs every other invoice route', async () => {
    expect(await actionsLogged('POST', '/api/invoices/inv-1/send-email', '/api/invoices/:id/send-email')).toEqual(['Invoice.sent']);
    expect(await actionsLogged('PATCH', '/api/invoices/inv-1', '/api/invoices/:id')).toEqual(['Invoice.updated']);
  });
});
