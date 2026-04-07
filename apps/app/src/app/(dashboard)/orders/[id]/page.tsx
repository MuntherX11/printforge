'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { formatDate, formatCurrency } from '@/lib/utils';
import { Mail, MessageCircle, AlertTriangle, CheckCircle } from 'lucide-react';

const orderStatuses = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'CONFIRMED', label: 'Confirmed' },
  { value: 'IN_PRODUCTION', label: 'In Production' },
  { value: 'READY', label: 'Ready' },
  { value: 'SHIPPED', label: 'Shipped' },
  { value: 'DELIVERED', label: 'Delivered' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

export default function OrderDetailPage() {
  const { id } = useParams();
  const [order, setOrder] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = () => api.get(`/orders/${id}`).then(setOrder).catch(console.error).finally(() => setLoading(false));
  useEffect(() => { load(); }, [id]);

  async function updateStatus(status: string) {
    await api.patch(`/orders/${id}`, { status });
    load();
  }

  async function sendInvoiceEmail(invoiceId: string) {
    try {
      await api.post(`/invoices/${invoiceId}/send-email`);
      alert('Invoice sent via email');
    } catch (err: any) {
      alert(err.message);
    }
  }

  function whatsAppInvoice(inv: any) {
    const phone = order.customer?.phone?.replace(/[^0-9+]/g, '').replace(/^\+/, '');
    if (!phone) { alert('Customer has no phone number'); return; }
    const msg = encodeURIComponent(`Hi ${order.customer?.name}, your invoice ${inv.invoiceNumber} for ${formatCurrency(inv.total)} is ready. Thank you!`);
    window.open(`https://wa.me/${phone}?text=${msg}`, '_blank');
  }

  async function createInvoice() {
    try {
      await api.post('/invoices', { orderId: id });
      load();
    } catch (err: any) {
      alert(err.message);
    }
  }

  if (loading) return <Loading />;
  if (!order) return <div className="text-center py-12 text-gray-500">Order not found</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{order.orderNumber}</h1>
          <p className="text-sm text-gray-500">
            <Link href={`/customers/${order.customer?.id}`} className="text-brand-600 hover:underline">
              {order.customer?.name}
            </Link>
            {' '} | Created {formatDate(order.createdAt)}
          </p>
        </div>
        <div className="flex gap-2">
          <Select
            options={orderStatuses}
            value={order.status}
            onChange={e => updateStatus(e.target.value)}
            className="w-40"
          />
          <Button variant="outline" onClick={createInvoice}>Create Invoice</Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Status</p><StatusBadge status={order.status} /></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Total</p><p className="text-lg font-bold">{formatCurrency(order.total)}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Paid</p><p className="text-lg font-bold">{formatCurrency(order.paidAmount)}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Balance</p><p className="text-lg font-bold">{formatCurrency(order.total - order.paidAmount)}</p></CardContent></Card>
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
              {(order.items || []).map((item: any) => (
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

      {order.materialAvailability && order.materialAvailability.length > 0 && (() => {
        const allReady = order.materialAvailability.every((m: any) => m.hasEnoughStock);
        return (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Filament Requirements
                {allReady ? (
                  <Badge className="bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 text-xs ml-2">All In Stock</Badge>
                ) : (
                  <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300 text-xs ml-2">Shortages</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Material</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Color</TableHead>
                    <TableHead>Required</TableHead>
                    <TableHead>In Stock</TableHead>
                    <TableHead>Reserved</TableHead>
                    <TableHead>Free</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {order.materialAvailability.map((m: any) => (
                    <TableRow key={m.materialId}>
                      <TableCell className="font-medium">{m.name}</TableCell>
                      <TableCell>{m.type}</TableCell>
                      <TableCell>{m.color || '-'}</TableCell>
                      <TableCell className="font-mono">{m.gramsNeeded}g</TableCell>
                      <TableCell className="font-mono">{m.totalStock}g</TableCell>
                      <TableCell className="font-mono text-gray-500">{m.reservedStock || 0}g</TableCell>
                      <TableCell className="font-mono font-medium">{m.freeStock ?? m.totalStock}g</TableCell>
                      <TableCell>
                        {m.hasEnoughStock ? (
                          <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
                            <CheckCircle className="h-4 w-4" /> OK
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="h-4 w-4" /> Need {Math.max(0, m.gramsNeeded - (m.freeStock ?? m.totalStock))}g more
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        );
      })()}

      {order.invoices && order.invoices.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Invoices</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {order.invoices.map((inv: any) => (
                <div key={inv.id} className="flex items-center justify-between p-2 rounded hover:bg-gray-50">
                  <div>
                    <p className="text-sm font-medium">{inv.invoiceNumber}</p>
                    <p className="text-xs text-gray-500">{formatDate(inv.createdAt)}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium">{formatCurrency(inv.total)}</span>
                    <StatusBadge status={inv.status} />
                    <a href={`/api/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer">
                      <Button variant="outline" size="sm">PDF</Button>
                    </a>
                    <Button variant="outline" size="sm" onClick={() => sendInvoiceEmail(inv.id)} title="Send via Email">
                      <Mail className="h-3 w-3" />
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => whatsAppInvoice(inv)} title="WhatsApp">
                      <MessageCircle className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {order.productionJobs && order.productionJobs.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Production Jobs</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {order.productionJobs.map((job: any) => (
                <Link key={job.id} href={`/production/${job.id}`} className="flex items-center justify-between p-2 rounded hover:bg-gray-50">
                  <div>
                    <p className="text-sm font-medium">{job.name}</p>
                    <p className="text-xs text-gray-500">{job.printer?.name}</p>
                  </div>
                  <StatusBadge status={job.status} />
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}