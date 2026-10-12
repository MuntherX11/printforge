'use client';

import { useState } from 'react';
import { SliceRunStatus, type SliceRunDto } from '@printforge/types';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { LinkButton, errorText } from './options-ui';
import { retryRequestOf, runErrorText, runStatusChip, runUnitsText, sliceErrorText } from './slice-ui';
import { useSliceRuns } from './useSliceRuns';

interface Props {
  productId: string;
  componentId: string;
  /** The part has a source model: only then are runs fetched. */
  enabled: boolean;
  /** OPERATOR/ADMIN: Retry and Cancel. */
  canEdit: boolean;
  /** Changing it refetches (after queueing a run or replacing the source). */
  refreshKey: unknown;
  /** A run finished: the product is refetched so the new plate appears. */
  onDone: () => void;
}

const SHOWN = 5;

/**
 * The last slice runs of one part, newest first: a status chip, the units
 * asked for and sliced, the printer, the reason when it failed with Retry,
 * and Cancel while it is still queued. Live through the `slice-run` websocket
 * event with a 3 s poll while a run is active.
 */
export function SliceRunsRow({ productId, componentId, enabled, canEdit, refreshKey, onDone }: Props) {
  const { toast } = useToast();
  const { runs, error, refresh } = useSliceRuns(productId, componentId, enabled, refreshKey, onDone);
  const [busy, setBusy] = useState<string | null>(null);

  if (!enabled) return null;
  if (error && !runs) return <p className="text-xs text-red-600 dark:text-red-400">{error}</p>;
  if (!runs || runs.length === 0) return null;

  async function retry(run: SliceRunDto) {
    setBusy(run.id);
    try {
      await api.post<SliceRunDto>(`/products/${productId}/components/${componentId}/slice`, retryRequestOf(run));
      toast('success', `Queued ×${run.unitsRequested} again`);
      await refresh();
    } catch (err) {
      toast('error', sliceErrorText(err, 'Couldn\'t queue the slice'));
    } finally {
      setBusy(null);
    }
  }

  async function cancel(run: SliceRunDto) {
    setBusy(run.id);
    try {
      await api.delete(`/slice-runs/${run.id}`);
      toast('success', 'Slice cancelled');
      await refresh();
    } catch (err) {
      toast('error', errorText(err, 'Couldn\'t cancel the slice'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <ul className="divide-y divide-gray-100 rounded-md border border-gray-100 text-xs dark:divide-gray-800 dark:border-gray-800" aria-label="Slice runs">
      {runs.slice(0, SHOWN).map(run => {
        const chip = runStatusChip(run.status);
        const failed = run.status === SliceRunStatus.FAILED;
        return (
          <li key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5">
            <Badge variant={chip.variant}>{chip.text}</Badge>
            <span className="tabular-nums text-gray-700 dark:text-gray-300" title="Units requested → sliced">{runUnitsText(run)} units</span>
            <span className="text-gray-500 dark:text-gray-400">{run.printerName ?? '—'}</span>
            {failed && <span className="min-w-0 break-words text-red-600 dark:text-red-400">{runErrorText(run)}</span>}
            {canEdit && failed && (
              <LinkButton disabled={busy !== null} title={`Slice ×${run.unitsRequested} again`} onClick={() => void retry(run)}>
                {busy === run.id ? 'Queueing…' : 'Retry'}
              </LinkButton>
            )}
            {canEdit && run.status === SliceRunStatus.QUEUED && (
              <LinkButton tone="danger" disabled={busy !== null} title={`Cancel the ×${run.unitsRequested} slice`} onClick={() => void cancel(run)}>
                {busy === run.id ? 'Cancelling…' : 'Cancel'}
              </LinkButton>
            )}
          </li>
        );
      })}
    </ul>
  );
}
