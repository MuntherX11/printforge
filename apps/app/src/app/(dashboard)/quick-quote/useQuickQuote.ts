'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';

export function useQuickQuote() {
  const [materials, setMaterials] = useState<any[]>([]);
  const [printers, setPrinters] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    Promise.all([
      api.get<any>('/materials').then(r => r.data || r),
      api.get<any[]>('/printers'),
      api.get<any>('/customers').then(r => r.data || r).catch(() => []),
    ])
      .then(([mats, prts, custs]) => {
        setMaterials(Array.isArray(mats) ? mats : []);
        setPrinters(prts);
        setCustomers(Array.isArray(custs) ? custs : []);
      })
      .catch((err: any) => toast('error', err?.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  return { materials, printers, customers, loading };
}
