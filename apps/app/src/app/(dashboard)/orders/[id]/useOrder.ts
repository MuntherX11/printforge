'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';

export function useOrder() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const [order, setOrder] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api.get(`/orders/${id}`)
      .then(setOrder)
      .catch((err: unknown) => {
        const msg = (err as Error)?.message || '';
        // 404 → order stays null → page.tsx calls notFound(); no toast needed
        if (!msg.includes('404')) {
          toast('error', msg || 'Failed to load');
        }
      })
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  return { id, order, loading, reload: load };
}
