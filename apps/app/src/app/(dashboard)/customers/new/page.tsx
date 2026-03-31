'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';

export default function NewCustomerPage() {
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
      email: form.get('email') as string || undefined,
      phone: form.get('phone') as string || undefined,
      address: form.get('address') as string || undefined,
      notes: form.get('notes') as string || undefined,
    };

    try {
      await api.post('/customers', data);
      router.push('/customers');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">New Customer</h1>
      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>}
            <Input name="name" label="Name" required />
            <Input name="email" label="Email" type="email" />
            <Input name="phone" label="Phone" />
            <Input name="address" label="Address" />
            <Textarea name="notes" label="Notes" />
            <div className="flex gap-3">
              <Button type="submit" disabled={loading}>{loading ? 'Saving...' : 'Create Customer'}</Button>
              <Button type="button" variant="outline" onClick={() => router.back()}>Cancel</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
