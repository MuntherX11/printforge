'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Loading } from '@/components/ui/loading';
import { EmptyState } from '@/components/ui/empty-state';
import { api } from '@/lib/api';
import { useFormatCurrency } from '@/lib/locale-context';
import { Plus, FileText } from 'lucide-react';

export default function QuotesPage() {
  const formatCurrency = useFormatCurrency();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/quotes').then(setData).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading />;
  const quotes = data?.data || data || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Quotes</h1>
        <Link href="/quotes/new"><Button><Plus className="h-4 w-4 mr-2" /> New Quote</Button></Link>
      </div>

      <Card>
        <CardContent className="p-0">
          {quotes.length === 0 ? (
            <EmptyState
              icon={<FileText className="h-12 w-12" />}
              title="No quotes yet"
              description="Create your first quote to send to a customer"
              action={<Link href="/quotes/new"><Button size="sm"><Plus className="h-4 w-4 mr-1" /> New Quote</Button></Link>}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Quote #</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Valid Until</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {quotes.map((q: any) => (
                  <TableRow key={q.id}>
                    <TableCell>
                      <Link href={`/quotes/${q.id}`} className="font-medium text-brand-600 hover:underline">{q.quoteNumber}</Link>
                    </TableCell>
                    <TableCell>{q.customer?.name || '-'}</TableCell>
                    <TableCell><StatusBadge status={q.status} /></TableCell>
                    <TableCell className="font-medium">{formatCurrency(q.total)}</TableCell>
                    <TableCell>{q.validUntil ? formatDate(q.validUntil) : '-'}</TableCell>
                    <TableCell>{formatDate(q.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}