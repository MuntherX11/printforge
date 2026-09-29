import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
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

/**
 * POST /accounting/categories used to pass its body to Prisma, so nested
 * writes could add expenses and ledger rows that never moved a balance.
 */
describe('POST /accounting/categories allowlist', () => {
  const snapshot = (db: FakeCatalogDb) =>
    JSON.stringify([db.t('expense'), db.t('account'), db.t('accountTransaction'), db.t('expenseCategory')]);

  it.each<[string, Record<string, unknown>]>([
    ['expenses create with a ledger row', { expenses: { create: [{ description: 'x', amount: 1e12, date: new Date(), transactions: { create: [{ accountId: 'acc-bank', amount: 1e6, balanceAfter: 0, type: 'ADJUSTMENT', description: 'x' }] } }] } }],
    ['expenses connect', { expenses: { connect: [{ id: 'exp-1' }] } }],
    ['id', { id: 'cat-1' }],
    ['createdAt', { createdAt: '2020-01-01' }],
  ])('%s → 400, nothing written', async (_label, extra) => {
    const h = setup();
    await expenseOn(h, 50, 'acc-bank');
    const before = snapshot(h.db);
    expect(await badRequestOf(h.svc.createCategory({ name: 'Tools', ...extra }))).toBe(`property ${Object.keys(extra)[0]} should not exist`);
    expect(snapshot(h.db)).toBe(before);
  });

  it.each<[unknown, string]>([
    [{}, 'Name is required'],
    [{ name: '   ' }, 'Name is required'],
    [{ name: { set: 'x' } }, '"name" must be text'],
    [{ name: 'Tools', description: 5 }, '"description" must be text'],
    ['Tools', 'Request body must be a JSON object'],
  ])('%j → 400 %s', async (body, message) => {
    const h = setup();
    expect(await badRequestOf(h.svc.createCategory(body))).toBe(message);
    expect(h.db.t('expenseCategory')).toHaveLength(2);
  });

  it('what the Expenses screen sends still saves: name, and description or nothing', async () => {
    const h = setup();
    expect(await h.svc.createCategory({ name: ' Tools ', description: ' Pliers, nozzles ' })).toMatchObject({ name: 'Tools', description: 'Pliers, nozzles' });
    expect(await h.svc.createCategory({ name: 'Postage' })).toMatchObject({ name: 'Postage', description: null });
    expect(h.db.t('expenseCategory')).toHaveLength(4);
  });

  it('a name that is taken → 409, not a Prisma 500', async () => {
    const h = setup();
    await expect(h.svc.createCategory({ name: 'Rent' })).rejects.toBeInstanceOf(ConflictException);
    expect(h.db.t('expenseCategory')).toHaveLength(2);
  });

  it('stays ADMIN-only', () => {
    const reflector = new Reflector();
    expect(reflector.get(GUARDS_METADATA, ExpensesController.prototype.createCategory)).toEqual([RolesGuard]);
    expect(reflector.get(ROLES_KEY, ExpensesController.prototype.createCategory)).toEqual(['ADMIN']);
  });
});

/**
 * POST /accounting/expenses took CreateExpenseDto (an interface), so
 * description, notes, recurring and categoryId were written with no type or
 * length check, although PATCH caps description at 500 and notes at 2000.
 */
