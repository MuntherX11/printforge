import { Injectable, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateExpenseDto, CreateExpenseCategoryDto } from '@printforge/types';
import { requiredNumber } from '../common/utils/validate-number';
import { AccountsService } from './accounts.service';

@Injectable()
export class ExpensesService {
  constructor(
    private prisma: PrismaService,
    @Optional() private accounts?: AccountsService,
  ) {}

  async createCategory(dto: CreateExpenseCategoryDto) {
    return this.prisma.expenseCategory.create({ data: dto });
  }

  async getCategories() {
    return this.prisma.expenseCategory.findMany({
      include: { _count: { select: { expenses: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async create(dto: CreateExpenseDto & { accountId?: string }) {
    const amount = requiredNumber(dto.amount, 'amount', { min: 0, max: 100_000_000 });
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

  async update(id: string, data: Partial<CreateExpenseDto>) {
    const exists = await this.prisma.expense.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Expense not found');

    return this.prisma.expense.update({
      where: { id },
      data: {
        ...data,
        date: data.date ? new Date(data.date) : undefined,
      } as any,
      include: { category: true },
    });
  }

  async remove(id: string) {
    const exists = await this.prisma.expense.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Expense not found');
    return this.prisma.expense.delete({ where: { id } });
  }
}
