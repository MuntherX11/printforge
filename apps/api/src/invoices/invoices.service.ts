import {
  Injectable, NotFoundException, BadRequestException, ConflictException, ForbiddenException,
  InternalServerErrorException, Optional, Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateInvoiceDto, InvoiceStatus, type InvoicePaymentReversal, type InvoicePaymentUndo } from '@printforge/types';
import { parseInvoicePatch, parseInvoiceUnpay, type InvoiceActor } from './invoice-input';
import { generateNumber } from '../common/utils/number-generator';
import { PaginationDto, paginate, paginatedResponse } from '../common/dto/pagination.dto';
import { AccountsService } from '../accounting/accounts.service';
import { STAFF_CUSTOMER_SELECT } from '../orders/orders.service';
import { round3 } from '../catalog-core/cost-engine';
import { TX_OPTS } from '../products/product-locks';

/**
 * An invoice with its order, the order lines and the customer, for the staff
 * invoice responses and the invoice PDF: never the customer's login secrets.
 */
const INVOICE_INCLUDE = {
  order: { include: { customer: { select: STAFF_CUSTOMER_SELECT }, items: true } },
} as const;

/** The AuditLog action an undo writes, and the list reads back for its note. */
const PAYMENT_UNDONE = 'Invoice.payment_undone';

/** A reversal as the audit row records it (a type literal, so it is JSON input). */
type ReversalEntry = { transactionId: string; accountId: string; amount: number; balanceAfter: number };

/** FOR NO KEY UPDATE, not FOR UPDATE: it serialises writers of the row but does not block inserts that reference it (FK FOR KEY SHARE). */
function lockRow(tx: Prisma.TransactionClient, table: 'Invoice' | 'Order', id: string): Promise<unknown[]> {
  return tx.$queryRaw<unknown[]>(
    Prisma.sql`/* lock:${Prisma.raw(`${table}:NO_KEY_UPDATE`)} */ SELECT "id" FROM ${Prisma.raw(`"${table}"`)} WHERE "id" = ANY(${[id]}::text[]) FOR NO KEY UPDATE`,
  );
}

