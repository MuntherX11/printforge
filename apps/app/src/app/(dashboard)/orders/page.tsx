'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Loading } from '@/components/ui/loading';
import { EmptyState } from '@/components/ui/empty-state';
import { Pagination } from '@/components/ui/pagination';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { useFormatCurrency } from '@/lib/locale-context';
import { Plus, ShoppingCart } from 'lucide-react';

const statusFilters = ['ALL', 'PENDING', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'DELIVERED', 'CANCELLED'];

export default function OrdersPage() {
  const formatCurrency = useFormatCurrency();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('ALL');
  const [page, setPage] = useState(1);

  useEffect(() => {
    setLoading(true);
    setData(null);
    const params = new URLSearchParams({ page: String(page), limit: '25' });
    if (filter !== 'ALL') params.set('status', filter);
    api.get(`/orders?${params}`).then(setData).catch(console.error).finally(() => setLoading(false));
  }, [filter, page]);

  if (loading) return <Loading />;
  const orders = data?.data || data || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Orders</h1>
        <Link href="/orders/new"><Button><Plus className="h-4 w-4 mr-2" /> New Order</Button></Link>
      </div>

      <div className="flex gap-2 flex-wrap">
        {statusFilters.map(s => (
          <button
            key={s}
            onClick={() => { setFilter(s); setPage(1); }}
            className={`px-3 py-1 text-xs rounded-full border transition-colors ${
              filter === s ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
            }`}
          >
            {s.replace(/_/g, ' ')}
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          {orders.length === 0 ? (
            <EmptyState
              icon={<ShoppingCart className="h-12 w-12" />}
              title="No orders yet"
              description={filter === 'ALL' ? 'Create your first order to get started' : `no orders with status "${filter.replace(/_/g, ' ')}"`}
              action={filter === 'ALL' ? <Link href="/orders/new"><Button size="sm"><Plus className="h-4 w-4 mr-1" /> New Order</Button></Link> : undefined}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order #</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Paid</TableHead>
                  <TableHead>Due Date</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((o: any) => (
                  <TableRow key={o.id}>
                    <TableCell>
                      <Link href={`/orders/${o.id}`} className="font-medium text-brand-600 hover:underline">{o.orderNumber}</Link>
                    </TableCell>
                    <TableCell>{o.customer?.name || '-'}</TableCell>
                    <TableCell><StatusBadge status={o.status} /></TableCell>
                    <TableCell className="font-medium">{formatCurrency(o.total)}</TableCell>
                    <TableCell>{formatCurrency(o.paidAmount)}</TableCell>
                    <TableCell>{o.dueDate ? formatDate(o.dueDate) : '-'}</TableCell>
                    <TableCell>{formatDate(o.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Pagination page={page} totalPages={data?.totalPages ?? 1} onPageChange={setPage} />
    </div>
  );
}