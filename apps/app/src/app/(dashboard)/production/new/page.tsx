'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { ShoppingCart, Package } from 'lucide-react';

type Mode = 'order' | 'stock';

export default function NewJobPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode | null>(null);
  const [printers, setPrinters] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [jobName, setJobName] = useState('');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [selectedVariantId, setSelectedVariantId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get<any[]>('/printers').then(setPrinters),
      api.get<any[]>('/users').then(setUsers),
    ]).catch(console.error);
  }, []);

  useEffect(() => {
    setJobName(''); // reset name when switching modes
    if (mode === 'order') {
      api.get<any>('/orders?status=CONFIRMED&status=IN_PRODUCTION&limit=100')
        .then(r => setOrders(r?.data || r || []))
        .catch(console.error);
    }
    if (mode === 'stock') {
      api.get<any[]>('/products/active').then(setProducts).catch(console.error);
    }
  }, [mode]);

  function handleOrderChange(orderId: string) {
    const order = orders.find((o: any) => o.id === orderId);
    if (order) {
      const customerPart = order.customer?.name ? ` — ${order.customer.name}` : '';
      setJobName(`${order.orderNumber}${customerPart}`);
    } else {
      setJobName('');
    }
  }

  function handleProductChange(productId: string) {
    const product = products.find((p: any) => p.id === productId);
    setSelectedProductId(productId);
    setSelectedVariantId('');
    setJobName(product?.name ?? '');
  }

  function handleVariantChange(variantId: string) {
    setSelectedVariantId(variantId);
    if (variantId) {
      const product = products.find((p: any) => p.id === selectedProductId);
      const variant = product?.variants?.find((v: any) => v.id === variantId);
      if (variant) setJobName(`${product.name} — ${variant.name}`);
    } else {
      const product = products.find((p: any) => p.id === selectedProductId);
      setJobName(product?.name ?? '');
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const form = new FormData(e.currentTarget);

    const payload: any = {
      name: form.get('name'),
      printerId: form.get('printerId') || undefined,
      assignedToId: form.get('assignedToId') || undefined,
      gcodeFilename: form.get('gcodeFilename') || undefined,
      colorChanges: parseInt(form.get('colorChanges') as string) || 0,
    };

    if (mode === 'order') {
      payload.orderId = form.get('orderId') || undefined;
    } else {
      payload.productId = form.get('productId') || undefined;
      if (selectedVariantId) payload.variantId = selectedVariantId;
    }

    if (!payload.orderId && !payload.productId) {
      setError(mode === 'order' ? 'Select an order.' : 'Select a product.');
      setLoading(false);
      return;
    }

    try {
      await api.post('/jobs', payload);
      router.push('/production');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (!mode) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">New Production Job</h1>
        <p className="text-sm text-gray-500">What is this job for?</p>
        <div className="grid grid-cols-2 gap-4">
          <button
            onClick={() => setMode('order')}
            className="flex flex-col items-center gap-3 p-8 rounded-xl border-2 border-gray-200 dark:border-gray-700 hover:border-brand-500 hover:bg-brand-50 dark:hover:bg-brand-900/20 transition-colors text-left"
          >
            <ShoppingCart className="h-8 w-8 text-brand-600" />
            <div>
              <p className="font-semibold text-gray-900 dark:text-white">For an Order</p>
              <p className="text-xs text-gray-500 mt-1">Fulfil a confirmed customer order</p>
            </div>
          </button>
          <button
            onClick={() => setMode('stock')}
            className="flex flex-col items-center gap-3 p-8 rounded-xl border-2 border-gray-200 dark:border-gray-700 hover:border-brand-500 hover:bg-brand-50 dark:hover:bg-brand-900/20 transition-colors text-left"
          >
            <Package className="h-8 w-8 text-brand-600" />
            <div>
              <p className="font-semibold text-gray-900 dark:text-white">Build Stock</p>
              <p className="text-xs text-gray-500 mt-1">Produce a product for on-hand inventory</p>
            </div>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => setMode(null)} className="text-sm text-brand-600 hover:underline">← Back</button>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          {mode === 'order' ? 'New Job — For Order' : 'New Job — Build Stock'}
        </h1>
      </div>
      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>}

            {mode === 'order' ? (
              <Select
                name="orderId"
                label="Order *"
                required
                options={[
                  { value: '', label: 'Select an order...' },
                  ...orders.map((o: any) => ({ value: o.id, label: `${o.orderNumber} — ${o.customer?.name || ''}` })),
                ]}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => handleOrderChange(e.target.value)}
              />
            ) : (
              <>
                <Select
                  name="productId"
                  label="Product *"
                  required
                  options={[
                    { value: '', label: 'Select a product...' },
                    ...products.map((p: any) => ({ value: p.id, label: p.name })),
                  ]}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => handleProductChange(e.target.value)}
                />
                {(() => {
                  const prod = products.find((p: any) => p.id === selectedProductId);
                  const variants = (prod as any)?.variants;
                  if (!variants?.length) return null;
                  return (
                    <Select
                      label="Variant"
                      options={[
                        { value: '', label: 'No variant (use product defaults)' },
                        ...variants.map((v: any) => ({ value: v.id, label: `${v.name} — ${v.sku}` })),
                      ]}
                      value={selectedVariantId}
                      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => handleVariantChange(e.target.value)}
                    />
                  );
                })()}
              </>
            )}

            <Input
              name="name"
              label="Job Name"
              value={jobName}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setJobName(e.target.value)}
              placeholder={mode === 'order' ? 'Auto-filled from order — you can edit' : 'Auto-filled from product — you can edit'}
            />
            <Input name="gcodeFilename" label="G-code Filename" />
            <Select
              name="printerId"
              label="Printer"
              options={[{ value: '', label: 'Unassigned' }, ...printers.map(p => ({ value: p.id, label: p.name }))]}
            />
            <Select
              name="assignedToId"
              label="Assigned To"
              options={[{ value: '', label: 'Unassigned' }, ...users.map(u => ({ value: u.id, label: u.name }))]}
            />
            <Input name="colorChanges" label="Color Changes" type="number" defaultValue="0" min="0" />

            <div className="flex gap-3">
              <Button type="submit" disabled={loading}>{loading ? 'Creating...' : 'Create Job'}</Button>
              <Button type="button" variant="outline" onClick={() => router.back()}>Cancel</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