/** The undo's reason from its audit row's details, or '' when the row has none. */
function reasonOf(details: Prisma.JsonValue | null): string {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return '';
  const reason = (details as Prisma.JsonObject).reason;
  return typeof reason === 'string' ? reason : '';
}

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

  /** Each row carries `paymentUndone`: its latest undo (who, when, why), or null. */
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
    const undone = await this.latestUndos(data.map((i) => i.id));
    const rows = data.map((i) => ({ ...i, paymentUndone: undone.get(i.id) ?? null }));
    return paginatedResponse(rows, total, query);
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
   * PATCH /invoices/:id (ADMIN; ACCOUNTING may only mark PAID). The body is
   * parsed by parseInvoicePatch (status and paidAt only). CANCELLED is final,
   * and a PAID invoice leaves PAID only through POST /invoices/:id/unpay:
   * moving it back here used to post a second INVOICE_PAYMENT and credit the
   * order twice on the next Mark paid. Marking paid stamps paidAmount (the
   * total) and paidAt (the date sent, or now), credits the order and posts the
   * deposit dated paidAt, in one transaction guarded on the status read, so
   * two clicks can't both post.
   */
  async update(id: string, body: unknown, actor: InvoiceActor) {
    const dto = parseInvoicePatch(body);
    if (actor.role !== 'ADMIN' && dto.status !== 'PAID') {
      throw new ForbiddenException('Accounting can mark an invoice paid; other changes to an invoice need an admin.');
    }
    // findOne throws NotFoundException if missing — reuse the result below
    const existing = await this.findOne(id);

    if (existing.status === 'CANCELLED') {
      throw new BadRequestException('Cannot modify a cancelled invoice');
    }
    if (existing.status === 'PAID' && dto.status === 'PAID') {
      throw new BadRequestException('Invoice is already marked as paid');
    }
    if (existing.status === 'PAID' && (dto.status !== undefined || dto.paidAt !== undefined)) {
      throw new BadRequestException("A paid invoice can't be changed here: use Undo payment to move it back to Issued first.");
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

  /**
   * POST /invoices/:id/unpay (ADMIN, ACCOUNTING): a PAID invoice back to
   * ISSUED, in one transaction. The invoice's paidAmount/paidAt are cleared,
   * the order's paidAmount drops by what the invoice added (its status is not
   * checked, so a cancelled order's payment can be undone too), and every
   * account still holding this invoice's entries gets an ADJUSTMENT reversing
   * them: history is never edited. Figures that don't add up are refused (409)
   * with nothing changed. Locks Invoice, then Order, then Account(s), the same
   * order as Mark paid. Writes the only audit row (the interceptor skips it).
   */
  async unpay(id: string, body: unknown, actor: InvoiceActor) {
    const { reason } = parseInvoiceUnpay(body);
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockRow(tx, 'Invoice', id)).length) throw new NotFoundException('Invoice not found');
      const inv = await tx.invoice.findUnique({
        where: { id },
        select: { invoiceNumber: true, status: true, total: true, paidAmount: true, paidAt: true, orderId: true },
      });
      if (!inv) throw new NotFoundException('Invoice not found');
      const { invoiceNumber, orderId } = inv;
      if (inv.status !== 'PAID') {
        throw new BadRequestException(`${invoiceNumber} isn't marked paid, so there's no payment to undo.`);
      }
      const amount = round3(inv.paidAmount);
      const total = round3(inv.total);
      if (amount < 0 || amount !== total) {
        throw new ConflictException({
          message: `${invoiceNumber} records ${amount.toFixed(3)} paid against a total of ${total.toFixed(3)}, so it isn't clear what to reverse. Nothing was changed.`,
          code: 'PAYMENT_MISMATCH',
        });
      }

      await lockRow(tx, 'Order', orderId);
      const order = await tx.order.findUnique({ where: { id: orderId }, select: { orderNumber: true, paidAmount: true } });
      if (!order) throw new NotFoundException('Order not found');
      const before = round3(order.paidAmount);
      if (before < amount) {
        throw new ConflictException({
          message: `Order ${order.orderNumber} shows only ${before.toFixed(3)} paid, less than the ${amount.toFixed(3)} this invoice added, so undoing it would leave the order below zero. Nothing was changed.`,
          code: 'ORDER_PAID_TOO_LOW',
        });
      }

      // Every entry linked to the invoice, netted per account (as expenses' repost does).
      const linked = await tx.accountTransaction.findMany({ where: { invoiceId: id }, select: { accountId: true, amount: true } });
      const netBy = new Map<string, number>();
      for (const t of linked) netBy.set(t.accountId, round3((netBy.get(t.accountId) ?? 0) + t.amount));
      const nets = [...netBy].filter(([, net]) => net !== 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const held = round3(nets.reduce((s, [, net]) => s + net, 0));
      if (nets.length && held !== amount) {
        throw new ConflictException({
          message: `The accounts hold ${held.toFixed(3)} for ${invoiceNumber}, not the ${amount.toFixed(3)} it records as paid, so undoing it would leave the accounts out of step. Nothing was changed.`,
          code: 'LEDGER_MISMATCH',
        });
      }
      const accounts = this.accounts;
      if (nets.length && !accounts) throw new InternalServerErrorException('The accounts service is not available');

      await tx.invoice.update({ where: { id }, data: { status: 'ISSUED', paidAmount: 0, paidAt: null } });
      const after = Math.max(0, round3(before - amount));
      await tx.order.update({ where: { id: orderId }, data: { paidAmount: after } });

      // Into the account each payment actually sits in (not today's default), in accountId order.
      const entries: ReversalEntry[] = [];
      if (accounts) {
        for (const [accountId, net] of nets) {
          const e = await accounts.post({
            tx,
            accountId,
            amount: -net,
            type: 'ADJUSTMENT',
            description: `Payment undone: Invoice ${invoiceNumber} — ${reason} (${actor.name})`,
            reference: invoiceNumber,
            invoiceId: id,
            occurredAt: new Date(),
          });
          entries.push({ transactionId: e.id, accountId, amount: e.amount, balanceAfter: e.balanceAfter });
        }
      }

      await tx.auditLog.create({
        data: {
          userId: actor.id,
          action: PAYMENT_UNDONE,
          entityType: 'Invoice',
          entityId: id,
          details: {
            invoiceNumber, orderId, orderNumber: order.orderNumber, reason, amount,
            paidAtWas: inv.paidAt?.toISOString() ?? null,
            orderPaidAmount: { before, after },
            entries,
          } satisfies Prisma.InputJsonValue,
        },
      });

      const names = entries.length
        ? await tx.account.findMany({ where: { id: { in: entries.map((e) => e.accountId) } }, select: { id: true, name: true } })
        : [];
      const reversed: InvoicePaymentReversal = {
        amount,
        orderPaidAmount: after,
        entries: entries.map((e) => ({
          accountId: e.accountId,
          accountName: names.find((n) => n.id === e.accountId)?.name ?? '',
          amount: e.amount,
          balanceAfter: e.balanceAfter,
        })),
      };
      return { invoice: await tx.invoice.findUnique({ where: { id }, include: INVOICE_INCLUDE }), reversed };
    }, TX_OPTS);
  }

  /** The latest undo per invoice, from the audit rows unpay() writes. */
  private async latestUndos(ids: string[]): Promise<Map<string, InvoicePaymentUndo>> {
    const out = new Map<string, InvoicePaymentUndo>();
    if (!ids.length) return out;
    const rows = await this.prisma.auditLog.findMany({
      where: { entityType: 'Invoice', action: PAYMENT_UNDONE, entityId: { in: ids } },
      orderBy: { createdAt: 'desc' },
      select: { entityId: true, createdAt: true, details: true, user: { select: { name: true } } },
    });
    for (const r of rows) {
      if (!out.has(r.entityId)) out.set(r.entityId, { at: r.createdAt.toISOString(), by: r.user.name, reason: reasonOf(r.details) });
    }
    return out;
  }
}
