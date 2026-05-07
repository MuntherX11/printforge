'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';

interface UseApiOptions<T> {
  /** If false, don't fetch on mount (call refetch() manually). Default: true */
  immediate?: boolean;
  /** Initial data value while loading */
  initialData?: T;
  /** Error message shown in toast on failure */
  errorMessage?: string;
}

interface UseApiResult<T> {
  data: T;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Minimal data-fetching hook that eliminates the useState/useEffect/toast
 * boilerplate repeated across 30+ pages.
 *
 * @example
 *   const { data: customers, loading } = useApi<ApiCustomer[]>('/customers', { initialData: [] });
 */
export function useApi<T>(
  url: string,
  options: UseApiOptions<T> = {},
): UseApiResult<T> {
  const { immediate = true, initialData, errorMessage } = options;
  const { toast } = useToast();
  const [data, setData] = useState<T>(initialData as T);
  const [loading, setLoading] = useState(immediate);
  const [error, setError] = useState<string | null>(null);
  // Track mount state to avoid setState on unmounted component
  const mountedRef = useRef(true);
  useEffect(() => { return () => { mountedRef.current = false; }; }, []);

  const fetch = useCallback(() => {
    setLoading(true);
    setError(null);
    api.get<T>(url)
      .then((result) => {
        if (!mountedRef.current) return;
        setData(result);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return;
        const msg = (err as Error)?.message || errorMessage || 'Failed to load';
        setError(msg);
        toast('error', msg);
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false);
      });
  }, [url]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (immediate) fetch();
  }, [fetch, immediate]);

  return { data, loading, error, refetch: fetch };
}
