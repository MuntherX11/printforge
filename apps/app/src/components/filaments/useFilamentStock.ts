'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { FilamentStockRow } from '@/lib/types/api';

export interface FilamentStock {
  /** Every filament with its active-spool grams; null until the first load (or while disabled). */
  rows: FilamentStockRow[] | null;
  loading: boolean;
  /** The last load's error. Rows already loaded are kept. */
  error: string | null;
  refresh: () => void;
}

/**
 * GET /materials/stock, loaded while `enabled` and again whenever `refreshKey`
 * changes. A newer request makes older responses stale; a failed refresh keeps
 * the rows already shown. Disabled, it never fetches.
 */
export function useFilamentStock(enabled: boolean, refreshKey: unknown): FilamentStock {
  const [rows, setRows] = useState<FilamentStockRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(() => {
    if (!enabled) return;
    const n = ++seq.current;
    setLoading(true);
    api.get<FilamentStockRow[]>('/materials/stock')
      .then((r) => {
        if (n !== seq.current) return;
        setRows(Array.isArray(r) ? r : []);
        setError(null);
      })
      .catch((err: unknown) => {
        if (n !== seq.current) return;
        setError(err instanceof Error && err.message ? err.message : 'Couldn\'t load filaments');
      })
      .finally(() => {
        if (n === seq.current) setLoading(false);
      });
  }, [enabled]);

  useEffect(refresh, [refresh, refreshKey]);

  // Ignore a response that lands after unmount.
  useEffect(() => () => { seq.current += 1; }, []);

  return { rows: enabled ? rows : null, loading, error, refresh };
}
