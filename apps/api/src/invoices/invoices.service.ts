import { Injectable, NotFoundException, BadRequestException, ConflictException, InternalServerErrorException, Optional, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateInvoiceDto, InvoiceStatus } from '@printforge/types';
import { parseInvoicePatch } from './invoice-input';
import { generateNumber } from '../common/utils/number-generator';
import { PaginationDto, paginate, paginatedResponse } from '../common/dto/pagination.dto';
import { AccountsService } from '../accounting/accounts.service';
import { STAFF_CUSTOMER_SELECT } from '../orders/orders.service';

/**
 * An invoice with its order, the order lines and the customer, for the staff
 * invoice responses and the invoice PDF: never the customer's login secrets.
 */
const INVOICE_INCLUDE = {
  order: { include: { customer: { select: STAFF_CUSTOMER_SELECT }, items: true } },
} as const;

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private prisma: PrismaService,
    @Optional() private accounts?: AccountsService,
  ) {}

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
      include: INVOICE_INCLUDE,
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
      include: INVOICE_INCLUDE,
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }

  /**
   * PATCH /invoices/:id (ADMIN). The body is parsed by parseInvoicePatch
   * (status and paidAt only). PAID and CANCELLED are final: moving a PAID
   * invoice back to ISSUED and then to PAID again used to post a second
   * INVOICE_PAYMENT and credit the order twice, and PAID → CANCELLED kept both
   * credits. Marking paid stamps paidAmount (the total) and paidAt (the date
   * sent, or now), credits the order and posts the deposit dated paidAt, in
   * one transaction guarded on the status read, so two clicks can't both post.
   */
  async update(id: string, body: unknown) {
    const dto = parseInvoicePatch(body);
    // findOne throws NotFoundException if missing — reuse the result below
    const existing = await this.findOne(id);

    if (existing.status === 'CANCELLED') {
      throw new BadRequestException('Cannot modify a cancelled invoice');
    }
    if (existing.status === 'PAID' && dto.status === 'PAID') {
      throw new BadRequestException('Invoice is already marked as paid');
    }
    if (existing.status === 'PAID' && (dto.status !== undefined || dto.paidAt !== undefined)) {
      // An account adjustment would fix only Account.balance, not the invoice's
      // or the order's paidAmount, so the message doesn't suggest one.
      throw new BadRequestException(
        "A paid invoice can't be changed: its payment is already recorded on the invoice, the order and the accounts, and undoing a payment isn't supported yet.",
      );
    }

    const data: { status?: InvoiceStatus; paidAmount?: number; paidAt?: Date } = {};
    if (dto.status) data.status = dto.status as InvoiceStatus;

    // If marking as paid, stamp paidAmount + paidAt and credit the order atomically
    const markingPaid = dto.status === 'PAID';
    if (markingPaid) {
      data.paidAmount = existing.total;
      data.paidAt = dto.paidAt ?? new Date();
    }

    return this.prisma.$transaction(async (tx) => {
      const moved = await tx.invoice.updateMany({ where: { id, status: existing.status }, data });
      if (moved.count === 0) throw new ConflictException('This invoice was changed by another request — reload it and try again');
      const updated = await tx.invoice.findUnique({ where: { id }, include: INVOICE_INCLUDE });
      if (!updated) throw new NotFoundException('Invoice not found');
      if (markingPaid) {
        if (existing.orderId) {
          await tx.order.update({
            where: { id: existing.orderId },
            data: { paidAmount: { increment: existing.total } },
          });
        }

        // Money actually arrived somewhere — credit the default account so the
        // bank balance reflects it. Inside the same transaction, so an invoice
        // can never be marked paid without the matching deposit.
        if (this.accounts) {
          const account = await this.accounts.defaultAccount(tx);
          if (account) {
            await this.accounts.post({
              tx,
              accountId: account.id,
              amount: existing.total,
              type: 'INVOICE_PAYMENT',
              description: `Invoice ${existing.invoiceNumber}`
                + (updated.order?.customer?.name ? ` — ${updated.order.customer.name}` : ''),
              reference: existing.invoiceNumber,
              invoiceId: existing.id,
              occurredAt: data.paidAt,
            });
          } else {
            // No account set up yet: don't block getting paid, just don't post.
            this.logger.warn(
              `Invoice ${existing.invoiceNumber} marked paid but no account exists to credit`,
            );
          }
        }
      }
      return updated;
    });
  }
}