describe('POST /accounting/expenses allowlist', () => {
  const snapshot = (db: FakeCatalogDb) => JSON.stringify([db.t('expense'), db.t('account'), db.t('accountTransaction')]);
  const valid = { categoryId: 'cat-1', description: 'PLA restock', amount: 50, date: '2026-09-01' };

  it.each<[Record<string, unknown>, string]>([
    [{ ...valid, transactions: { create: [{ accountId: 'acc-bank', amount: 1e6 }] } }, 'property transactions should not exist'],
    [{ ...valid, category: { connect: { id: 'cat-2' } } }, 'property category should not exist'],
    [{ ...valid, account: { update: { balance: 0 } } }, 'property account should not exist'],
    [{ ...valid, id: 'exp-1' }, 'property id should not exist'],
    [{ ...valid, categoryId: undefined }, 'Category is required'],
    [{ ...valid, categoryId: { connect: { id: 'cat-1' } } }, '"categoryId" must be an id'],
    [{ ...valid, description: undefined }, 'Description is required'],
    [{ ...valid, description: '   ' }, 'Description is required'],
    [{ ...valid, description: { set: 'x' } }, '"description" must be text'],
    [{ ...valid, amount: undefined }, '"amount" must be a number'],
    [{ ...valid, amount: -5 }, '"amount" must be between 0 and 100000000'],
    [{ ...valid, date: undefined }, 'Date is required'],
    [{ ...valid, date: 'someday' }, 'Invalid date'],
    [{ ...valid, recurring: 'yes' }, '"recurring" must be true or false'],
    [{ ...valid, notes: ['a'] }, '"notes" must be text'],
    [{ ...valid, accountId: 7 }, '"accountId" must be an id'],
  ])('%j → 400 %s, nothing written', async (body, message) => {
    const h = setup();
    const before = snapshot(h.db);
    expect(await badRequestOf(h.svc.create(body))).toBe(message);
    expect(snapshot(h.db)).toBe(before);
  });

  it('what the Expenses screen sends still saves, with description and notes capped like PATCH', async () => {
    const h = setup();
    const out: any = await h.svc.create({ ...valid, description: ' PLA restock ', notes: ' 3 spools ' });
    expect(out).toMatchObject({ categoryId: 'cat-1', description: 'PLA restock', amount: 50, notes: '3 spools', accountId: null, category: { name: 'Filament' } });
    expect(out.date).toEqual(new Date('2026-09-01'));
    expect(h.db.t('accountTransaction')).toHaveLength(0);

    const long: any = await h.svc.create({ ...valid, description: 'd'.repeat(900), notes: 'n'.repeat(3000), recurring: true, accountId: 'acc-bank' });
    expect(long.description).toHaveLength(500);
    expect(long.notes).toHaveLength(2000);
    expect(long.recurring).toBe(true);
    expect(balance(h.db, 'acc-bank')).toBe(950);
    expectLedgerAgrees(h.db, 'acc-bank', 1000);
  });

  it('stays ADMIN/OPERATOR', () => {
    const reflector = new Reflector();
    expect(reflector.get(GUARDS_METADATA, ExpensesController.prototype.createExpense)).toEqual([RolesGuard]);
    expect(reflector.get(ROLES_KEY, ExpensesController.prototype.createExpense)).toEqual(['ADMIN', 'OPERATOR']);
  });
});

describe('DELETE /accounting/expenses/:id reverses its ledger', () => {
  it('refunds the account with an ADJUSTMENT, so the balance and its transactions still agree', async () => {
    const h = setup();
    const keep = await expenseOn(h, 30, 'acc-bank');
    const gone = await expenseOn(h, 50, 'acc-bank');
    await h.svc.update(gone.id, { amount: 80 });
    expect(balance(h.db, 'acc-bank')).toBe(890);

    await h.svc.remove(gone.id);
    expect(h.db.t('expense').map((e: any) => e.id)).toEqual([keep.id]);
    expect(balance(h.db, 'acc-bank')).toBe(970);
    expectLedgerAgrees(h.db, 'acc-bank', 1000);
    const last = ledger(h.db, 'acc-bank').at(-1);
    expect(last).toMatchObject({ amount: 80, type: 'ADJUSTMENT', description: 'Expense deleted: Filament — PLA restock', expenseId: null });
    // The kept expense's entry is untouched.
    expect(h.db.t('accountTransaction').filter((t: any) => t.expenseId === keep.id).map((t: any) => t.amount)).toEqual([-30]);
  });

  it('an expense with no account is deleted with nothing posted', async () => {
    const h = setup();
    const exp = await expenseOn(h, 25);
    await h.svc.remove(exp.id);
    expect(h.db.t('expense')).toHaveLength(0);
    expect(h.db.t('accountTransaction')).toHaveLength(0);
  });

  it('an unknown id → 404 and nothing is posted', async () => {
    const h = setup();
    await expect(h.svc.remove('exp-nope')).rejects.toBeInstanceOf(NotFoundException);
    expect(h.db.t('accountTransaction')).toHaveLength(0);
  });
});
