import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateInvoiceDto, UpdateInvoiceDto } from '@printforge/types';
import { generateNumber } from '../common/utils/number-generator';

@Injectable()
export class InvoicesService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateInvoiceDto) {
    const order = await this.prisma.order.findUnique({
      where: { id: dto.orderId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    const invoiceNumber = await generateNumber(this.prisma, 'INV', 'invoice');

    return this.prisma.invoice.create({
      data: {
        invoiceNumber,
        orderId: dto.orderId,
        subtotal: order.subtotal,
        tax: order.tax,
        total: order.total,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        issuedAt: new Date(),
        status: 'ISSUED',
      },
      include: { order: { include: { customer: true, items: true } } },
    });
  }

  async findAll() {
    return this.prisma.invoice.findMany({
      include: {
        order: { include: { customer: { select: { id: true, name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        order: { include: { customer: true, items: true } },
      },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }

  async update(id: string, dto: UpdateInvoiceDto) {
    await this.findOne(id);

    const data: any = {};
    if (dto.status) data.status = dto.status;
    if (dto.paidAmount !== undefined) data.paidAmount = dto.paidAmount;
    if (dto.paidAt) data.paidAt = new Date(dto.paidAt);

    // If marking as paid, update order paidAmount
    if (dto.status === 'PAID') {
      const invoice = await this.prisma.invoice.findUnique({ where: { id } });
      if (invoice) {
        data.paidAmount = invoice.total;
        data.paidAt = new Date();
        await this.prisma.order.update({
          where: { id: invoice.orderId },
          data: { paidAmount: { increment: invoice.total } },
        });
      }
    }

    return this.prisma.invoice.update({
      where: { id },
      data,
      include: { order: { include: { customer: true, items: true } } },
    });
  }
}
