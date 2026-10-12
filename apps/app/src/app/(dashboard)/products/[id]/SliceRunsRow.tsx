'use client';

import { useId, useState } from 'react';
import { SliceRunStatus, type SliceRunDto } from '@printforge/types';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { LinkButton, errorText } from './options-ui';
import { retryRequestOf, runFailure, runStatusChip, runUnitsText, sliceErrorText, visibleRuns } from './slice-ui';
import { useSliceRuns } from './useSliceRuns';

interface Props {
  productId: string;
  componentId: string;
  /** The part has a source model: only then are runs fetched. */
  enabled: boolean;
  /** OPERATOR/ADMIN: Retry, Cancel and Dismiss. */
  canEdit: boolean;
  /** Changing it refetches (after queueing a run or replacing the source). */
  refreshKey: unknown;
  /** A run finished: the product is refetched so the new plate appears. */
  onDone: () => void;
  /** A run was cancelled or dismissed here: the part's chip on the closed row is settled again. */
  onRemoved?: () => void;
}

/** The slicer's raw output of a failed run, behind a toggle. */
function FailureDetail({ detail }: { detail: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button type="button" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(o => !o)}
        className="rounded px-1 text-xs font-medium text-gray-600 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-gray-400">
        Details
      </button>
      {open && (
        <pre id={id} className="max-h-48 w-full overflow-auto whitespace-pre-wrap break-words rounded bg-gray-50 p-2 font-mono text-[11px] leading-snug text-gray-700 dark:bg-gray-800 dark:text-gray-300">
          {detail}
        </pre>
      )}
    </>
  );
}

/**
 * The last slice runs of one part, newest first: a status chip, the units
 * asked for and sliced, the printer, the reason when it failed (one sentence;
 * the slicer's own output behind Details) with Retry and Dismiss, and Cancel
 * while it is still queued. A failure that a later run on the same printer
 * overcame is not listed. Live through the `slice-run` websocket
 * event with a 3 s poll while a run is active.
 */
export function SliceRunsRow({ productId, componentId, enabled, canEdit, refreshKey, onDone, onRemoved }: Props) {
  const { toast } = useToast();
  const { runs, error, refresh } = useSliceRuns(productId, componentId, enabled, refreshKey, onDone);
  const [busy, setBusy] = useState<string | null>(null);

  if (!enabled) return null;
  if (error && !runs) return <p className="text-xs text-red-600 dark:text-red-400">{error}</p>;
  const shown = runs ? visibleRuns(runs) : [];
  if (shown.length === 0) return null;

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

  /** DELETE /slice-runs/:id: cancels a queued run, dismisses a failed one. */
  async function remove(run: SliceRunDto, done: string, failed: string) {
    setBusy(run.id);
    try {
      await api.delete(`/slice-runs/${run.id}`);
      toast('success', done);
      await refresh();
      onRemoved?.();
    } catch (err) {
      toast('error', errorText(err, failed));
    } finally {
      setBusy(null);
    }
  }

  return (
    <ul className="divide-y divide-gray-100 rounded-md border border-gray-100 text-xs dark:divide-gray-800 dark:border-gray-800" aria-label="Slice runs">
      {shown.map(run => {
        const chip = runStatusChip(run.status);
        const failed = run.status === SliceRunStatus.FAILED;
        const failure = failed ? runFailure(run) : null;
        return (
          <li key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5">
            <Badge variant={chip.variant}>{chip.text}</Badge>
            <span className="tabular-nums text-gray-700 dark:text-gray-300" title="Units requested → sliced">{runUnitsText(run)} units</span>
            <span className="text-gray-500 dark:text-gray-400">{run.printerName ?? '—'}</span>
            {failure && <span className="min-w-0 break-words text-red-600 dark:text-red-400">{failure.text}</span>}
            {canEdit && failed && (
              <LinkButton disabled={busy !== null} title={`Slice ×${run.unitsRequested} again`} onClick={() => void retry(run)}>
                {busy === run.id ? 'Queueing…' : 'Retry'}
              </LinkButton>
            )}
            {canEdit && failed && (
              <LinkButton disabled={busy !== null} title={`Remove the failed ×${run.unitsRequested} slice from this list`}
                onClick={() => void remove(run, 'Failed slice dismissed', 'Couldn\'t dismiss the slice')}>
                Dismiss
              </LinkButton>
            )}
            {canEdit && run.status === SliceRunStatus.QUEUED && (
              <LinkButton tone="danger" disabled={busy !== null} title={`Cancel the ×${run.unitsRequested} slice`}
                onClick={() => void remove(run, 'Slice cancelled', 'Couldn\'t cancel the slice')}>
                {busy === run.id ? 'Cancelling…' : 'Cancel'}
              </LinkButton>
            )}
            {failure?.detail && <FailureDetail detail={failure.detail} />}
          </li>
        );
      })}
    </ul>
  );
}
