'use client';

import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  /** Red confirm button for irreversible actions. */
  destructive?: boolean;
  /** The confirm action is running: both buttons are disabled. */
  busy?: boolean;
  /** Server error from the last attempt, shown verbatim. */
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

/** Shared confirm used across the product page (spec §5.1). */
export function ConfirmDialog({
  open, title, message, confirmLabel, destructive, busy, error, onConfirm, onClose,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={busy ? () => undefined : onClose} title={title}>
      <div className="space-y-4">
        <div className="text-sm text-gray-600 dark:text-gray-300">{message}</div>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            type="button"
            variant={destructive ? 'destructive' : 'primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
