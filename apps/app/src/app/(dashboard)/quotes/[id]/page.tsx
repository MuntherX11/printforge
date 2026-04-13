'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { formatDate, formatCurrency } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';

const quoteStatuses = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SENT', label: 'Sent' },
  { value: 'ACCEPTED', label: 'Accepted' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'EXPIRED', label: 'Expired' },
];

export default function QuoteDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const [quote, setQuote] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = () => api.get(`/quotes/${id}`).then(setQuote).catch(console.error).finally(() => setLoading(false));
  useEffect(() => { load(); }, [id]);

  async function updateStatus(status: string) {
    await api.patch(`/quotes/${id}`, { status });
    load();
  }

  async function convertToOrder(autoCreateJobs = true) {
    try {
      await api.post(`/quotes/${id}/convert`, { autoCreateJobs });
      router.push('/orders');
    } catch (err: any) {
      toast('error', err.message);
    }
  }

  if (loading) return <Loading />;
  if (!quote) return <div className="text-center py-12 text-gray-500">Quote not found</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{quote.quoteNumber}</h1>
          <p className="text-sm text-gray-500">{quote.customer?.name} | {formatDate(quote.createdAt)}</p>
        </div>
        <div className="flex gap-2">
          <Select options={quoteStatuses} value={quote.status} onChange={e => updateStatus(e.target.value)} className="w-36" />
          {['ACCEPTED', 'SENT'].includes(quote.status) && !quote.order && (
            <Button onClick={() => convertToOrder(true)}>Convert to Order + Create Jobs</Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Status</p><StatusBadge status={quote.status} /></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Total</p><p className="text-lg font-bold">{formatCurrency(quote.total)}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Valid Until</p><p className="text-lg font-bold">{quote.validUntil ? formatDate(quote.validUntil) : 'N/A'}</p></CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Items</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Description</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Unit Price</TableHead>
                <TableHead>Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(quote.items || []).map((item: any) => (
                <TableRow key={item.id}>
                  <TableCell>{item.description}</TableCell>
                  <TableCell>{item.quantity}</TableCell>
                  <TableCell>{formatCurrency(item.unitPrice)}</TableCell>
                  <TableCell className="font-medium">{formatCurrency(item.totalPrice)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {quote.order && (
        <Card>
          <CardContent className="p-4">
            <p className="text-sm">Converted to order: <a href={`/orders/${quote.order.id}`} className="text-brand-600 font-medium hover:underline">{quote.order.orderNumber}</a></p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}