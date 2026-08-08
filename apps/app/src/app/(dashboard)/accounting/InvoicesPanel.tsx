'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { useFormatCurrency } from '@/lib/locale-context';
import { FileText, Download, CheckCircle } from 'lucide-react';

interface Invoice {
  id: string;
  invoiceNumber: string;
  status: 'DRAFT' | 'SENT' | 'PAID' | 'OVERDUE' | 'CANCELLED';
  total: number;
  paidAmount: number;
  issuedAt?: string | null;
  dueDate?: string | null;
  paidAt?: string | null;
  createdAt: string;
  order?: { id: string; orderNumber?: string; customer?: { id: string; name: string } | null } | null;
}

const STATUS_STYLE: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  SENT: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  PAID: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  OVERDUE: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  CANCELLED: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
};

/** Invoices had no list view at all — this is the missing window onto them. */
export function InvoicesPanel() {
  const { toast } = useToast();
  const formatCurrency = useFormatCurrency();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [marking, setMarking] = useState<string | null>(null);

  function load() {
    api.get<any>('/invoices?limit=100')
      .then((r) => setInvoices(Array.isArray(r) ? r : (r?.data ?? [])))
      .catch((err: any) => toast('error', err?.message || 'Could not load invoices'))
      .finally(() => setLoading(false));
  }
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function markPaid(inv: Invoice) {
    if (!confirm(`Mark ${inv.invoiceNumber} as paid? This credits your default account with ${formatCurrency(inv.total)}.`)) return;
    setMarking(inv.id);
    try {
      await api.patch(`/invoices/${inv.id}`, { status: 'PAID' });
      toast('success', `${inv.invoiceNumber} marked paid — account credited`);
      load();
    } catch (err: any) {
      toast('error', err?.message || 'Could not mark paid');
    } finally {
      setMarking(null);
    }
  }

  const shown = filter ? invoices.filter((i) => i.status === filter) : invoices;
  const outstanding = invoices
    .filter((i) => i.status !== 'PAID' && i.status !== 'CANCELLED')
    .reduce((s, i) => s + (i.total - i.paidAmount), 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4" /> Invoices
            {outstanding > 0 && (
              <span className="ml-2 text-sm font-normal text-amber-600 dark:text-amber-400">
                {formatCurrency(outstanding)} outstanding
              </span>
            )}
          </CardTitle>
          <div className="w-44">
            <Select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              options={[
                { value: '', label: 'All statuses' },
                { value: 'DRAFT', label: 'Draft' },
                { value: 'SENT', label: 'Sent' },
                { value: 'PAID', label: 'Paid' },
                { value: 'OVERDUE', label: 'Overdue' },
                { value: 'CANCELLED', label: 'Cancelled' },
              ]}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <p className="py-8 text-center text-sm text-gray-500">Loading…</p>
        ) : shown.length === 0 ? (
          <div className="py-10 text-center text-gray-500 dark:text-gray-400">
            <FileText className="h-10 w-10 mx-auto mb-2 opacity-30" />
            <p className="text-sm font-medium">
              {invoices.length === 0 ? 'No invoices yet' : 'None with that status'}
            </p>
            {invoices.length === 0 && (
              <p className="text-xs mt-1">Invoices are raised from an order&apos;s detail page.</p>
            )}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Issued</TableHead>
                <TableHead>Due</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell className="font-medium dark:text-gray-100">{inv.invoiceNumber}</TableCell>
                  <TableCell className="text-gray-600 dark:text-gray-400">
                    {inv.order?.customer?.name ? (
                      <Link href={`/customers/${inv.order.customer.id}`} className="text-brand-600 hover:underline">
                        {inv.order.customer.name}
                      </Link>
                    ) : '—'}
                  </TableCell>
                  <TableCell className="text-gray-500 text-sm">
                    {inv.issuedAt ? new Date(inv.issuedAt).toLocaleDateString() : '—'}
                  </TableCell>
                  <TableCell className="text-gray-500 text-sm">
                    {inv.dueDate ? new Date(inv.dueDate).toLocaleDateString() : '—'}
                  </TableCell>
                  <TableCell className="tabular-nums font-medium">{formatCurrency(inv.total)}</TableCell>
                  <TableCell>
                    <Badge className={`text-xs ${STATUS_STYLE[inv.status] ?? ''}`}>{inv.status}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1.5">
                      <a
                        href={`/api/invoices/${inv.id}/pdf`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800"
                      >
                        <Download className="h-3.5 w-3.5" /> PDF
                      </a>
                      {inv.status !== 'PAID' && inv.status !== 'CANCELLED' && (
                        <Button size="sm" disabled={marking === inv.id} onClick={() => markPaid(inv)}>
                          <CheckCircle className="h-3.5 w-3.5 mr-1" />
                          {marking === inv.id ? 'Saving…' : 'Mark Paid'}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
