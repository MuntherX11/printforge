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
import { Plus, Trash2 } from 'lucide-react';

export default function NewOrderPage() {
  const router = useRouter();
  const formatCurrency = useFormatCurrency();
  const [customers, setCustomers] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const { items, addItem, removeItem, updateItem, handleProductSelect, subtotal } = useLineItems(products);

  useEffect(() => {
    api.get<any>('/customers').then(r => setCustomers(r?.data || r || [])).catch(console.error);
    api.get<any[]>('/products/active').then(setProducts).catch(console.error);
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const form = new FormData(e.currentTarget);

    try {
      await api.post('/orders', {
        customerId: form.get('customerId'),
        notes: form.get('notes') || undefined,
        dueDate: form.get('dueDate') || undefined,
        items: items.filter(i => i.description).map(i => ({ ...i, productId: i.productId || undefined })),
      });
      router.push('/orders');
    } catch (err: any) {
      setError(err.message);
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
        {error && <div className="rounded-md bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-600 dark:text-red-400">{error}</div>}

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
                <div key={i} className="space-y-2 border-b dark:border-gray-700 pb-3">
                  {products.length > 0 && (
                    <Select
                      options={productOptions}
                      value={item.productId}
                      onChange={e => handleProductSelect(i, e.target.value)}
                    />
                  )}
                  <div className="flex gap-3 items-end">
                    <div className="flex-1">
                      <Input
                        placeholder="Description"
                        value={item.description}
                        onChange={e => updateItem(i, 'description', e.target.value)}
                        required
                      />
                    </div>
                    <div className="w-20">
                      <Input
                        type="number"
                        min="1"
                        value={item.quantity}
                        onChange={e => updateItem(i, 'quantity', parseInt(e.target.value) || 1)}
                      />
                    </div>
                    <div className="w-28">
                      <Input
                        type="number"
                        step="0.001"
                        min="0"
                        value={item.unitPrice}
                        onChange={e => updateItem(i, 'unitPrice', parseFloat(e.target.value) || 0)}
                      />
                    </div>
                    <div className="w-24 text-right text-sm font-medium py-2 dark:text-gray-200">
                      {(item.quantity * item.unitPrice).toFixed(3)}
                    </div>
                    {items.length > 1 && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => removeItem(i)}>
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    )}
                  </div>
                </div>
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
