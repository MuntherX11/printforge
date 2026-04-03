'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loading } from '@/components/ui/loading';
import { EmptyState } from '@/components/ui/empty-state';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { Palette, Plus } from 'lucide-react';

const statusVariant: Record<string, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  REQUESTED: 'warning', ASSIGNED: 'info', IN_PROGRESS: 'info', REVIEW: 'warning',
  REVISION: 'warning', APPROVED: 'success', QUOTED: 'success', IN_PRODUCTION: 'info',
  COMPLETED: 'success', CANCELLED: 'error',
};

export default function CustomerDesignPage() {
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<any>('/design-projects/customer/my-projects')
      .then(r => setProjects(r.data || r || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Design Requests</h1>
        <Link href="/dashboard/design/new">
          <Button><Plus className="h-4 w-4 mr-2" /> New Request</Button>
        </Link>
      </div>

      {projects.length === 0 ? (
        <EmptyState
          icon={<Palette className="h-12 w-12" />}
          title="No design requests"
          description="Submit a design request and our team will work on it"
          action={<Link href="/dashboard/design/new"><Button size="sm">New Request</Button></Link>}
        />
      ) : (
        <div className="space-y-4">
          {projects.map((p: any) => (
            <Link key={p.id} href={`/dashboard/design/${p.id}`}>
              <Card className="hover:border-brand-300 transition-colors cursor-pointer">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-3">
                        <span className="font-semibold">{p.projectNumber}</span>
                        <span className="text-gray-600">{p.title}</span>
                        <Badge variant={statusVariant[p.status] || 'default'}>{p.status}</Badge>
                      </div>
                      <div className="text-sm text-gray-500 mt-1">
                        {p._count?.comments || 0} messages | {p._count?.revisions || 0} revisions
                        {p.estimatedDelivery && (
                          <span className="ml-3">Delivery: {formatDate(p.estimatedDelivery)}</span>
                        )}
                      </div>
                    </div>
                    <span className="text-xs text-gray-400">{formatDate(p.createdAt)}</span>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
