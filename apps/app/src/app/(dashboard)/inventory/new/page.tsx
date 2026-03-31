'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';

const materialTypes = [
  { value: 'PLA', label: 'PLA' },
  { value: 'PETG', label: 'PETG' },
  { value: 'ABS', label: 'ABS' },
  { value: 'TPU', label: 'TPU' },
  { value: 'ASA', label: 'ASA' },
  { value: 'NYLON', label: 'Nylon' },
  { value: 'RESIN', label: 'Resin' },
  { value: 'OTHER', label: 'Other' },
];

export default function NewMaterialPage() {
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
      type: form.get('type') as string,
      color: form.get('color') as string || undefined,
      brand: form.get('brand') as string || undefined,
      costPerGram: parseFloat(form.get('costPerGram') as string),
      density: parseFloat(form.get('density') as string) || 1.24,
      reorderPoint: parseFloat(form.get('reorderPoint') as string) || 500,
    };

    try {
      await api.post('/materials', data);
      router.push('/inventory');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">New Material</h1>
      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>}
            <Input name="name" label="Name" placeholder="e.g. PLA White" required />
            <Select name="type" label="Material Type" options={materialTypes} />
            <div className="grid grid-cols-2 gap-4">
              <Input name="color" label="Color" placeholder="e.g. White" />
              <Input name="brand" label="Brand" placeholder="e.g. eSUN" />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <Input name="costPerGram" label="Cost per Gram" type="number" step="0.001" required />
              <Input name="density" label="Density (g/cm3)" type="number" step="0.01" defaultValue="1.24" />
              <Input name="reorderPoint" label="Reorder Point (g)" type="number" defaultValue="500" />
            </div>
            <div className="flex gap-3">
              <Button type="submit" disabled={loading}>{loading ? 'Saving...' : 'Create Material'}</Button>
              <Button type="button" variant="outline" onClick={() => router.back()}>Cancel</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
