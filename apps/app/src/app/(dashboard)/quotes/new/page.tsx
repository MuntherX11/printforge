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
import { useToast } from '@/components/ui/toast';
import { useLineItems } from '@/hooks/use-line-items';
import { LineItemFields, focusLineQty } from '@/components/orders/LineItemFields';
import type { ApiActiveProduct, ApiCustomer } from '@/lib/types/api';
import { Plus } from 'lucide-react';

const errorText = (err: unknown, fallback: string) => (err instanceof Error && err.message) || fallback;

export default function NewQuotePage() {
  const router = useRouter();
  const { toast } = useToast();
  const formatCurrency = useFormatCurrency();
  const [customers, setCustomers] = useState<ApiCustomer[]>([]);
  const [products, setProducts] = useState<ApiActiveProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const lines = useLineItems(products);
  const { items, addItem, subtotal } = lines;

  useEffect(() => {
    api.get<ApiCustomer[] | { data: ApiCustomer[] }>('/customers')
      .then(r => setCustomers(Array.isArray(r) ? r : r?.data ?? []))
      .catch((err: unknown) => toast('error', errorText(err, 'Failed to load')));
    api.get<ApiActiveProduct[]>('/products/active').then(setProducts).catch((err: unknown) => toast('error', errorText(err, 'Failed to load')));
  }, []);

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

    setLoading(true);
    const form = new FormData(e.currentTarget);

    try {
      await api.post('/quotes', {
        customerId: form.get('customerId'),
        notes: form.get('notes') || undefined,
        validUntil: form.get('validUntil') || undefined,
        items: validItems.map(lines.payload),
      });
      router.push('/quotes');
    } catch (err: unknown) {
      toast('error', errorText(err, 'Failed to create quote'));
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
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">New Quote</h1>
      <form onSubmit={handleSubmit} className="space-y-6">
        {error && <div role="alert" className="rounded-md bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-600 dark:text-red-400">{error}</div>}

        <Card>
          <CardContent className="pt-6 space-y-4">
            <Select
              name="customerId"
              label="Customer"
              options={[{ value: '', label: 'Select...' }, ...customers.map(c => ({ value: c.id, label: c.name }))]}
              required
            />
            <div className="grid grid-cols-2 gap-4">
              <Input name="validUntil" label="Valid Until" type="date" />
              <Textarea name="notes" label="Notes" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold dark:text-gray-100">Items</h2>
              <Button type="button" variant="outline" size="sm" onClick={addItem}>
                <Plus className="h-4 w-4 mr-1" /> Add
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
          <Button type="submit" disabled={loading}>{loading ? 'Creating...' : 'Create Quote'}</Button>
          <Button type="button" variant="outline" onClick={() => router.back()}>Cancel</Button>
        </div>
      </form>
    </div>
  );
}
