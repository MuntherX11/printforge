'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CreateOrderPlateDto, OrderPlanJobsResult, OrderPlateEvent, OrderPrintPlanDto, UpdateOrderPlateDto,
} from '@printforge/types';
import { ApiError, api } from '@/lib/api';
import { useSocketEvent } from '@/lib/use-websocket';
import { RUN_POLL_MS, sliceErrorText } from '../../products/[id]/slice-ui';
import { anySlicing, applyPlateEvent } from './print-plan-model';

export interface OrderPrintPlan {
  /** Null until the first load, and when the order has no print plan route (older API). */
  plan: OrderPrintPlanDto | null;
  /** The first load is running. */
  loading: boolean;
  /** Why the plan could not be loaded; null when it was, or when there is none to load. */
  error: string | null;
  /** The action that is running ('suggest', 'slice-all', 'jobs', 'create', or a plate id); null when idle. */
  busy: string | null;
  /** At least one plate has a file, so there is something for "Download all". */
  zipAvailable: boolean;
  refresh: () => Promise<void>;
  suggest: () => Promise<void>;
  createPlate: (dto: CreateOrderPlateDto) => Promise<void>;
  updatePlate: (plateId: string, dto: UpdateOrderPlateDto) => Promise<void>;
  deletePlate: (plateId: string) => Promise<void>;
  sliceAll: () => Promise<void>;
  slicePlate: (plateId: string) => Promise<void>;
  createJobs: () => Promise<OrderPlanJobsResult>;
}

/** The download of one plate's file, and of every file of the order. */
export const plateFileUrl = (plateId: string) => `/api/order-plates/${encodeURIComponent(plateId)}/file`;
export const planZipUrl = (orderId: string) => `/api/orders/${encodeURIComponent(orderId)}/print-plan/files.zip`;

/** An answer with no body (204) is a success, not a failure. */
async function send(call: Promise<unknown>): Promise<void> {
  try {
    await call;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
  }
}

/** What a failed action says: the server's sentence, else `fallback`. */
export const planErrorText = (err: unknown, fallback: string) => sliceErrorText(err, fallback);

/**
 * GET /orders/:id/print-plan, kept current: the `order-plate` websocket event
 * updates the plate's chip at once and refetches the plan (the file, the
 * numbers and the exact drawing come with it); while a plate is queued or
 * slicing the plan is also polled every 3 s as a fallback. Every action
 * refetches when it ends, also when it failed (a 409 means the plan moved on).
 * A 404 on the plan itself reads as "no print plan here" and shows nothing.
 */
export function useOrderPrintPlan(orderId: string): OrderPrintPlan {
  const [plan, setPlan] = useState<OrderPrintPlanDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const n = ++seq.current;
    try {
      const res = await api.get<OrderPrintPlanDto>(`/orders/${orderId}/print-plan`);
      if (n !== seq.current) return;
      setPlan(res && Array.isArray(res.plates) && Array.isArray(res.needs) ? res : null);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      if (err instanceof ApiError && err.status === 404) { setPlan(null); setError(null); return; }
      setError(planErrorText(err, 'Couldn\'t load the print files'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    setPlan(null);
    setLoading(true);
    void refresh();
  }, [refresh]);

  const slicing = anySlicing(plan);
  useEffect(() => {
    if (!slicing) return;
    const t = setInterval(() => void refresh(), RUN_POLL_MS);
    return () => clearInterval(t);
  }, [slicing, refresh]);

  // Several plates can change in one tick: one refetch covers them.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current); }, []);

  useSocketEvent<OrderPlateEvent>('order-plate', ev => {
    if (!ev || ev.orderId !== orderId) return;
    setPlan(prev => (prev ? applyPlateEvent(prev, ev).plan : prev));
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => { pending.current = null; void refresh(); }, 250);
  });

  // The zip route always exists: "Download all" whenever a plate has a file.
  const hasFiles = !!plan?.plates.some(p => p.hasFile);

  const act = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T> => {
    setBusy(key);
    try {
      return await fn();
    } finally {
      await refresh();
      setBusy(null);
    }
  }, [refresh]);

  const plates = `/orders/${orderId}/print-plan`;
  return {
    plan,
    loading,
    error,
    busy,
    zipAvailable: hasFiles,
    refresh,
    // The answer is the fresh plan: shown at once (the refetch that follows returns the same).
    suggest: () => act('suggest', async () => {
      const fresh = await api.post<OrderPrintPlanDto>(`${plates}/suggest`);
      if (fresh && Array.isArray(fresh.plates) && Array.isArray(fresh.needs)) { seq.current++; setPlan(fresh); setError(null); }
    }),
    createPlate: dto => act('create', () => send(api.post(`${plates}/plates`, dto))),
    updatePlate: (plateId, dto) => act(plateId, () => send(api.patch(`/order-plates/${plateId}`, dto))),
    deletePlate: plateId => act(plateId, () => send(api.delete(`/order-plates/${plateId}`))),
    sliceAll: () => act('slice-all', () => send(api.post(`${plates}/slice`))),
    slicePlate: plateId => act(plateId, () => send(api.post(`/order-plates/${plateId}/slice`))),
    createJobs: () => act('jobs', () => api.post<OrderPlanJobsResult>(`${plates}/jobs`)),
  };
}
