'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';

export default function NewDesignRequestPage() {
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [budget, setBudget] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setLoading(true);

    try {
      const project = await api.post<any>('/design-projects/customer/create', {
        title,
        brief: brief || undefined,
        budget: budget ? parseFloat(budget) : undefined,
      });
      toast('success', 'Design request submitted');
      router.push(`/dashboard/design/${project.id}`);
    } catch (err: any) {
      toast('error', err.message || 'Failed to submit request');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">New Design Request</h1>
      <Card>
        <CardHeader>
          <CardTitle>Describe your project</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Project Title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Custom phone case, figurine, prototype..."
              required
            />
            <Textarea
              label="Description / Brief"
              value={brief}
              onChange={e => setBrief(e.target.value)}
              placeholder="Describe what you need designed. Include dimensions, materials, any reference images..."
              rows={5}
            />
            <Input
              label="Budget (OMR, optional)"
              type="number"
              step="0.001"
              value={budget}
              onChange={e => setBudget(e.target.value)}
              placeholder="0.000"
            />
            <p className="text-xs text-gray-400">
              You can attach files (STL, images, PDF) after submitting the request.
            </p>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Submitting...' : 'Submit Request'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
