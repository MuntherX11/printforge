import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateOrderDto, UpdateOrderDto } from '@printforge/types';
import { PaginationDto, paginate, paginatedResponse } from '../common/dto/pagination.dto';
import { generateNumber } from '../common/utils/number-generator';

@Injectable()
export class OrdersService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateOrderDto) {
    const orderNumber = await generateNumber(this.prisma, 'ORD', 'order');

    const items = dto.items.map(item => ({
      productId: item.productId,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.quantity * item.unitPrice,
    }));

    const subtotal = items.reduce((sum, item) => sum + item.totalPrice, 0);
    const taxRateSetting = await this.prisma.systemSetting.findUnique({ where: { key: 'tax_rate' } });
    const taxRate = parseFloat(taxRateSetting?.value || '0') / 100;
    const tax = subtotal * taxRate;
    const total = subtotal + tax;

    return this.prisma.order.create({
      data: {
        orderNumber,
        customerId: dto.customerId,
        quoteId: dto.quoteId,
        notes: dto.notes,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        subtotal,
        tax,
        total,
        items: { create: items },
      },
      include: { customer: true, items: true },
    });
  }

  async findAll(query: PaginationDto, status?: string) {
    const where = status ? { status: status as any } : {};
    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        ...paginate(query),
        include: {
          customer: { select: { id: true, name: true } },
          _count: { select: { items: true, productionJobs: true } },
        },
      }),
      this.prisma.order.count({ where }),
    ]);
    return paginatedResponse(data, total, query);
  }

  async findOne(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        customer: true,
        items: { include: { productionJobs: { select: { id: true, name: true, status: true, totalCost: true } } } },
        productionJobs: {
          include: { printer: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
        },
        invoices: { orderBy: { createdAt: 'desc' } },
        quote: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async update(id: string, dto: UpdateOrderDto) {
    await this.findOne(id);
    return this.prisma.order.update({
      where: { id },
      data: {
        status: dto.status as any,
        notes: dto.notes,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      },
      include: { customer: true, items: true },
    });
  }
}
