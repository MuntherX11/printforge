'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Loading } from '@/components/ui/loading';
import { EmptyState } from '@/components/ui/empty-state';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { Palette } from 'lucide-react';

const statusVariant: Record<string, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  REQUESTED: 'warning',
  ASSIGNED: 'info',
  IN_PROGRESS: 'info',
  REVIEW: 'warning',
  REVISION: 'warning',
  APPROVED: 'success',
  QUOTED: 'success',
  IN_PRODUCTION: 'info',
  COMPLETED: 'success',
  CANCELLED: 'error',
};

export default function DesignPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    api.get<any>(`/design-projects?${params}`)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [statusFilter]);

  if (loading) return <Loading />;

  const projects = data?.data || data || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Design Projects</h1>
        <Select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          options={[
            { value: '', label: 'All Statuses' },
            { value: 'REQUESTED', label: 'Requested' },
            { value: 'ASSIGNED', label: 'Assigned' },
            { value: 'IN_PROGRESS', label: 'In Progress' },
            { value: 'REVIEW', label: 'In Review' },
            { value: 'REVISION', label: 'Revision Needed' },
            { value: 'APPROVED', label: 'Approved' },
            { value: 'QUOTED', label: 'Quoted' },
            { value: 'IN_PRODUCTION', label: 'In Production' },
            { value: 'COMPLETED', label: 'Completed' },
          ]}
        />
      </div>

      <Card>
        <CardContent className="p-0">
          {projects.length === 0 ? (
            <EmptyState
              icon={<Palette className="h-12 w-12" />}
              title="No design projects"
              description="Design requests from customers will appear here"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Project</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Assigned To</TableHead>
                  <TableHead>Messages</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((p: any) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <Link href={`/design/${p.id}`} className="font-medium text-brand-600 hover:underline">
                        {p.projectNumber} — {p.title}
                      </Link>
                    </TableCell>
                    <TableCell>{p.customer?.name || '-'}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant[p.status] || 'default'}>{p.status}</Badge>
                    </TableCell>
                    <TableCell>{p.assignedTo?.name || <span className="text-gray-400">Unassigned</span>}</TableCell>
                    <TableCell>{p._count?.comments || 0}</TableCell>
                    <TableCell>{formatDate(p.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
