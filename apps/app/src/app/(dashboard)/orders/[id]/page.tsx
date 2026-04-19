'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { Dialog } from '@/components/ui/dialog';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { useFormatCurrency } from '@/lib/locale-context';
import { Mail, MessageCircle, AlertTriangle, CheckCircle, Factory } from 'lucide-react';
import { useToast } from '@/components/ui/toast';

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
  const formatCurrency = useFormatCurrency();
  const { id } = useParams();
  const { toast } = useToast();
  const [order, setOrder] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showPlanDialog, setShowPlanDialog] = useState(false);
  const [plan, setPlan] = useState<any[]>([]);
  const [planOverrides, setPlanOverrides] = useState<Record<string, any>>({});
  const [planLoading, setPlanLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const [printers, setPrinters] = useState<any[]>([]);

  const load = () => api.get(`/orders/${id}`).then(setOrder).catch(console.error).finally(() => setLoading(false));
  useEffect(() => { load(); }, [id]);

  async function updateStatus(status: string) {
    try {
      await api.patch(`/orders/${id}`, { status });
      toast('success', 'Order status updated');
      load();
    } catch (err: any) {
      toast('error', err.message);
    }
  }

  async function sendInvoiceEmail(invoiceId: string) {
    try {
      await api.post(`/invoices/${invoiceId}/send-email`);
      toast('success', 'Invoice sent via email');
    } catch (err: any) {
      toast('error', err.message);
    }
  }

  function whatsAppInvoice(inv: any) {
    const phone = order.customer?.phone?.replace(/[^0-9+]/g, '').replace(/^\+/, '');
    if (!phone) { toast('error', 'Customer has no phone number'); return; }
    const msg = encodeURIComponent(`Hi ${order.customer?.name}, your invoice ${inv.invoiceNumber} for ${formatCurrency(inv.total)} is ready. Thank you!`);
    window.open(`https://wa.me/${phone}?text=${msg}`, '_blank');
  }

  async function loadPlan() {
    setPlanLoading(true);
    try {
      const [res, pr] = await Promise.all([
        api.get<any>(`/jobs/plan/${id}`),
        api.get<any[]>('/printers'),
      ]);
      setPlan(res.plan);
      setPrinters(pr);
      setPlanOverrides({});
      setShowPlanDialog(true);
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setPlanLoading(false);
    }
  }

  async function createJobs() {
    setCreating(true);
    try {
      const overrides = Object.entries(planOverrides)
        .filter(([, v]) => v.toProduce > 0)
        .map(([componentId, v]) => ({
          componentId,
          toProduce: v.toProduce,
          printerId: v.printerId || undefined,
          spoolId: v.spoolId || undefined,
        }));
      const res = await api.post<any>(`/jobs/plan/${id}`, { overrides: overrides.length > 0 ? overrides : undefined });
      setShowPlanDialog(false);
      toast('success', `Created ${res.jobsCreated} production job(s)`);
      load();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setCreating(false);
    }
  }

  function updatePlanOverride(componentId: string, field: string, value: any) {
    setPlanOverrides(prev => ({
      ...prev,
      [componentId]: {
        ...prev[componentId],
        toProduce: prev[componentId]?.toProduce ?? plan.find(p => p.componentId === componentId)?.toProduce ?? 0,
        [field]: value,
      },
    }));
  }

  async function createInvoice() {
    setCreatingInvoice(true);
    try {
      await api.post('/invoices', { orderId: id });
      load();
      toast('success', 'Invoice created');
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setCreatingInvoice(false);
    }
  }

  if (loading) return <Loading />;
  if (!order) return <div className="text-center py-12 text-gray-500">Order not found</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{order.orderNumber}</h1>
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
          {['CONFIRMED', 'PENDING'].includes(order.status) && (
            <Button onClick={loadPlan} disabled={planLoading}>
              <Factory className="h-4 w-4 mr-2" /> {planLoading ? 'Loading...' : 'Plan Production'}
            </Button>
          )}
          <Button variant="outline" onClick={createInvoice} disabled={creatingInvoice}>
            {creatingInvoice ? 'Creating...' : 'Create Invoice'}
          </Button>
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
              {(order.invoices || []).map((inv: any) => (
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
              {(order.productionJobs || []).map((job: any) => (
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
      <Dialog open={showPlanDialog} onClose={() => setShowPlanDialog(false)} title="Production Plan Preview">
        <div className="space-y-4 max-h-[70vh] overflow-y-auto">
          {plan.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">No components need production — all items are in stock.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Component</TableHead>
                  <TableHead>Materials</TableHead>
                  <TableHead>Need</TableHead>
                  <TableHead>On Hand</TableHead>
                  <TableHead>To Produce</TableHead>
                  <TableHead>Printer</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plan.map((item: any) => {
                  const override = planOverrides[item.componentId];
                  const toProduce = override?.toProduce ?? item.toProduce;
                  return (
                    <TableRow key={item.componentId} className={toProduce === 0 ? 'opacity-50' : ''}>
                      <TableCell>
                        <div>
                          <p className="text-sm font-medium">{item.productName}</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">{item.componentDescription}</p>
                          {item.isMultiColor && <Badge className="bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300 text-xs mt-1">Multicolor</Badge>}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          {(item.subMaterials || []).map((sub: any, si: number) => (
                            <div key={si} className="flex items-center gap-2 text-xs">
                              <Badge className="bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200 text-xs shrink-0">
                                {sub.materialName}{sub.materialColor ? ` (${sub.materialColor})` : ''}
                              </Badge>
                              <span className="font-mono text-gray-500">{Math.round(sub.gramsPerUnit * toProduce)}g</span>
                              {sub.suggestedSpool ? (
                                <span className={`font-mono ${sub.suggestedSpool.hasEnough ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}`}>
                                  → {sub.suggestedSpool.pfid || sub.suggestedSpool.id.slice(0, 6)} ({Math.round(sub.suggestedSpool.currentWeight)}g)
                                </span>
                              ) : (
                                <span className="text-red-500">No spool</span>
                              )}
                            </div>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono">{item.needed}</TableCell>
                      <TableCell className="font-mono">{item.onHand}</TableCell>
                      <TableCell>
                        <input
                          type="number"
                          min="0"
                          className="w-16 h-7 text-sm text-center border rounded bg-white dark:bg-gray-800 dark:border-gray-600 font-mono"
                          value={toProduce}
                          onChange={(e) => updatePlanOverride(item.componentId, 'toProduce', parseInt(e.target.value) || 0)}
                        />
                      </TableCell>
                      <TableCell>
                        <select
                          className="h-7 text-xs border rounded px-1 bg-white dark:bg-gray-800 dark:border-gray-600 max-w-[120px]"
                          value={override?.printerId || item.printerId || ''}
                          onChange={(e) => updatePlanOverride(item.componentId, 'printerId', e.target.value)}
                        >
                          <option value="">None</option>
                          {printers.map((p: any) => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
                        </select>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          <div className="flex gap-3 justify-end pt-2 border-t dark:border-gray-700">
            <Button variant="outline" onClick={() => setShowPlanDialog(false)}>Cancel</Button>
            <Button onClick={createJobs} disabled={creating || plan.every((p: any) => (planOverrides[p.componentId]?.toProduce ?? p.toProduce) <= 0)}>
              <Factory className="h-4 w-4 mr-2" />
              {creating ? 'Creating...' : `Create ${plan.filter((p: any) => (planOverrides[p.componentId]?.toProduce ?? p.toProduce) > 0).length} Job(s)`}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}