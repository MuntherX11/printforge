import { Injectable, NotFoundException, BadRequestException, ConflictException, Optional } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateExpenseDto } from '@printforge/types';
import { requiredNumber } from '../common/utils/validate-number';
import { round3 } from '../catalog-core/cost-engine';
import { AccountsService } from './accounts.service';
import { EXPENSE_AMOUNT, parseExpenseCategory, parseExpensePatch } from './expense-input';

@Injectable()
export class ExpensesService {
  constructor(
    private prisma: PrismaService,
    @Optional() private accounts?: AccountsService,
  ) {}

  /** POST /accounting/categories; the body is parsed by parseExpenseCategory (name, description). */
  async createCategory(body: unknown) {
    const data = parseExpenseCategory(body);
    const existing = await this.prisma.expenseCategory.findUnique({ where: { name: data.name }, select: { id: true } });
    if (existing) throw new ConflictException(`A category named "${data.name}" already exists`);
    return this.prisma.expenseCategory.create({ data });
  }

  async getCategories() {
    return this.prisma.expenseCategory.findMany({
      include: { _count: { select: { expenses: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async create(dto: CreateExpenseDto & { accountId?: string }) {
    const amount = requiredNumber(dto.amount, 'amount', EXPENSE_AMOUNT);
    const date = new Date(dto.date);
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Invalid date');

    // Money going out reduces an account, so the balance reflects both
    // directions. accountId is optional — an expense can still be recorded
    // without saying where it was paid from.
    return this.prisma.$transaction(async (tx) => {
      const expense = await tx.expense.create({
        data: {
          categoryId: dto.categoryId,
          description: dto.description,
          amount,
          date,
          recurring: dto.recurring,
          notes: dto.notes,
          accountId: dto.accountId || null,
        },
        include: { category: true },
      });

      if (dto.accountId && this.accounts && amount > 0) {
        await this.accounts.post({
          tx,
          accountId: dto.accountId,
          amount: -amount,
          type: 'EXPENSE',
          description: `${expense.category?.name ? expense.category.name + ' — ' : ''}${dto.description}`,
          expenseId: expense.id,
          occurredAt: date,
        });
      }
      return expense;
    });
  }

  async findAll(startDate?: string, endDate?: string) {
    const where: any = {};
    if (startDate || endDate) {
      where.date = {};
      if (startDate) where.date.gte = new Date(startDate);
      if (endDate) where.date.lte = new Date(endDate);
    }

    return this.prisma.expense.findMany({
      where,
      include: { category: true },
      orderBy: { date: 'desc' },
    });
  }

  /**
   * PATCH /accounting/expenses/:id. The body goes through parseExpensePatch
   * (the expense's own columns only). When amount or accountId changes, the
   * ledger is brought back in line in the same transaction, so the account
   * balance and its transactions still agree with the expense.
   */
  async update(id: string, body: unknown) {
    const data = parseExpensePatch(body);
    return this.prisma.$transaction(async (tx) => {
      const exists = await tx.expense.findUnique({ where: { id }, select: { id: true } });
      if (!exists) throw new NotFoundException('Expense not found');
      const expense = await tx.expense.update({ where: { id }, data, include: { category: true } });
      if (this.accounts && (data.amount !== undefined || data.accountId !== undefined)) {
        await this.repost(tx, expense);
      }
      return expense;
    });
  }

  /**
   * Make the expense's ledger entries net to -amount on its account (and to 0
   * on any account it used to name), posting only the difference through
   * AccountsService.post so each balance step has its transaction. An expense
   * with no account, or an amount of 0, nets to nothing.
   */
  private async repost(
    tx: any,
    expense: { id: string; amount: number; accountId: string | null; description: string; category?: { name?: string | null } | null },
    reason = 'Expense corrected',
  ) {
    const posted: Array<{ accountId: string; amount: number }> = await tx.accountTransaction.findMany({
      where: { expenseId: expense.id },
      select: { accountId: true, amount: true },
    });
    const have = new Map<string, number>();
    for (const t of posted) have.set(t.accountId, round3((have.get(t.accountId) ?? 0) + t.amount));
    const want = new Map<string, number>();
    if (expense.accountId && expense.amount > 0) want.set(expense.accountId, round3(-expense.amount));

    const label = `${expense.category?.name ? expense.category.name + ' — ' : ''}${expense.description}`;
    for (const accountId of new Set([...have.keys(), ...want.keys()])) {
      const delta = round3((want.get(accountId) ?? 0) - (have.get(accountId) ?? 0));
      if (delta === 0) continue;
      await this.accounts!.post({
        tx,
        accountId,
        amount: delta,
        type: 'ADJUSTMENT',
        description: `${reason}: ${label}`,
        expenseId: expense.id,
      });
    }
  }

  /**
   * DELETE /accounting/expenses/:id. The expense's ledger entries used to stay
   * behind (their expenseId set to null), so the account kept the deleted
   * expense's debit. Its entries are now brought to zero first, in the same
   * transaction: the refund is posted as an ADJUSTMENT, so the history keeps
   * both the payment and its reversal and the balance agrees with it.
   */
  async remove(id: string) {
    return this.prisma.$transaction(async (tx) => {
      const expense = await tx.expense.findUnique({ where: { id }, include: { category: true } });
      if (!expense) throw new NotFoundException('Expense not found');
      if (this.accounts) await this.repost(tx, { ...expense, amount: 0 }, 'Expense deleted');
      return tx.expense.delete({ where: { id } });
    });
  }
}
