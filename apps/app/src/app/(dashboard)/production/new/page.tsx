'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';

export default function NewJobPage() {
  const router = useRouter();
  const [printers, setPrinters] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get<any[]>('/printers').then(setPrinters),
      api.get<any[]>('/users').then(setUsers),
      api.get<any>('/orders').then(r => setOrders(r?.data || r || [])),
    ]).catch(console.error);
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const form = new FormData(e.currentTarget);

    try {
      await api.post('/jobs', {
        name: form.get('name'),
        printerId: form.get('printerId') || undefined,
        assignedToId: form.get('assignedToId') || undefined,
        orderId: form.get('orderId') || undefined,
        gcodeFilename: form.get('gcodeFilename') || undefined,
        colorChanges: parseInt(form.get('colorChanges') as string) || 0,
      });
      router.push('/production');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">New Production Job</h1>
      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>}
            <Input name="name" label="Job Name" required />
            <Input name="gcodeFilename" label="G-code Filename" />
            <Select name="printerId" label="Printer" options={[{ value: '', label: 'Unassigned' }, ...printers.map(p => ({ value: p.id, label: p.name }))]} />
            <Select name="assignedToId" label="Assigned To" options={[{ value: '', label: 'Unassigned' }, ...users.map(u => ({ value: u.id, label: u.name }))]} />
            <Select name="orderId" label="Order" options={[{ value: '', label: 'None' }, ...orders.map((o: any) => ({ value: o.id, label: o.orderNumber }))]} />
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
