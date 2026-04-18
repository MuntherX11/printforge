'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Loading } from '@/components/ui/loading';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';
import { Plus, Users, UserCheck, UserX } from 'lucide-react';

export default function CustomersPage() {
  const [data, setData] = useState<any>(null);
  const [pending, setPending] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<{ id: string; name: string } | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const { toast } = useToast();

  function loadData() {
    Promise.all([
      api.get('/customers'),
      api.get('/auth/customers/pending').catch(() => []),
    ]).then(([customers, pendingList]) => {
      setData(customers);
      setPending(Array.isArray(pendingList) ? pendingList : []);
    }).catch(console.error).finally(() => setLoading(false));
  }

  useEffect(() => { loadData(); }, []);

  async function handleApprove(id: string) {
    setApprovingId(id);
    try {
      await api.post(`/auth/customers/${id}/approve`);
      toast('success', 'Customer approved');
      loadData();
    } catch (err: any) {
      toast('error', err.message || 'Failed to approve');
    } finally {
      setApprovingId(null);
    }
  }

  async function handleReject() {
    if (!rejectTarget) return;
    setRejecting(true);
    try {
      await api.post(`/auth/customers/${rejectTarget.id}/reject`);
      setRejectTarget(null);
      toast('success', 'Customer rejected');
      loadData();
    } catch (err: any) {
      toast('error', err.message || 'Failed to reject');
    } finally {
      setRejecting(false);
    }
  }

  if (loading) return <Loading />;

  const customers = data?.data || data || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Customers</h1>
        <Link href="/customers/new">
          <Button><Plus className="h-4 w-4 mr-2" /> Add Customer</Button>
        </Link>
      </div>

      {pending.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge variant="warning">{pending.length}</Badge>
              Pending Approvals
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Signed Up</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map((c: any) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell>{c.email}</TableCell>
                    <TableCell>{c.phone || '-'}</TableCell>
                    <TableCell>{formatDate(c.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button size="sm" disabled={approvingId === c.id} onClick={() => handleApprove(c.id)}>
                          <UserCheck className="h-4 w-4 mr-1" />
                          {approvingId === c.id ? 'Approving...' : 'Approve'}
                        </Button>
                        <Button size="sm" variant="destructive" disabled={approvingId === c.id} onClick={() => setRejectTarget({ id: c.id, name: c.name })}>
                          <UserX className="h-4 w-4 mr-1" />
                          Reject
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {customers.length === 0 ? (
            <EmptyState
              icon={<Users className="h-12 w-12" />}
              title="No customers yet"
              description="Add your first customer to get started"
              action={<Link href="/customers/new"><Button size="sm">Add Customer</Button></Link>}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Orders</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.map((c: any) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link href={`/customers/${c.id}`} className="font-medium text-brand-600 hover:underline">
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell>{c.email || '-'}</TableCell>
                    <TableCell>{c.phone || '-'}</TableCell>
                    <TableCell>{c._count?.orders || 0}</TableCell>
                    <TableCell>{formatDate(c.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Dialog open={!!rejectTarget} onClose={() => setRejectTarget(null)} title="Reject Customer">
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Reject signup from <strong>{rejectTarget?.name}</strong>? They will not be able to log in.
        </p>
        <div className="flex gap-3 justify-end">
          <Button variant="outline" onClick={() => setRejectTarget(null)}>Back</Button>
          <Button variant="destructive" disabled={rejecting} onClick={handleReject}>
            {rejecting ? 'Rejecting...' : 'Reject'}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
