'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SliceRunStatus, type SliceRunDto } from '@printforge/types';
import { api } from '@/lib/api';
import { useSocketEvent } from '@/lib/use-websocket';
import { RUN_POLL_MS, isFinishedStatus, partSliceStateOf, type PartSliceState, type SliceRunLiveEvent } from './slice-ui';

export interface PartSlices {
  /** 'slicing' while a run of the part is queued or running, 'failed' when its latest run failed, else null. */
  stateOf: (componentId: string) => PartSliceState | null;
  /** Ask for the latest run of these parts: one request per part, the first time it is named. */
  watch: (componentIds: readonly string[]) => void;
  /** A run of this part was queued or changed from this page: fetch its latest run again. */
  refresh: (componentId: string) => void;
}

/** While a part is slicing its state is checked this often, in case the websocket event never arrives. */
const WATCH_POLL_MS = RUN_POLL_MS * 2;

/**
 * The page's one `slice-run` subscription. It lives in the page, not in a part
 * row, so a finished slice reloads the product whichever rows, tabs or folded
 * sections are open: DONE brings the part's grams, minutes and price, FAILED
 * its "Slice failed" chip. It also keeps one small state per part (slicing,
 * failed) for the chip on a closed part row; the run list of an open row is
 * still useSliceRuns.
 */
export function usePartSlices(productId: string, onFinished: () => void): PartSlices {
  const [states, setStates] = useState<ReadonlyMap<string, PartSliceState | null>>(() => new Map());
  const statesRef = useRef(states);
  statesRef.current = states;
  const asked = useRef(new Set<string>());
  const seq = useRef(new Map<string, number>());
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const put = useCallback((componentId: string, state: PartSliceState | null) => {
    setStates(prev => {
      if (prev.has(componentId) && prev.get(componentId) === state) return prev;
      const next = new Map(prev);
      next.set(componentId, state);
      return next;
    });
  }, []);

  /** `announce`: a part seen slicing that no longer is has finished without an event reaching this page. */
  const fetchOne = useCallback(async (componentId: string, announce: boolean) => {
    const n = (seq.current.get(componentId) ?? 0) + 1;
    seq.current.set(componentId, n);
    try {
      const runs = await api.get<SliceRunDto[]>(`/products/${productId}/components/${componentId}/slice-runs`);
      if (seq.current.get(componentId) !== n) return;
      const next = partSliceStateOf(Array.isArray(runs) ? runs : []);
      const was = statesRef.current.get(componentId) ?? null;
      put(componentId, next);
      if (announce && was === 'slicing' && next !== 'slicing') onFinishedRef.current();
    } catch {
      // Not allowed to read runs, or offline: no chip. The part is not asked for again by `watch`.
    }
  }, [productId, put]);

  const watch = useCallback((componentIds: readonly string[]) => {
    for (const id of componentIds) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      void fetchOne(id, false);
    }
  }, [fetchOne]);

  const refresh = useCallback((componentId: string) => {
    asked.current.add(componentId);
    void fetchOne(componentId, false);
  }, [fetchOne]);

  useSocketEvent<SliceRunLiveEvent>('slice-run', ev => {
    if (ev.productId !== productId) return;
    asked.current.add(ev.componentId);
    if (!isFinishedStatus(ev.status)) {
      put(ev.componentId, 'slicing');
      return;
    }
    // DONE or FAILED: the part changed (or failed to). Reload the product and its cost now,
    // then settle the chip from the part's runs (another run of the part may still be going).
    put(ev.componentId, ev.status === SliceRunStatus.FAILED ? 'failed' : null);
    onFinishedRef.current();
    void fetchOne(ev.componentId, false);
  });

  const slicing = useMemo(() => [...states].filter(([, s]) => s === 'slicing').map(([id]) => id).sort().join(','), [states]);
  useEffect(() => {
    if (!slicing) return;
    const ids = slicing.split(',');
    const t = setInterval(() => { for (const id of ids) void fetchOne(id, true); }, WATCH_POLL_MS);
    return () => clearInterval(t);
  }, [slicing, fetchOne]);

  const stateOf = useCallback((componentId: string) => states.get(componentId) ?? null, [states]);
  return useMemo(() => ({ stateOf, watch, refresh }), [stateOf, watch, refresh]);
}
