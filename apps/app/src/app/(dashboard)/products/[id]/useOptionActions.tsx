'use client';

import { useState } from 'react';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { ApiOptionHistory, ApiOptionRow, ColourOptionDetail, ProductDetail, SizeOptionDetail } from '@/lib/types/api';
import { ConfirmDialog } from './ConfirmDialog';
import { errorText } from './options-ui';
import { isLastActive, lastOfAxisText, orderedColours, orderedSizes, reorder, type OptionKind } from './options-model';

type Option = SizeOptionDetail | ColourOptionDetail;

interface Pending {
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  run: () => Promise<void>;
}

/**
 * Row actions shared by the Sizes and Colours tables (spec §5.2 C, §3.10):
 * move up/down (O2 `sortOrder`), activate/deactivate (O2 `isActive`, with the
 * last-of-axis confirm), and delete (ADMIN, O3 history first; with history the
 * only offer is Deactivate — options with history are never hard-deleted).
 */
export function useOptionActions(product: ProductDetail, onChanged: () => void) {
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const base = `/products/${product.id}/variants`;

  async function patch(option: Option, body: { isActive?: boolean; sortOrder?: number }) {
    await api.patch<ApiOptionRow>(`${base}/${option.id}`, body);
  }

  async function move(kind: OptionKind, option: Option, dir: -1 | 1) {
    const list: Option[] = kind === 'SIZE' ? orderedSizes(product) : orderedColours(product);
    const next = reorder(list, option.id, dir);
    if (!next) return;
    setBusyId(option.id);
    try {
      // Renumber the whole kind 0..n-1 so equal sort orders can't hide a move; only changed rows are written.
      for (let i = 0; i < next.length; i++) {
        if (next[i].sortOrder !== i) await patch(next[i], { sortOrder: i });
      }
      onChanged();
    } catch (err) {
      toast('error', errorText(err, 'Reorder failed'));
      onChanged();
    } finally {
      setBusyId(null);
    }
  }

  async function writeActive(option: Option, isActive: boolean) {
    await patch(option, { isActive });
    toast('success', `${option.name} ${isActive ? 'activated' : 'deactivated'}`);
    onChanged();
  }

  function setActive(kind: OptionKind, option: Option, isActive: boolean) {
    if (!isActive && isLastActive(product, kind, option.id)) {
      setConfirmError(null);
      setPending({
        title: `Deactivate ${option.name}?`,
        message: <p>{lastOfAxisText(product, kind)}</p>,
        confirmLabel: 'Deactivate',
        run: () => writeActive(option, false),
      });
      return;
    }
    setBusyId(option.id);
    writeActive(option, isActive)
      .catch(err => toast('error', errorText(err, 'Save failed')))
      .finally(() => setBusyId(null));
  }

  function deactivateOffer(kind: OptionKind, option: Option, reason: string) {
    const last = option.isActive && isLastActive(product, kind, option.id);
    setPending({
      title: `Can't delete ${option.name}`,
      message: (
        <div className="space-y-2">
          <p>{reason}</p>
          {option.isActive
            ? <p>Deactivating hides it from new orders, quotes, jobs and the shop, and keeps its history. {last ? lastOfAxisText(product, kind) : ''}</p>
            : <p>It is already inactive.</p>}
        </div>
      ),
      confirmLabel: 'Deactivate',
      run: async () => { if (option.isActive) await writeActive(option, false); },
    });
  }

  async function remove(kind: OptionKind, option: Option) {
    setBusyId(option.id);
    setConfirmError(null);
    try {
      const h = await api.get<ApiOptionHistory>(`${base}/${option.id}/history`);
      if (!h.canDelete) {
        const reason = h.orderLines + h.quoteLines + h.jobs > 0
          ? `"${option.name}" has been ordered, quoted or produced (${h.orderLines} order lines, ${h.quoteLines} quote lines, ${h.jobs} jobs) — deactivate it instead.`
          : `"${option.name}" has printed stock records — deactivate it instead.`;
        deactivateOffer(kind, option, reason);
        return;
      }
      setPending({
        title: `Delete ${option.name}?`,
        message: kind === 'SIZE'
          ? <p>This permanently deletes the size &quot;{option.name}&quot; with its components, plate layouts, bulk tiers and unused files. It has never been ordered, quoted or produced.</p>
          : <p>This permanently deletes the colour &quot;{option.name}&quot; and its filament choices. It has never been ordered, quoted or produced. Printed stock is not touched.</p>,
        confirmLabel: 'Delete permanently',
        destructive: true,
        run: async () => {
          try {
            await api.delete(`${base}/${option.id}`);
            toast('success', `${option.name} deleted`);
            onChanged();
          } catch (err) {
            // History can appear between the check and the delete: surface the 409 and offer Deactivate.
            deactivateOffer(kind, option, errorText(err, 'Delete failed'));
            throw new Error('__handled__');
          }
        },
      });
    } catch (err) {
      toast('error', errorText(err, "Couldn't check the history"));
    } finally {
      setBusyId(null);
    }
  }

  async function confirm() {
    if (!pending) return;
    const current = pending;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      await current.run();
      setPending(p => (p === current ? null : p));
    } catch (err) {
      if (!(err instanceof Error && err.message === '__handled__')) setConfirmError(errorText(err, 'Failed'));
    } finally {
      setConfirmBusy(false);
    }
  }

  const confirmNode = (
    <ConfirmDialog
      open={!!pending}
      title={pending?.title ?? ''}
      message={pending?.message ?? null}
      confirmLabel={pending?.confirmLabel ?? 'OK'}
      destructive={pending?.destructive}
      busy={confirmBusy}
      error={confirmError}
      onConfirm={() => void confirm()}
      onClose={() => { setPending(null); setConfirmError(null); }}
    />
  );

  return { busyId, move, setActive, remove, confirmNode };
}
