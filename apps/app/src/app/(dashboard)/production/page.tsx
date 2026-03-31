'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { formatDate, formatCurrency } from '@/lib/utils';
import { Plus } from 'lucide-react';

const statusFilters = ['ALL', 'QUEUED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'];

export default function ProductionPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('ALL');

  useEffect(() => {
    const params = filter !== 'ALL' ? `?status=${filter}` : '';
    api.get(`/jobs${params}`).then(setData).catch(console.error).finally(() => setLoading(false));
  }, [filter]);

  if (loading) return <Loading />;
  const jobs = data?.data || data || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Production</h1>
        <Link href="/production/new"><Button><Plus className="h-4 w-4 mr-2" /> New Job</Button></Link>
      </div>

      <div className="flex gap-2 flex-wrap">
        {statusFilters.map(s => (
          <button key={s} onClick={() => { setFilter(s); setLoading(true); }}
            className={`px-3 py-1 text-xs rounded-full border transition-colors ${filter === s ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}>
            {s.replace(/_/g, ' ')}
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job Name</TableHead>
                <TableHead>Printer</TableHead>
                <TableHead>Assigned To</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((j: any) => (
                <TableRow key={j.id}>
                  <TableCell>
                    <Link href={`/production/${j.id}`} className="font-medium text-brand-600 hover:underline">{j.name}</Link>
                  </TableCell>
                  <TableCell>{j.printer?.name || '-'}</TableCell>
                  <TableCell>{j.assignedTo?.name || '-'}</TableCell>
                  <TableCell>{j.order ? <Link href={`/orders/${j.order.id}`} className="text-brand-600 hover:underline">{j.order.orderNumber}</Link> : '-'}</TableCell>
                  <TableCell><StatusBadge status={j.status} /></TableCell>
                  <TableCell>{j.totalCost ? formatCurrency(j.totalCost) : '-'}</TableCell>
                  <TableCell>{formatDate(j.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
