'use client';

import { useEffect, useRef, useState } from 'react';
import { UNPAY_REASON_MAX, type InvoicePaymentReversal } from '@printforge/types';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { useFormatCurrency } from '@/lib/locale-context';
import { api, ApiError } from '@/lib/api';

/** The paid invoice being undone, as the Accounting invoice list has it. */
interface UndoInvoice {
  id: string;
  invoiceNumber: string;
  paidAmount: number;
  order?: { orderNumber?: string } | null;
}

interface UndoPaymentDialogProps {
  /** The invoice to undo; null keeps the dialog closed. */
  invoice: UndoInvoice | null;
  onClose(): void;
  /** After a successful undo: reload the list. */
  onUndone(): void;
}

/**
 * "Undo payment" (ADMIN, ACCOUNTING): a PAID invoice back to Issued, with a
 * required reason. A refusal (409: older figures that don't add up) replaces
 * the text with the server's reason and leaves only Close.
 */
export function UndoPaymentDialog({ invoice, onClose, onUndone }: UndoPaymentDialogProps) {
  return (
    <Dialog open={!!invoice} onClose={onClose} title="Undo payment">
      {/* The Dialog unmounts its children when closed, so every open starts fresh. */}
      {invoice && <UndoPaymentBody invoice={invoice} onClose={onClose} onUndone={onUndone} />}
    </Dialog>
  );
}

function UndoPaymentBody({ invoice, onClose, onUndone }: UndoPaymentDialogProps & { invoice: UndoInvoice }) {
  const { toast } = useToast();
  const formatCurrency = useFormatCurrency();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // A refusal swaps out the buttons: move focus to Close, after the reason (announced below).
  useEffect(() => {
    if (blocked) closeRef.current?.focus();
  }, [blocked]);

  const orderNumber = invoice.order?.orderNumber;

  async function submit() {
    setSaving(true);
    try {
      const { reversed } = await api.post<{ reversed: InvoicePaymentReversal }>(
        `/invoices/${invoice.id}/unpay`,
        { reason: reason.trim() },
      );
      onClose();
      toast(
        'success',
        reversed.entries.length
          ? `${invoice.invoiceNumber}: payment undone — ${formatCurrency(reversed.amount)} taken back out of ${reversed.entries.map((e) => e.accountName).join(', ')}`
          : `${invoice.invoiceNumber}: payment undone — no account entry needed reversing`,
      );
      onUndone();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 409) setBlocked(err.message);
      else toast('error', err instanceof Error ? err.message : 'Could not undo the payment');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 pt-2">
      <div className="space-y-2 text-sm text-gray-600 dark:text-gray-300" aria-live="polite">
        {blocked ? (
          <p>{blocked}</p>
        ) : (
          <>
            <p>{invoice.invoiceNumber} goes back to Issued and can be marked paid again later.</p>
            <p>
              {formatCurrency(invoice.paidAmount)} comes off what {orderNumber ? `order ${orderNumber}` : 'its order'} shows
              as paid, and back out of the account the payment was recorded in. The original payment stays in that
              account&apos;s history, with this reversal beside it.
            </p>
          </>
        )}
      </div>
      {!blocked && (
        <div>
          <Textarea
            label="Reason"
            required
            maxLength={UNPAY_REASON_MAX}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Marked paid by mistake — the transfer hasn't arrived"
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Shown under the invoice&apos;s status and kept in the audit log.
          </p>
        </div>
      )}
      <div className="flex gap-3 justify-end pt-2">
        {blocked ? (
          <Button key="close" ref={closeRef} variant="outline" onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button key="cancel" variant="outline" onClick={onClose}>Cancel</Button>
            <Button key="undo" variant="destructive" onClick={submit} disabled={saving || !reason.trim()}>
              {saving ? 'Undoing…' : 'Undo payment'}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
