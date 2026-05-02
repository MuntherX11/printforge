import { Injectable, NotFoundException, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateInvoiceDto, UpdateInvoiceDto, InvoiceStatus } from '@printforge/types';
import { generateNumber } from '../common/utils/number-generator';
import { PaginationDto, paginate, paginatedResponse } from '../common/dto/pagination.dto';

@Injectable()
export class InvoicesService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateInvoiceDto) {
    const order = await this.prisma.order.findUnique({
      where: { id: dto.orderId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    if (dto.orderId) {
      const existing = await this.prisma.invoice.findFirst({
        where: { orderId: dto.orderId, status: { notIn: ['CANCELLED'] } },
        select: { id: true, invoiceNumber: true },
      });
      if (existing) {
        throw new BadRequestException(
          `An active invoice (${existing.invoiceNumber}) already exists for this order`,
        );
      }
    }

    let invoiceNumber: string | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        invoiceNumber = await generateNumber(this.prisma, 'INV', 'invoice');
        break;
      } catch (e: unknown) {
        if ((e as { code?: string }).code !== 'P2002' || attempt === 4) throw e;
      }
    }
    if (!invoiceNumber) throw new InternalServerErrorException('Failed to generate unique document number');

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

  async findAll(query: PaginationDto) {
    const [data, total] = await Promise.all([
      this.prisma.invoice.findMany({
        ...paginate(query),
        include: {
          order: { include: { customer: { select: { id: true, name: true } } } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.invoice.count(),
    ]);
    return paginatedResponse(data, total, query);
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
    // findOne throws NotFoundException if missing — reuse the result below
    const existing = await this.findOne(id);

    if (existing.status === 'CANCELLED') {
      throw new BadRequestException('Cannot modify a cancelled invoice');
    }
    if (existing.status === 'PAID' && dto.status === 'PAID') {
      throw new BadRequestException('Invoice is already marked as paid');
    }

    const data: { status?: InvoiceStatus; paidAmount?: number; paidAt?: Date } = {};
    if (dto.status) data.status = dto.status;
    if (dto.paidAmount !== undefined) data.paidAmount = dto.paidAmount;
    if (dto.paidAt) data.paidAt = new Date(dto.paidAt);

    // If marking as paid, stamp paidAmount + paidAt and credit the order atomically
    if (dto.status === 'PAID') {
      data.paidAmount = existing.total;
      data.paidAt = new Date();
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.invoice.update({
        where: { id },
        data,
        include: { order: { include: { customer: true, items: true } } },
      });
      if (dto.status === 'PAID' && existing.status !== 'PAID' && existing.orderId) {
        await tx.order.update({
          where: { id: existing.orderId },
          data: { paidAmount: { increment: existing.total } },
        });
      }
      return updated;
    });
  }
}
