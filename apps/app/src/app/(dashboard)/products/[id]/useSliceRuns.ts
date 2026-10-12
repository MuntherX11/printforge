'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SliceRunStatus, type SliceRunDto } from '@printforge/types';
import { api } from '@/lib/api';
import { useSocketEvent } from '@/lib/use-websocket';
import { errorText } from './options-ui';
import { RUN_POLL_MS, anyActiveRun, applyRunEvent, runJustFinished, type SliceRunLiveEvent } from './slice-ui';

export interface SliceRuns {
  /** Newest first; null until the first load (or while disabled). */
  runs: SliceRunDto[] | null;
  error: string | null;
  /** A run is queued or slicing. */
  active: boolean;
  refresh: () => Promise<void>;
}

/**
 * GET …/slice-runs of one part, kept current: the `slice-run` websocket event
 * updates a known run in place (an unknown id refetches) and, when it ends the
 * run (DONE or FAILED), refetches the list once so the row shows the units
 * sliced; while any run is queued or slicing the list is polled every 3 s as a
 * fallback. A run that
 * turns DONE calls `onDone` once, so the page refetches the product and the
 * new plate appears. `refreshKey` forces a refetch (after queueing a run or
 * replacing the source).
 */
export function useSliceRuns(productId: string, componentId: string, enabled: boolean, refreshKey: unknown, onDone: () => void): SliceRuns {
  const [runs, setRuns] = useState<SliceRunDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  /** Last status seen per run id: a DONE that follows anything else reloads the product. */
  const seen = useRef(new Map<string, SliceRunDto['status']>());

  const noteStatuses = useCallback((rows: ReadonlyArray<Pick<SliceRunDto, 'id' | 'status'>>) => {
    let finished = false;
    for (const r of rows) {
      const prev = seen.current.get(r.id);
      if (r.status === SliceRunStatus.DONE && prev !== undefined && prev !== SliceRunStatus.DONE) finished = true;
      seen.current.set(r.id, r.status);
    }
    if (finished) onDoneRef.current();
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const n = ++seq.current;
    try {
      const list = await api.get<SliceRunDto[]>(`/products/${productId}/components/${componentId}/slice-runs`);
      if (n !== seq.current) return;
      const rows = Array.isArray(list) ? list : [];
      noteStatuses(rows);
      setRuns(rows);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setError(errorText(err, 'Couldn\'t load the slice runs'));
    }
  }, [enabled, productId, componentId, noteStatuses]);

  useEffect(() => {
    if (!enabled) { setRuns(null); return; }
    void refresh();
    // refreshKey is a deliberate extra trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, refresh, refreshKey]);

  const active = anyActiveRun(runs);
  useEffect(() => {
    if (!enabled || !active) return;
    const t = setInterval(() => void refresh(), RUN_POLL_MS);
    return () => clearInterval(t);
  }, [enabled, active, refresh]);

  const runsRef = useRef(runs);
  runsRef.current = runs;

  useSocketEvent<SliceRunLiveEvent>('slice-run', ev => {
    if (!enabled || ev.componentId !== componentId) return;
    const current = runsRef.current;
    const applied = current ? applyRunEvent(current, ev) : null;
    if (applied?.known) setRuns(applied.runs);
    const finished = runJustFinished(seen.current.get(ev.id), ev.status);
    noteStatuses([{ id: ev.id, status: ev.status }]);
    // A run this list has not seen (queued elsewhere), no list yet, or a run
    // that just ended (its units sliced come with the list): fetch it, once.
    if (!applied?.known || finished) void refresh();
  });

  return { runs, error, active, refresh };
}
