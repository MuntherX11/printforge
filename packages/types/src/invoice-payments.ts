/**
 * Undo payment (POST /invoices/:id/unpay): the body, what the reversal did,
 * and the last-undo note the Accounting invoice list shows under a status.
 *
 * Pure: the api parses the body against UNPAY_REASON_MAX and the app's dialog
 * caps its textarea at the same length.
 */

/** A reason longer than this is refused (400), never cut short. */
export const UNPAY_REASON_MAX = 200;

export interface UnpayInvoiceDto {
  reason: string;
}

/** One ADJUSTMENT posted by the undo, in the account the payment sat in. */
export interface InvoicePaymentReversalEntry {
  accountId: string;
  accountName: string;
  /** Negative: the amount taken back out of the account. */
  amount: number;
  balanceAfter: number;
}

export interface InvoicePaymentReversal {
  /** The invoice's paid amount that was undone. */
  amount: number;
  /** The order's paidAmount after the undo. */
  orderPaidAmount: number;
  /** Empty when no account entry needed reversing (none was ever posted, or a 0.000 invoice). */
  entries: InvoicePaymentReversalEntry[];
}

/** The latest undo of an invoice's payment: when (ISO), who (their name) and why. */
export interface InvoicePaymentUndo {
  at: string;
  by: string;
  reason: string;
}
