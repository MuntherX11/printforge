'use client';

import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loading } from '@/components/ui/loading';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { FileText, Check, X } from 'lucide-react';

const statusVariant: Record<string, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  DRAFT: 'default',
  SENT: 'info',
  ACCEPTED: 'success',
  REJECTED: 'error',
  EXPIRED: 'warning',
};

export default function CustomerQuotesPage() {
  const [quotes, setQuotes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  function loadQuotes() {
    api.get<any>('/quotes/customer/my-quotes')
      .then(r => setQuotes(r.data || r || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadQuotes(); }, []);

  async function handleAccept(id: string) {
    try {
      await api.post(`/quotes/customer/${id}/accept`);
      toast('success', 'Quote accepted');
      loadQuotes();
    } catch (err: any) {
      toast('error', err.message || 'Failed to accept quote');
    }
  }

  async function handleReject(id: string) {
    if (!confirm('Reject this quote?')) return;
    try {
      await api.post(`/quotes/customer/${id}/reject`);
      toast('success', 'Quote rejected');
      loadQuotes();
    } catch (err: any) {
      toast('error', err.message || 'Failed to reject quote');
    }
  }

  if (loading) return <Loading />;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">My Quotes</h1>

      {quotes.length === 0 ? (
        <EmptyState
          icon={<FileText className="h-12 w-12" />}
          title="No quotes yet"
          description="Your quotes will appear here once created"
        />
      ) : (
        <div className="space-y-4">
          {quotes.map((q: any) => (
            <Card key={q.id}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-3">
                      <span className="font-semibold text-gray-900">{q.quoteNumber}</span>
                      <Badge variant={statusVariant[q.status] || 'default'}>{q.status}</Badge>
                    </div>
                    <div className="text-sm text-gray-500 mt-1">
                      {q._count?.items || 0} item(s)
                      {q.validUntil && (
                        <span className="ml-3">
                          Valid until {formatDate(q.validUntil)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-lg font-bold text-brand-600">{q.total?.toFixed(3)} OMR</span>
                    {(q.status === 'SENT' || q.status === 'DRAFT') && (
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => handleAccept(q.id)}>
                          <Check className="h-4 w-4 mr-1" /> Accept
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => handleReject(q.id)}>
                          <X className="h-4 w-4 mr-1" /> Reject
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
