'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { ApiError, api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import type {
  JobStatus, LineOptionFields, LinePricingFields, OrderPrintFile, OrderStatus, OrderStockAllocation, Problem,
} from '@/lib/types/api';

/** One S4 line: stored fields plus the pair (effectiveOptions) and pricing fields. */
export interface OrderLine extends LineOptionFields, Partial<LinePricingFields> {
  id: string;
  productId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

export interface OrderInvoice {
  id: string;
  invoiceNumber: string;
  total: number;
  [key: string]: unknown;
}

/** GET /orders/:id (S4), the fields the order page reads. */
export interface OrderDetail {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  total: number;
  paidAmount: number;
  createdAt: string;
  customer: { id: string; name: string; phone?: string | null } | null;
  items: OrderLine[];
  materialAvailability?: Array<{
    materialId: string; name: string; type: string; color: string | null;
    gramsNeeded: number; totalStock: number; reservedStock: number; freeStock: number; hasEnoughStock: boolean;
  }>;
  partAvailability?: Array<{
    partId: string; name: string; sku: string | null;
    qtyNeeded: number; stockQty: number; reservedStock: number; freeStock: number; hasEnoughStock: boolean;
  }>;
  printFiles?: OrderPrintFile[];
  stockAllocations?: OrderStockAllocation[];
  invoices?: OrderInvoice[];
  productionJobs?: Array<{ id: string; name: string; status: JobStatus; printer?: { id: string; name: string } | null }>;
  warnings?: Problem[];
}

export function useOrder() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api.get<OrderDetail>(`/orders/${id}`)
      .then(setOrder)
      .catch((err: unknown) => {
        // 404 → order stays null → page.tsx calls notFound(); no toast needed
        if (err instanceof ApiError && err.status === 404) return;
        toast('error', (err instanceof Error && err.message) || 'Failed to load');
      })
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  return { id, order, loading, reload: load };
}
