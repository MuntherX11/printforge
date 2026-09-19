'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { useFormatCurrency } from '@/lib/locale-context';
import { useLineItems } from '@/hooks/use-line-items';
import { LineItemFields, focusLineQty } from '@/components/orders/LineItemFields';
import type { ApiActiveProduct, ApiCustomer } from '@/lib/types/api';
import { Plus, AlertTriangle } from 'lucide-react';
import { useToast } from '@/components/ui/toast';

interface Shortage {
  materialId: string;
  name: string;
  type: string;
  color: string | null;
  gramsNeeded: number;
  freeStock: number;
  reservedStock: number;
}

const errorText = (err: unknown, fallback: string) => (err instanceof Error && err.message) || fallback;

export default function NewOrderPage() {
  const router = useRouter();
  const formatCurrency = useFormatCurrency();
  const { toast } = useToast();
  const [customers, setCustomers] = useState<ApiCustomer[]>([]);
  const [products, setProducts] = useState<ApiActiveProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [shortages, setShortages] = useState<Shortage[]>([]);
  const [ackShortages, setAckShortages] = useState(false);

  const lines = useLineItems(products);
  const { items, addItem, subtotal } = lines;

  useEffect(() => {
    api.get<ApiCustomer[] | { data: ApiCustomer[] }>('/customers')
      .then(r => setCustomers(Array.isArray(r) ? r : r?.data ?? []))
      .catch((err: unknown) => toast('error', errorText(err, 'Failed to load')));
    api.get<ApiActiveProduct[]>('/products/active').then(setProducts).catch((err: unknown) => toast('error', errorText(err, 'Failed to load')));
  }, []);

  // Check filament stock as the order is built, so a shortage shows up before
  // the order is placed rather than on the shop floor.
  const stockKey = JSON.stringify(
    items.filter(i => i.productId).map(i => [i.productId, i.sizeOptionId, i.colourOptionId, i.quantity]),
  );
  useEffect(() => {
    const stockLines = items
      .filter(i => i.productId && i.quantity > 0)
      .map(i => ({ productId: i.productId, sizeOptionId: i.sizeOptionId, colourOptionId: i.colourOptionId, quantity: i.quantity }));
    if (stockLines.length === 0) { setShortages([]); return; }

    let cancelled = false;
    const t = setTimeout(() => {
      api.post<{ shortages: Shortage[] }>('/orders/check-stock', { items: stockLines })
        .then(r => { if (!cancelled) { setShortages(r?.shortages || []); setAckShortages(false); } })
        .catch(() => { if (!cancelled) setShortages([]); });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [stockKey]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');

    const validItems = items.filter(i => i.description.trim());
    if (validItems.length === 0) {
      setError('Add at least one item with a description before saving.');
      return;
    }
    if (validItems.some(i => i.quantity < 1)) {
      setError('Enter a quantity for every line.');
      return;
    }

    if (shortages.length > 0 && !ackShortages) {
      setAckShortages(true);
      setError('Not enough filament in stock for this order — check the warning above, then save again to place it anyway.');
      return;
    }

    setLoading(true);
    const form = new FormData(e.currentTarget);

    try {
      await api.post('/orders', {
        customerId: form.get('customerId'),
        notes: form.get('notes') || undefined,
        dueDate: form.get('dueDate') || undefined,
        items: validItems.map(lines.payload),
      });
      router.push('/orders');
    } catch (err: unknown) {
      setError(errorText(err, 'Failed to create order'));
    } finally {
      setLoading(false);
    }
  }

  const productOptions = [
    { value: '', label: 'Custom item (no product)' },
    ...products.map(p => ({ value: p.id, label: `${p.name}${p.sku ? ` (${p.sku})` : ''} — ${formatCurrency(p.basePrice)}` })),
  ];

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">New Order</h1>
      <form onSubmit={handleSubmit} className="space-y-6">
        {error && <div role="alert" className="rounded-md bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-600 dark:text-red-400">{error}</div>}

        {shortages.length > 0 && (
          <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800 p-3">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />
              Not enough filament for this order
            </p>
            <ul className="mt-2 space-y-1">
              {shortages.map(s => (
                <li key={s.materialId} className="text-sm text-amber-800 dark:text-amber-300">
                  {[s.color, s.type].filter(Boolean).join(' ') || s.name}: needs {s.gramsNeeded}g,
                  {' '}{s.freeStock}g free
                  {s.reservedStock > 0 && <> ({s.reservedStock}g reserved by other orders)</>}
                  {' '}— short {Math.round(s.gramsNeeded - s.freeStock)}g
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
              You can still place the order. Buy or load filament before it goes into production.
            </p>
          </div>
        )}

        <Card>
          <CardContent className="pt-6 space-y-4">
            <Select
              name="customerId"
              label="Customer"
              options={[{ value: '', label: 'Select customer...' }, ...customers.map(c => ({ value: c.id, label: c.name }))]}
              required
            />
            <div className="grid grid-cols-2 gap-4">
              <Input name="dueDate" label="Due Date" type="date" />
              <Textarea name="notes" label="Notes" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold dark:text-gray-100">Items</h2>
              <Button type="button" variant="outline" size="sm" onClick={addItem}>
                <Plus className="h-4 w-4 mr-1" /> Add Item
              </Button>
            </div>
            <div className="space-y-3">
              {items.map((item, i) => (
                <LineItemFields
                  key={item.key}
                  item={item}
                  index={i}
                  lines={lines}
                  productOptions={productOptions}
                  showProductSelect={products.length > 0}
                  canRemove={items.length > 1}
                  onFocusLine={focusLineQty}
                />
              ))}
            </div>
            <div className="mt-4 text-right text-lg font-bold dark:text-gray-100">
              Subtotal: {formatCurrency(subtotal)}
            </div>
          </CardContent>
        </Card>

        <div className="flex gap-3">
          <Button type="submit" disabled={loading}>{loading ? 'Creating...' : 'Create Order'}</Button>
          <Button type="button" variant="outline" onClick={() => router.back()}>Cancel</Button>
        </div>
      </form>
    </div>
  );
}
