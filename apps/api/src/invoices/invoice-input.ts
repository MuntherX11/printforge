import { BadRequestException } from '@nestjs/common';
import { allowedBody } from '../common/utils/validate-number';

export const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'PAID', 'OVERDUE', 'CANCELLED'] as const;
export type InvoiceStatusValue = (typeof INVOICE_STATUSES)[number];

/**
 * Allowlist parser for PATCH /invoices/:id.
 *
 * UpdateInvoiceDto is an interface the global ValidationPipe can't whitelist,
 * and update() wrote dto.paidAmount as sent: any number, a negative one, or a
 * Prisma operation such as {"increment": n}, none of it posted to the ledger
 * or the order, while the revenue reports sum Invoice.paidAmount. paidAmount
 * is now set only by marking the invoice PAID (to its total), so it is not
 * accepted here. `status` must be an InvoiceStatus and `paidAt` a date (the
 * payment date, only together with status PAID). Any other key → 400.
 * InvoicesService.update checks the move itself: PAID and CANCELLED are final.
 */
export const INVOICE_PATCH_KEYS = ['status', 'paidAt'] as const;

export interface InvoicePatchInput {
  status?: InvoiceStatusValue;
  paidAt?: Date;
}

/** A payment date may be up to a day ahead: a date-only value typed in a timezone ahead of UTC. */
const PAID_AT_AHEAD_MS = 24 * 60 * 60 * 1000;

export function parseInvoicePatch(raw: unknown, now: Date = new Date()): InvoicePatchInput {
  const b = allowedBody(raw, INVOICE_PATCH_KEYS);
  const out: InvoicePatchInput = {};
  if (b.status !== undefined) {
    if (typeof b.status !== 'string' || !(INVOICE_STATUSES as readonly string[]).includes(b.status)) {
      throw new BadRequestException(`"status" must be one of: ${INVOICE_STATUSES.join(', ')}`);
    }
    out.status = b.status as InvoiceStatusValue;
  }
  if (b.paidAt !== undefined) {
    const date = typeof b.paidAt === 'string' && b.paidAt.trim() ? new Date(b.paidAt) : null;
    if (!date || Number.isNaN(date.getTime())) throw new BadRequestException('"paidAt" must be a date');
    if (date.getTime() > now.getTime() + PAID_AT_AHEAD_MS) throw new BadRequestException('"paidAt" can\'t be in the future');
    if (out.status !== 'PAID') throw new BadRequestException('"paidAt" can only be sent with status PAID');
    out.paidAt = date;
  }
  return out;
}
