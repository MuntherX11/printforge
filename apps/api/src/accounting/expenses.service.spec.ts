import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { PrismaService } from '../common/prisma/prisma.service';
import { fakeCatalogDb, type FakeCatalogDb } from '../products/__fixtures__/fake-catalog-db';
import { AccountsService } from './accounts.service';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

/**
 * PATCH /accounting/expenses/:id writes only the expense's own columns, and a
 * change of amount or account re-posts the ledger, so every account balance
 * still equals the sum of its transactions.
 */

function setup() {
  const db = fakeCatalogDb();
  db.insert('expenseCategory', { id: 'cat-1', name: 'Filament' });
  db.insert('expenseCategory', { id: 'cat-2', name: 'Rent' });
  db.insert('account', { id: 'acc-bank', name: 'Bank', balance: 1000, isActive: true, isDefault: true });
  db.insert('account', { id: 'acc-cash', name: 'Cash', balance: 200, isActive: true, isDefault: false });
  const prisma = db as unknown as PrismaService;
  const svc = new ExpensesService(prisma, new AccountsService(prisma));
  return { db, svc };
}

async function expenseOn(h: ReturnType<typeof setup>, amount: number, accountId?: string) {
  return h.svc.create({ categoryId: 'cat-1', description: 'PLA restock', amount, date: '2026-09-01', accountId });
}

const balance = (db: FakeCatalogDb, id: string) => db.t('account').find((a: any) => a.id === id).balance;
const ledger = (db: FakeCatalogDb, id: string) => db.t('accountTransaction').filter((t: any) => t.accountId === id);
const sum = (rows: any[]) => Math.round(rows.reduce((s, t) => s + t.amount, 0) * 1000) / 1000;

/** Opening balance + every transaction = the stored balance. */
function expectLedgerAgrees(db: FakeCatalogDb, id: string, opening: number) {
  expect(balance(db, id)).toBeCloseTo(opening + sum(ledger(db, id)), 6);
}

async function badRequestOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(BadRequestException);
  return (err as BadRequestException).message;
}

