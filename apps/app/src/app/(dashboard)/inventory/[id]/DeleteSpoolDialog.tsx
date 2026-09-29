'use client';

import { useEffect, useRef, useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';

interface DeleteSpoolDialogProps {
  /** The spool to delete; null keeps the dialog closed. */
  spoolId: string | null;
  /** Whether that spool is active, so a refused delete can offer Deactivate. */
  isActive: boolean;
  /** True while the page's Deactivate request is running. */
  deactivating: boolean;
  onClose(): void;
  /** After a successful delete: reload the filament. */
  onDeleted(): void;
  /** Deactivates the spool; true when it worked. */
  onDeactivate(spoolId: string): Promise<boolean>;
}

/** The server's refusal (409): its text, and whether Deactivate is the way out. */
interface DeleteBlock {
  message: string;
  canDeactivate: boolean;
}

/**
 * "Delete Spool" (admins only). A spool with job history, or on an active
 * job, is kept: the dialog then shows the server's reason and, for an active
 * spool with history, offers Deactivate instead.
 */
export function DeleteSpoolDialog({ spoolId, ...rest }: DeleteSpoolDialogProps) {
  return (
    <Dialog open={!!spoolId} onClose={rest.onClose} title="Delete Spool">
      {/* The Dialog unmounts its children when closed, so every open starts fresh. */}
      {spoolId && <DeleteSpoolBody spoolId={spoolId} {...rest} />}
    </Dialog>
  );
}

function DeleteSpoolBody({ spoolId, isActive, deactivating, onClose, onDeleted, onDeactivate }: DeleteSpoolDialogProps & { spoolId: string }) {
  const { toast } = useToast();
  const [deleting, setDeleting] = useState(false);
  const [block, setBlock] = useState<DeleteBlock | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // A refusal swaps out the Delete button that had focus: move focus to Cancel,
  // so it stays inside the dialog, after the reason (announced below).
  useEffect(() => {
    if (block) cancelRef.current?.focus();
  }, [block]);

  async function remove() {
    setDeleting(true);
    try {
      await api.delete(`/spools/${spoolId}`);
      onClose();
      onDeleted();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 409) {
        setBlock({ message: err.message, canDeactivate: err.code === 'SPOOL_HAS_HISTORY' && isActive });
      } else {
        toast('error', (err as Error).message);
      }
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-4 pt-2">
      <p className="text-sm text-gray-500" aria-live="polite">
        {block ? block.message : 'Permanently delete this spool? This cannot be undone.'}
      </p>
      <div className="flex gap-3 justify-end pt-2">
        <Button ref={cancelRef} variant="outline" onClick={onClose}>Cancel</Button>
        {!block ? (
          <Button key="delete" variant="destructive" onClick={remove} disabled={deleting}>
            {deleting ? 'Deleting...' : 'Delete Spool'}
          </Button>
        ) : block.canDeactivate && (
          <Button
            key="deactivate"
            variant="destructive"
            onClick={async () => { if (await onDeactivate(spoolId)) onClose(); }}
            disabled={deactivating}
          >
            {deactivating ? 'Deactivating...' : 'Deactivate Spool'}
          </Button>
        )}
      </div>
    </div>
  );
}
