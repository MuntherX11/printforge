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
import { Dialog } from '@/components/ui/dialog';

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
  const [showReject, setShowReject] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
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
    setRejecting(id);
    try {
      await api.post(`/quotes/customer/${id}/reject`);
      toast('success', 'Quote rejected');
      setShowReject(null);
      loadQuotes();
    } catch (err: any) {
      toast('error', err.message || 'Failed to reject quote');
    } finally {
      setRejecting(null);
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
                        <Button size="sm" variant="outline" onClick={() => setShowReject(q.id)}>
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

      <Dialog open={!!showReject} onClose={() => setShowReject(null)} title="Reject Quote">
        <div className="space-y-4 pt-2">
          <p className="text-sm text-gray-500">
            Are you sure you want to reject this quote? This action cannot be undone.
          </p>
          <div className="flex gap-3 justify-end pt-2">
            <Button variant="outline" onClick={() => setShowReject(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => showReject && handleReject(showReject)}
              disabled={!!rejecting}
            >
              {rejecting ? 'Rejecting...' : 'Reject Quote'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