describe('PATCH /accounting/expenses/:id allowlist', () => {
  it.each<[string, Record<string, unknown>]>([
    ['account balance', { account: { update: { balance: 1_000_000 } } }],
    ['transactions deleteMany', { transactions: { deleteMany: {} } }],
    ['transactions create', { transactions: { create: [{ accountId: 'acc-bank', amount: 500, balanceAfter: 0, type: 'ADJUSTMENT', description: 'x' }] } }],
    ['category update', { category: { update: { name: 'Hacked' } } }],
    ['id', { id: 'exp-other' }],
    ['createdAt', { createdAt: '2020-01-01' }],
  ])('%s → 400, nothing written', async (_label, body) => {
    const h = setup();
    const exp = await expenseOn(h, 50, 'acc-bank');
    const before = JSON.stringify([h.db.t('expense'), h.db.t('account'), h.db.t('accountTransaction'), h.db.t('expenseCategory')]);
    const key = Object.keys(body)[0];
    expect(await badRequestOf(h.svc.update(exp.id, { description: 'ok', ...body }))).toBe(`property ${key} should not exist`);
    expect(JSON.stringify([h.db.t('expense'), h.db.t('account'), h.db.t('accountTransaction'), h.db.t('expenseCategory')])).toBe(before);
  });

  it.each<[Record<string, unknown>, string]>([
    [{ amount: -5 }, '"amount" must be between 0 and 100000000'],
    [{ amount: Infinity }, '"amount" must be a number'],
    [{ amount: 1e9 }, '"amount" must be between 0 and 100000000'],
    [{ date: 'someday' }, 'Invalid date'],
    [{ recurring: 'yes' }, '"recurring" must be true or false'],
    [{ description: '   ' }, 'Description is required'],
    [{ categoryId: 7 }, '"categoryId" must be an id'],
    [{ accountId: { connect: { id: 'acc-cash' } } }, '"accountId" must be an id'],
  ])('%j → 400 %s', async (body, message) => {
    const h = setup();
    const exp = await expenseOn(h, 50, 'acc-bank');
    expect(await badRequestOf(h.svc.update(exp.id, body))).toBe(message);
    expect(h.db.t('expense')[0]).toMatchObject({ amount: 50, accountId: 'acc-bank' });
  });

  it('saves the descriptive columns without touching the ledger', async () => {
    const h = setup();
    const exp = await expenseOn(h, 50, 'acc-bank');
    const out: any = await h.svc.update(exp.id, {
      categoryId: 'cat-2', description: ' Shop rent ', date: '2026-09-15', recurring: true, notes: ' monthly ',
    });
    expect(out).toMatchObject({ categoryId: 'cat-2', description: 'Shop rent', recurring: true, notes: 'monthly', category: { name: 'Rent' } });
    expect(out.date).toEqual(new Date('2026-09-15'));
    expect(ledger(h.db, 'acc-bank')).toHaveLength(1);
    expect(balance(h.db, 'acc-bank')).toBe(950);
    await h.svc.update(exp.id, { notes: null });
    expect(h.db.t('expense')[0].notes).toBeNull();
  });

  it('a new amount posts the difference, and balance and transactions still agree', async () => {
    const h = setup();
    const exp = await expenseOn(h, 50, 'acc-bank');
    await h.svc.update(exp.id, { amount: 80 });
    expect(balance(h.db, 'acc-bank')).toBe(920);
    expect(ledger(h.db, 'acc-bank').map((t: any) => t.amount)).toEqual([-50, -30]);
    expect(ledger(h.db, 'acc-bank')[1]).toMatchObject({ type: 'ADJUSTMENT', expenseId: exp.id, balanceAfter: 920 });
    expectLedgerAgrees(h.db, 'acc-bank', 1000);

    await h.svc.update(exp.id, { amount: 20 });
    expect(balance(h.db, 'acc-bank')).toBe(980);
    expectLedgerAgrees(h.db, 'acc-bank', 1000);

    // Same amount again: nothing to post.
    await h.svc.update(exp.id, { amount: 20 });
    expect(ledger(h.db, 'acc-bank')).toHaveLength(3);
  });

  it('moving the expense to another account refunds the old one and debits the new one', async () => {
    const h = setup();
    const exp = await expenseOn(h, 50, 'acc-bank');
    await h.svc.update(exp.id, { accountId: 'acc-cash', amount: 60 });
    expect(balance(h.db, 'acc-bank')).toBe(1000);
    expect(balance(h.db, 'acc-cash')).toBe(140);
    expectLedgerAgrees(h.db, 'acc-bank', 1000);
    expectLedgerAgrees(h.db, 'acc-cash', 200);
    expect(h.db.t('expense')[0]).toMatchObject({ accountId: 'acc-cash', amount: 60 });
  });

  it('clearing the account refunds it; naming one on an unposted expense debits it', async () => {
    const h = setup();
    const exp = await expenseOn(h, 50, 'acc-bank');
    await h.svc.update(exp.id, { accountId: null });
    expect(balance(h.db, 'acc-bank')).toBe(1000);
    expectLedgerAgrees(h.db, 'acc-bank', 1000);

    const legacy = await expenseOn(h, 25);
    expect(h.db.t('accountTransaction').filter((t: any) => t.expenseId === legacy.id)).toHaveLength(0);
    await h.svc.update(legacy.id, { accountId: 'acc-cash' });
    expect(balance(h.db, 'acc-cash')).toBe(175);
    expectLedgerAgrees(h.db, 'acc-cash', 200);
  });

  it('an unknown id → 404 and nothing is posted', async () => {
    const h = setup();
    await expect(h.svc.update('exp-nope', { amount: 5 })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.db.t('accountTransaction')).toHaveLength(0);
  });

  it('PATCH stays ADMIN-only', () => {
    const reflector = new Reflector();
    expect(reflector.get(GUARDS_METADATA, ExpensesController.prototype.updateExpense)).toEqual([RolesGuard]);
    expect(reflector.get(ROLES_KEY, ExpensesController.prototype.updateExpense)).toEqual(['ADMIN']);
  });
});
