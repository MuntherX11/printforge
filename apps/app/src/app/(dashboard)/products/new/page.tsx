'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';

export default function NewProductPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const form = new FormData(e.currentTarget);
    const data = {
      name: form.get('name') as string,
      description: form.get('description') as string || undefined,
      sku: form.get('sku') as string || undefined,
      colorChanges: parseInt(form.get('colorChanges') as string) || 0,
    };

    try {
      const product = await api.post<any>('/products', data);
      router.push(`/products/${product.id}`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">New Product</h1>
      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>}
            <Input name="name" label="Product Name" placeholder="e.g. Phone Stand v2" required />
            <Input name="description" label="Description" placeholder="Optional description" />
            <div className="grid grid-cols-2 gap-4">
              <Input name="sku" label="SKU" placeholder="e.g. PS-002" />
              <Input name="colorChanges" label="Color Changes" type="number" defaultValue="0" />
            </div>
            <div className="flex gap-3">
              <Button type="submit" disabled={loading}>{loading ? 'Saving...' : 'Create Product'}</Button>
              <Button type="button" variant="outline" onClick={() => router.back()}>Cancel</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
