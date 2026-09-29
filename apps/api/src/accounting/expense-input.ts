import { BadRequestException } from '@nestjs/common';
import { allowedBody, optionalText, requiredNumber } from '../common/utils/validate-number';

/**
 * Allowlist parser for PATCH /accounting/expenses/:id.
 *
 * The route's body was typed Partial<CreateExpenseDto>, an interface the global
 * ValidationPipe cannot whitelist, and update() spread it into Prisma's data.
 * `account: { update: { balance } }` then set an account balance directly,
 * `transactions: { create | delete… }` added or removed ledger rows, and a
 * plain `amount` or `accountId` change skipped the ledger and the 0..1e8 bound
 * create applies. Only the columns below are accepted; any other key → 400.
 * ExpensesService.update re-posts the ledger when amount or accountId changes.
 */
export const EXPENSE_PATCH_KEYS = ['categoryId', 'description', 'amount', 'date', 'recurring', 'notes', 'accountId'] as const;

/** OMR, the same bound POST /accounting/expenses uses. */
export const EXPENSE_AMOUNT = { min: 0, max: 100_000_000 };

export interface ExpensePatchInput {
  categoryId?: string;
  description?: string;
  amount?: number;
  date?: Date;
  recurring?: boolean;
  notes?: string | null;
  accountId?: string | null;
}

/**
 * POST /accounting/categories. CreateExpenseCategoryDto is an interface too,
 * and createCategory passed the body to prisma.expenseCategory.create as-is:
 * a nested `expenses: { create }` wrote expenses of any amount (skipping the
 * bound above) with `transactions: { create }` ledger rows that never moved
 * Account.balance, `account: { create | connect }` made or linked accounts,
 * and `expenses: { connect }` moved existing expenses into the new category.
 * Only name and description are accepted; any other key → 400.
 */
export const EXPENSE_CATEGORY_KEYS = ['name', 'description'] as const;

export function parseExpenseCategory(raw: unknown): { name: string; description: string | null } {
  const b = allowedBody(raw, EXPENSE_CATEGORY_KEYS);
  const name = optionalText(b.name, 'name', 100);
  if (!name) throw new BadRequestException('Name is required');
  return { name, description: optionalText(b.description, 'description', 500) ?? null };
}

function id(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 64) throw new BadRequestException(`"${field}" must be an id`);
  return raw.trim();
}

export function parseExpensePatch(raw: unknown): ExpensePatchInput {
  const b = allowedBody(raw, EXPENSE_PATCH_KEYS);
  const out: ExpensePatchInput = {};
  if (b.categoryId !== undefined) out.categoryId = id(b.categoryId, 'categoryId');
  if (b.description !== undefined) {
    const d = optionalText(b.description, 'description', 500);
    if (!d) throw new BadRequestException('Description is required');
    out.description = d;
  }
  if (b.amount !== undefined) out.amount = requiredNumber(b.amount, 'amount', EXPENSE_AMOUNT);
  if (b.date !== undefined) {
    const date = typeof b.date === 'string' && b.date.trim() ? new Date(b.date) : null;
    if (!date || Number.isNaN(date.getTime())) throw new BadRequestException('Invalid date');
    out.date = date;
  }
  if (b.recurring !== undefined) {
    if (typeof b.recurring !== 'boolean') throw new BadRequestException('"recurring" must be true or false');
    out.recurring = b.recurring;
  }
  const notes = optionalText(b.notes, 'notes', 2000);
  if (notes !== undefined) out.notes = notes;
  if (b.accountId !== undefined) out.accountId = b.accountId === null || b.accountId === '' ? null : id(b.accountId, 'accountId');
  return out;
}

export interface ExpenseCreateInput {
  categoryId: string;
  description: string;
  amount: number;
  date: Date;
  recurring?: boolean;
  notes: string | null;
  accountId: string | null;
}

/**
 * POST /accounting/expenses. CreateExpenseDto is an interface too, and
 * create() wrote description, notes, recurring and categoryId with no type or
 * length check. Same keys and rules as parseExpensePatch; categoryId,
 * description, amount and date are required.
 */
export function parseExpenseCreate(raw: unknown): ExpenseCreateInput {
  const p = parseExpensePatch(raw);
  if (!p.categoryId) throw new BadRequestException('Category is required');
  if (!p.description) throw new BadRequestException('Description is required');
  if (p.amount === undefined) throw new BadRequestException('"amount" must be a number');
  if (!p.date) throw new BadRequestException('Date is required');
  return {
    categoryId: p.categoryId,
    description: p.description,
    amount: p.amount,
    date: p.date,
    recurring: p.recurring,
    notes: p.notes ?? null,
    accountId: p.accountId ?? null,
  };
}
