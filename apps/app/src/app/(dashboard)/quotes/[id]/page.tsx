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
import { formatDate } from '@/lib/utils';
import { useFormatCurrency } from '@/lib/locale-context';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/lib/auth-context';
import { LinePriceHint } from '@/components/pricing/LinePriceHint';
import { ChangeLineColourDialog } from '@/components/orders/ChangeLineColourDialog';
import type {
  ApiActiveProduct, LineOptionFields, LinePricingFields, QuoteConversionPlanning, QuoteStatus,
} from '@/lib/types/api';

interface QuoteLine extends LineOptionFields, Partial<LinePricingFields> {
  id: string;
  productId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

/** GET /quotes/:id (S8), the fields this page reads. */
interface QuoteDetail {
  id: string;
  quoteNumber: string;
  status: QuoteStatus;
  total: number;
  validUntil: string | null;
  createdAt: string;
  customer: { id: string; name: string } | null;
  order: { id: string; orderNumber: string } | null;
  items: QuoteLine[];
}

const errorText = (err: unknown, fallback = 'Something went wrong') => (err instanceof Error && err.message) || fallback;

const quoteStatuses = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SENT', label: 'Sent' },
  { value: 'ACCEPTED', label: 'Accepted' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'EXPIRED', label: 'Expired' },
];

export default function QuoteDetailPage() {
  const formatCurrency = useFormatCurrency();
  const { id } = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const { role } = useAuth();
  const canEdit = role === 'ADMIN' || role === 'OPERATOR';
  const [quote, setQuote] = useState<QuoteDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [converting, setConverting] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [products, setProducts] = useState<ApiActiveProduct[] | null>(null);
  const [colourLine, setColourLine] = useState<QuoteLine | null>(null);

  const load = () => api.get<QuoteDetail>(`/quotes/${id}`).then(setQuote).catch((err: unknown) => {
    toast('error', errorText(err, 'Failed to load quote details'));
  }).finally(() => setLoading(false));

  useEffect(() => { load(); }, [id]);

  // Which products have colours (for the Change colour action).
  useEffect(() => {
    if (!canEdit) return;
    api.get<ApiActiveProduct[]>('/products/active').then(setProducts).catch(() => setProducts([]));
  }, [canEdit]);
  const hasColours = (productId: string | null) => !!productId && !!products?.find(p => p.id === productId)?.colours.length;
  const colourEditable = !!quote && ['DRAFT', 'SENT'].includes(quote.status);

  async function updateStatus(status: string) {
    setUpdating(true);
    try {
      await api.patch(`/quotes/${id}`, { status });
      load();
      toast('success', `Quote status updated to ${status}`);
    } catch (err: unknown) {
      toast('error', errorText(err));
    } finally {
      setUpdating(false);
    }
  }

  async function convertToOrder(autoCreateJobs = true) {
    setConverting(true);
    try {
      const res = await api.post<{ planning?: QuoteConversionPlanning }>(`/quotes/${id}/convert`, { autoCreateJobs });
      const planning = res.planning ?? { jobsCreated: 0, warnings: [] };
      toast('success', `Quote converted — ${planning.jobsCreated} jobs planned`);
      for (const w of planning.warnings.filter(x => x.code === 'JOBS_NOT_PLANNED')) toast('warning', w.message);
      router.push('/orders');
    } catch (err: unknown) {
      toast('error', errorText(err));
      setConverting(false);
    }
  }

  if (loading) return <Loading />;
  if (!quote) return <div className="text-center py-12 text-gray-500">Quote not found</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{quote.quoteNumber}</h1>
          <p className="text-sm text-gray-500">{quote.customer?.name} | {formatDate(quote.createdAt)}</p>
        </div>
        <div className="flex gap-2 items-center">
          <Button variant="outline" onClick={() => window.open(`/api/quotes/${id}/pdf`, '_blank')}>
            Download PDF
          </Button>
          <Select options={quoteStatuses} value={quote.status} onChange={e => updateStatus(e.target.value)} className="w-36" disabled={updating} />
          {['ACCEPTED', 'SENT'].includes(quote.status) && !quote.order && (
            <Button onClick={() => convertToOrder(true)} disabled={converting}>
              {converting ? 'Converting...' : 'Convert to Order + Create Jobs'}
            </Button>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-3 divide-x divide-gray-100 dark:divide-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
        <div className="px-4 py-3 flex flex-col gap-0.5"><dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Status</dt><dd><StatusBadge status={quote.status} /></dd></div>
        <div className="px-4 py-3 flex flex-col gap-0.5"><dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Total</dt><dd className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatCurrency(quote.total)}</dd></div>
        <div className="px-4 py-3 flex flex-col gap-0.5"><dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Valid Until</dt><dd className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">{quote.validUntil ? formatDate(quote.validUntil) : 'N/A'}</dd></div>
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
                {canEdit && colourEditable && <TableHead><span className="sr-only">Actions</span></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(quote.items || []).map(item => (
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
                  {canEdit && colourEditable && (
                    <TableCell className="text-right">
                      {hasColours(item.productId) && (
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

      {quote.order && (
        <Card>
          <CardContent className="p-4">
            <p className="text-sm">Converted to order: <a href={`/orders/${quote.order.id}`} className="text-brand-600 font-medium hover:underline">{quote.order.orderNumber}</a></p>
          </CardContent>
        </Card>
      )}

      <ChangeLineColourDialog
        open={!!colourLine}
        onClose={() => setColourLine(null)}
        kind="quotes"
        documentId={String(id)}
        line={colourLine}
        products={products}
        onDone={msg => { setColourLine(null); toast('success', msg); load(); }}
      />
    </div>
  );
}