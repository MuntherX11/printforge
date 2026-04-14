'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Plus, Trash2 } from 'lucide-react';

export default function NewQuotePage() {
  const router = useRouter();
  const { toast } = useToast();
  const [customers, setCustomers] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [items, setItems] = useState([{ description: '', quantity: 1, unitPrice: 0, productId: '' }]);

  useEffect(() => {
    api.get<any>('/customers').then(r => setCustomers(r?.data || r || [])).catch(console.error);
    api.get<any[]>('/products/active').then(setProducts).catch(console.error);
  }, []);

  function handleProductSelect(index: number, productId: string) {
    const updated = [...items];
    const product = products.find(p => p.id === productId);
    if (product) {
      updated[index] = { description: product.name, quantity: 1, unitPrice: product.basePrice, productId };
    } else {
      updated[index].productId = '';
    }
    setItems(updated);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');

    const validItems = items.filter(i => i.description.trim());
    if (validItems.length === 0) {
      setError('Add at least one item with a description before saving.');
      return;
    }

    setLoading(true);
    const form = new FormData(e.currentTarget);

    try {
      await api.post('/quotes', {
        customerId: form.get('customerId'),
        notes: form.get('notes') || undefined,
        validUntil: form.get('validUntil') || undefined,
        items: validItems.map(i => ({ ...i, productId: i.productId || undefined })),
      });
      router.push('/quotes');
    } catch (err: any) {
      toast('error', err.message || 'Failed to create quote');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">New Quote</h1>
      <form onSubmit={handleSubmit} className="space-y-6">
        {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>}
        <Card>
          <CardContent className="pt-6 space-y-4">
            <Select name="customerId" label="Customer" options={[{ value: '', label: 'Select...' }, ...customers.map(c => ({ value: c.id, label: c.name }))]} required />
            <div className="grid grid-cols-2 gap-4">
              <Input name="validUntil" label="Valid Until" type="date" />
              <Textarea name="notes" label="Notes" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold">Items</h2>
              <Button type="button" variant="outline" size="sm" onClick={() => setItems([...items, { description: '', quantity: 1, unitPrice: 0, productId: '' }])}>
                <Plus className="h-4 w-4 mr-1" /> Add
              </Button>
            </div>
            <div className="space-y-3">
              {items.map((item, i) => (
                <div key={i} className="space-y-2 border-b pb-3">
                  {products.length > 0 && (
                    <select
                      className="w-full h-9 rounded-md border border-gray-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                      value={item.productId}
                      onChange={e => handleProductSelect(i, e.target.value)}
                    >
                      <option value="">Custom item (no product)</option>
                      {products.map(p => <option key={p.id} value={p.id}>{p.name}{p.sku ? ` (${p.sku})` : ''} — OMR {p.basePrice.toFixed(3)}</option>)}
                    </select>
                  )}
                  <div className="flex gap-3 items-end">
                    <div className="flex-1"><Input placeholder="Description" value={item.description} onChange={e => { const u = [...items]; u[i].description = e.target.value; setItems(u); }} required /></div>
                    <div className="w-20"><Input type="number" min="1" value={item.quantity} onChange={e => { const u = [...items]; u[i].quantity = parseInt(e.target.value) || 1; setItems(u); }} /></div>
                    <div className="w-28"><Input type="number" step="0.001" value={item.unitPrice} onChange={e => { const u = [...items]; u[i].unitPrice = parseFloat(e.target.value) || 0; setItems(u); }} /></div>
                    <div className="w-24 text-right text-sm font-medium py-2">{(item.quantity * item.unitPrice).toFixed(3)}</div>
                    {items.length > 1 && <Button type="button" variant="ghost" size="sm" onClick={() => setItems(items.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4 text-red-500" /></Button>}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 text-right text-lg font-bold">
              Subtotal: OMR {items.reduce((s, i) => s + i.quantity * i.unitPrice, 0).toFixed(3)}
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