'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { formatDate } from '@/lib/utils';
import { useFormatCurrency } from '@/lib/locale-context';
import { notFound } from 'next/navigation';
import { AlertTriangle, CheckCircle, Factory, FileDown } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { LinePriceHint } from '@/components/pricing/LinePriceHint';
import { ChangeLineColourDialog } from '@/components/orders/ChangeLineColourDialog';
import { ConfirmDialog } from '../../products/[id]/ConfirmDialog';
import type { ApiActiveProduct, ApiPrinter, PlanSubmitResult, ProductionPlan, StockReleasedRow } from '@/lib/types/api';
import { useOrder, type OrderInvoice, type OrderLine } from './useOrder';
import { InvoiceList } from './InvoiceList';
import { ConfigArtifactsCard } from './ConfigArtifactsCard';
import { PlanProductionDialog } from './PlanProductionDialog';

const orderStatuses = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'CONFIRMED', label: 'Confirmed' },
  { value: 'IN_PRODUCTION', label: 'In Production' },
  { value: 'READY', label: 'Ready' },
  { value: 'SHIPPED', label: 'Shipped' },
  { value: 'DELIVERED', label: 'Delivered' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const errorText = (err: unknown, fallback = 'Something went wrong') => (err instanceof Error && err.message) || fallback;

/** `Box 2, Lid 1 (PLA Red)`: units per component, the colour once per group. */
function stockText(rows: Array<{ componentDescription: string; colourLabel: string; units: number }>): string {
  const byColour = new Map<string, string[]>();
  for (const r of rows) byColour.set(r.colourLabel, [...(byColour.get(r.colourLabel) ?? []), `${r.componentDescription} ${r.units}`]);
  return [...byColour.entries()].map(([colour, parts]) => `${parts.join(', ')} (${colour})`).join('; ');
}

export default function OrderDetailPage() {
  const formatCurrency = useFormatCurrency();
  const { toast } = useToast();
  const { role } = useAuth();
  const canEdit = role === 'ADMIN' || role === 'OPERATOR';
  const { id, order, loading, reload } = useOrder();

  const [showPlanDialog, setShowPlanDialog] = useState(false);
  const [plan, setPlan] = useState<ProductionPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [printers, setPrinters] = useState<ApiPrinter[]>([]);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [products, setProducts] = useState<ApiActiveProduct[] | null>(null);
  const [colourLine, setColourLine] = useState<OrderLine | null>(null);

  // Which products have colours (for the Change colour action).
  useEffect(() => {
    if (!canEdit) return;
    api.get<ApiActiveProduct[]>('/products/active').then(setProducts).catch(() => setProducts([]));
  }, [canEdit]);
  const hasColours = (productId: string | null) => !!productId && !!products?.find(p => p.id === productId)?.colours.length;

  async function updateStatus(status: string) {
    if (status === 'CANCELLED' && order?.status !== 'CANCELLED') { setConfirmCancel(true); return; }
    setUpdating(true);
    try {
      await api.patch(`/orders/${id}`, { status });
      toast('success', 'Order status updated');
      reload();
    } catch (err: unknown) {
      toast('error', errorText(err));
    } finally {
      setUpdating(false);
    }
  }

  async function cancelOrder() {
    setUpdating(true);
    try {
      const res = await api.patch<{ stockReleased?: StockReleasedRow[] }>(`/orders/${id}`, { status: 'CANCELLED' });
      const back = res.stockReleased ?? [];
      toast('success', back.length ? `Order cancelled — returned to printed stock: ${stockText(back)}` : 'Order cancelled');
      setConfirmCancel(false);
      reload();
    } catch (err: unknown) {
      toast('error', errorText(err));
    } finally {
      setUpdating(false);
    }
  }

  async function sendInvoiceEmail(invoiceId: string) {
    try {
      await api.post(`/invoices/${invoiceId}/send-email`);
      toast('success', 'Invoice sent via email');
    } catch (err: unknown) {
      toast('error', errorText(err));
    }
  }

  function whatsAppInvoice(inv: OrderInvoice) {
    const phone = order?.customer?.phone?.replace(/[^0-9+]/g, '').replace(/^\+/, '');
    if (!phone) { toast('error', 'Customer has no phone number'); return; }
    const msg = encodeURIComponent(`Hi ${order?.customer?.name}, your invoice ${inv.invoiceNumber} for ${formatCurrency(inv.total)} is ready. Thank you!`);
    window.open(`https://wa.me/${phone}?text=${msg}`, '_blank');
  }

  async function loadPlan() {
    setPlanLoading(true);
    try {
      const [res, pr] = await Promise.all([
        api.get<ProductionPlan>(`/jobs/plan/${id}`),
        api.get<ApiPrinter[]>('/printers'),
      ]);
      setPlan(res);
      setPrinters(pr);
      setShowPlanDialog(true);
    } catch (err: unknown) {
      toast('error', errorText(err));
    } finally {
      setPlanLoading(false);
    }
  }

  function planCreated(res: PlanSubmitResult) {
    const taken = res.allocations.reduce((n, a) => n + a.fromStock, 0);
    setShowPlanDialog(false);
    toast('success', taken > 0
      ? `Took ${taken} from stock · created ${res.jobsCreated} production job(s)`
      : `Created ${res.jobsCreated} production job(s)`);
    reload();
  }

  async function createInvoice() {
    setCreatingInvoice(true);
    try {
      await api.post('/invoices', { orderId: id });
      reload();
      toast('success', 'Invoice created');
    } catch (err: unknown) {
      toast('error', errorText(err));
    } finally {
      setCreatingInvoice(false);
    }
  }

  if (loading) return <Loading />;
  if (!order) return notFound();

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
            disabled={updating}
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

      <dl className="grid grid-cols-2 sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-gray-100 dark:divide-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
        <div className="px-4 py-3 flex flex-col gap-0.5"><dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Status</dt><dd><StatusBadge status={order.status} /></dd></div>
        <div className="px-4 py-3 flex flex-col gap-0.5"><dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Total</dt><dd className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatCurrency(order.total)}</dd></div>
        <div className="px-4 py-3 flex flex-col gap-0.5"><dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Paid</dt><dd className="text-sm font-semibold tabular-nums text-green-700 dark:text-green-400">{formatCurrency(order.paidAmount)}</dd></div>
        <div className="px-4 py-3 flex flex-col gap-0.5"><dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Balance</dt><dd className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatCurrency(order.total - order.paidAmount)}</dd></div>
      </dl>

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
                {canEdit && <TableHead><span className="sr-only">Actions</span></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(order.items || []).map(item => (
                <TableRow key={item.id}>
                  <TableCell>{item.description}</TableCell>
                  <TableCell>{item.quantity}</TableCell>
                  <TableCell>
                    {formatCurrency(item.unitPrice)}
                    <LinePriceHint
                      readOnly
                      info={item.priceSource ? { priceSource: item.priceSource, listUnitPrice: item.listUnitPrice ?? null, tierMinQty: item.tierMinQty ?? null, unitPrice: item.unitPrice } : null}
                    />
                  </TableCell>
                  <TableCell className="font-medium">{formatCurrency(item.totalPrice)}</TableCell>
                  {canEdit && (
                    <TableCell className="text-right">
                      {order.status !== 'CANCELLED' && hasColours(item.productId) && (
                        <button type="button" onClick={() => setColourLine(item)} className="text-sm text-brand-600 hover:underline dark:text-brand-400">
                          Change colour
                        </button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {order.materialAvailability && order.materialAvailability.length > 0 && (() => {
        const allReady = order.materialAvailability.every(m => m.hasEnoughStock);
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
                  {order.materialAvailability.map(m => (
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

      {order.partAvailability && order.partAvailability.length > 0 && (() => {
        const allReady = order.partAvailability.every(p => p.hasEnoughStock);
        return (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Parts &amp; Hardware
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
                    <TableHead>Part</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Required</TableHead>
                    <TableHead>In Stock</TableHead>
                    <TableHead>Reserved</TableHead>
                    <TableHead>Free</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {order.partAvailability.map(p => (
                    <TableRow key={p.partId}>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell className="font-mono text-xs text-gray-400">{p.sku || '-'}</TableCell>
                      <TableCell className="font-mono">{p.qtyNeeded}</TableCell>
                      <TableCell className="font-mono">{p.stockQty}</TableCell>
                      <TableCell className="font-mono text-gray-500">{p.reservedStock || 0}</TableCell>
                      <TableCell className="font-mono font-medium">{p.freeStock}</TableCell>
                      <TableCell>
                        {p.hasEnoughStock ? (
                          <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
                            <CheckCircle className="h-4 w-4" /> OK
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="h-4 w-4" /> Need {Math.max(0, p.qtyNeeded - p.freeStock)} more
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

      {/* The slicer files for this order, so the operator doesn't have to go
          find them in the product catalogue. */}
      {order.printFiles && order.printFiles.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Print Files</CardTitle></CardHeader>
          <CardContent className="p-0">
            <div className="divide-y dark:divide-gray-700">
              {order.printFiles.map((f, i) => (
                <div key={`${f.attachmentId}-${f.orderItemId}-${i}`} className="flex items-center gap-3 px-4 py-3">
                  <FileDown className="h-4 w-4 text-gray-400 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate dark:text-gray-100">{f.filename}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {f.productName}{f.optionLabel ? ` · ${f.optionLabel}` : ''} · {f.component}
                      {f.kind === 'PLATE_LAYOUT' && f.unitsPerPlate ? ` · ×${f.unitsPerPlate} plate` : ''} · ×{f.quantity}
                      {f.colorChanges > 0 && <> · {f.colorChanges} colour changes</>}
                      {f.sizeBytes > 0 && <> · {(f.sizeBytes / 1024 / 1024).toFixed(1)} MB</>}
                    </p>
                    {f.printIn.filter(c => c.slicedFor).map(c => (
                      <p key={c.colorIndex} className="text-xs text-blue-600 dark:text-blue-400 mt-0.5">
                        print colour {c.colorIndex + 1} in {c.materialLabel} — file sliced for {c.slicedFor}
                      </p>
                    ))}
                  </div>
                  <a
                    href={`/api/attachments/${f.attachmentId}/download`}
                    className="text-sm text-blue-600 hover:underline dark:text-blue-400 flex-shrink-0"
                  >
                    Download
                  </a>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Configurator-generated production files (renders nothing for plain orders) */}
      <ConfigArtifactsCard orderId={String(id)} />

      <InvoiceList
        invoices={order.invoices || []}
        orderId={id}
        creating={creatingInvoice}
        onCreateInvoice={createInvoice}
        onSendEmail={sendInvoiceEmail}
        onWhatsApp={whatsAppInvoice}
        formatCurrency={formatCurrency}
        formatDate={formatDate}
      />

      {order.productionJobs && order.productionJobs.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Production Jobs</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {(order.productionJobs || []).map(job => (
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

      <PlanProductionDialog
        open={showPlanDialog}
        onClose={() => setShowPlanDialog(false)}
        orderId={String(id)}
        plan={plan}
        printers={printers}
        onCreated={planCreated}
        onReload={loadPlan}
      />

      <ConfirmDialog
        open={confirmCancel}
        title="Cancel order"
        destructive
        busy={updating}
        confirmLabel="Cancel order"
        message={(order.stockAllocations ?? []).length
          ? `Returns to printed stock: ${stockText(order.stockAllocations ?? [])}`
          : 'Nothing to return to printed stock'}
        onConfirm={cancelOrder}
        onClose={() => setConfirmCancel(false)}
      />

      <ChangeLineColourDialog
        open={!!colourLine}
        onClose={() => setColourLine(null)}
        kind="orders"
        documentId={String(id)}
        line={colourLine}
        products={products}
        onDone={msg => { setColourLine(null); toast('success', msg); reload(); }}
      />
    </div>
  );
}
