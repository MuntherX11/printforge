import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateExpenseDto, CreateExpenseCategoryDto } from '@printforge/types';

@Injectable()
export class ExpensesService {
  constructor(private prisma: PrismaService) {}

  async createCategory(dto: CreateExpenseCategoryDto) {
    return this.prisma.expenseCategory.create({ data: dto });
  }

  async getCategories() {
    return this.prisma.expenseCategory.findMany({
      include: { _count: { select: { expenses: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async create(dto: CreateExpenseDto) {
    return this.prisma.expense.create({
      data: {
        categoryId: dto.categoryId,
        description: dto.description,
        amount: dto.amount,
        date: new Date(dto.date),
        recurring: dto.recurring,
        notes: dto.notes,
      },
      include: { category: true },
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
    return this.prisma.expense.delete({ where: { id } });
  }
}
