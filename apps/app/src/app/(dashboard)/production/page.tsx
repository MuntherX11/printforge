'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Loading } from '@/components/ui/loading';
import { EmptyState } from '@/components/ui/empty-state';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { useFormatCurrency } from '@/lib/locale-context';
import { useToast } from '@/components/ui/toast';
import { Plus, AlertTriangle, Shuffle, LayoutList, ListChecks, Hammer } from 'lucide-react';
import { CameraViewer } from '@/components/camera-viewer';

const statusFilters = ['ALL', 'QUEUED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'];

export default function ProductionPage() {
  const formatCurrency = useFormatCurrency();
  const { toast } = useToast();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('ALL');
  const [failStats, setFailStats] = useState<any>(null);
  const [view, setView] = useState<'list' | 'queue'>('list');
  const [queue, setQueue] = useState<any>(null);
  const [assigning, setAssigning] = useState(false);

  useEffect(() => {
    api.get('/jobs/stats/failures').then(setFailStats).catch(() => {});
  }, []);

  useEffect(() => {
    if (view === 'list') {
      setLoading(true);
      setData(null);
      const params = filter !== 'ALL' ? `?status=${filter}` : '';
      api.get(`/jobs${params}`).then(setData).catch(console.error).finally(() => setLoading(false));
    } else {
      setLoading(true);
      setQueue(null);
      api.get('/jobs/queue').then(setQueue).catch(console.error).finally(() => setLoading(false));
    }
  }, [filter, view]);

  async function handleAutoAssign() {
    setAssigning(true);
    try {
      const result = await api.post<any>('/jobs/auto-assign');
      if (result.assigned > 0) {
        toast('success', `Assigned ${result.assigned} job(s) to printers`);
      } else {
        toast('warning', result.reason || 'No unassigned jobs to distribute');
      }
      // Refresh current view
      if (view === 'list') {
        const params = filter !== 'ALL' ? `?status=${filter}` : '';
        api.get(`/jobs${params}`).then(setData);
      } else {
        api.get('/jobs/queue').then(setQueue);
      }
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setAssigning(false);
    }
  }

  if (loading) return <Loading />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Production</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleAutoAssign} disabled={assigning}>
            <Shuffle className="h-4 w-4 mr-2" /> {assigning ? 'Assigning...' : 'Auto-Assign'}
          </Button>
          <Link href="/production/new"><Button><Plus className="h-4 w-4 mr-2" /> New Job</Button></Link>
        </div>
      </div>

      {/* Failure Stats Summary */}
      {failStats && failStats.failedJobs > 0 && (
        <div className="grid gap-4 md:grid-cols-4">
          <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Total Jobs</p><p className="text-lg font-bold">{failStats.totalJobs}</p></CardContent></Card>
          <Card className="border-red-200 dark:border-red-800">
            <CardContent className="p-4">
              <p className="text-xs text-red-500 flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> Failed Jobs</p>
              <p className="text-lg font-bold text-red-600">{failStats.failedJobs}</p>
            </CardContent>
          </Card>
          <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Failure Rate</p><p className="text-lg font-bold">{failStats.failureRate}%</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Wasted Filament</p><p className="text-lg font-bold">{Math.round(failStats.totalWasteGrams)}g</p></CardContent></Card>
        </div>
      )}

      {/* View toggle + Filters */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2 flex-wrap">
          {view === 'list' && statusFilters.map(s => (
            <button key={s} onClick={() => setFilter(s)}
              className={`px-3 py-1 text-xs rounded-full border transition-colors ${filter === s ? 'bg-brand-600 text-white border-brand-600' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'}`}>
              {s.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
        <div className="flex gap-1 border rounded-lg p-0.5 dark:border-gray-600">
          <button onClick={() => { setView('list'); setFilter('ALL'); }} className={`px-3 py-1.5 text-xs rounded-md flex items-center gap-1 transition-colors ${view === 'list' ? 'bg-brand-600 text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
            <LayoutList className="h-3.5 w-3.5" /> List
          </button>
          <button onClick={() => setView('queue')} className={`px-3 py-1.5 text-xs rounded-md flex items-center gap-1 transition-colors ${view === 'queue' ? 'bg-brand-600 text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
            <ListChecks className="h-3.5 w-3.5" /> Queue
          </button>
        </div>
      </div>

      {/* List View */}
      {view === 'list' && (() => {
        const jobs: any[] = data?.data || data || [];
        return (
          <Card>
            <CardContent className="p-0">
              {jobs.length === 0 ? (
                <EmptyState
                  icon={<Hammer className="h-12 w-12" />}
                  title="No jobs found"
                  description={filter === 'ALL' ? 'Create your first production job to get started' : `no jobs with status "${filter.replace(/_/g, ' ')}"`}
                  action={filter === 'ALL' ? <Link href="/production/new"><Button size="sm"><Plus className="h-4 w-4 mr-1" /> New Job</Button></Link> : undefined}
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Job Name</TableHead>
                      <TableHead>Printer</TableHead>
                      <TableHead>Assigned To</TableHead>
                      <TableHead>Order</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Cost</TableHead>
                      <TableHead>Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {jobs.map((j: any) => (
                      <TableRow key={j.id}>
                        <TableCell>
                          <Link href={`/production/${j.id}`} className="font-medium text-brand-600 hover:underline">{j.name}</Link>
                        </TableCell>
                        <TableCell>{j.printer?.name || <span className="text-amber-500 text-xs font-medium">Unassigned</span>}</TableCell>
                        <TableCell>{j.assignedTo?.name || '-'}</TableCell>
                        <TableCell>{j.order ? <Link href={`/orders/${j.order.id}`} className="text-brand-600 hover:underline">{j.order.orderNumber}</Link> : '-'}</TableCell>
                        <TableCell><StatusBadge status={j.status} /></TableCell>
                        <TableCell>{j.totalCost ? formatCurrency(j.totalCost) : '-'}</TableCell>
                        <TableCell>{formatDate(j.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        );
      })()}

      {/* Queue View */}
      {view === 'queue' && queue && (
        <div className="space-y-4">
          {/* Unassigned jobs */}
          {queue.unassigned?.length > 0 && (
            <Card className="border-amber-200 dark:border-amber-800">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                    <Shuffle className="h-4 w-4" /> Unassigned ({queue.unassigned.length})
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader><TableRow><TableHead>#</TableHead><TableHead>Job</TableHead><TableHead>Order</TableHead><TableHead>Qty</TableHead><TableHead>Created</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {queue.unassigned.map((j: any, i: number) => (
                      <TableRow key={j.id}>
                        <TableCell className="text-gray-400 text-xs">{i + 1}</TableCell>
                        <TableCell><Link href={`/production/${j.id}`} className="text-brand-600 hover:underline text-sm">{j.name}</Link></TableCell>
                        <TableCell>{j.order ? <Link href={`/orders/${j.order.id}`} className="text-brand-600 hover:underline text-xs">{j.order.orderNumber}</Link> : '-'}</TableCell>
                        <TableCell className="text-sm">{j.quantityToProduce}</TableCell>
                        <TableCell className="text-xs text-gray-500">{formatDate(j.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* Per-printer queues */}
          {queue.printers?.map((p: any) => (
            <Card key={p.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center justify-between">
                  <Link href={`/printers/${p.id}`} className="hover:underline flex items-center gap-2">
                    {p.name}
                    {p.model && <span className="text-xs text-gray-400 font-normal">{p.model}</span>}
                  </Link>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">{p.productionJobs?.length ?? 0} in queue</span>
                    <StatusBadge status={p.status} />
                  </div>
                </CardTitle>
              </CardHeader>
              {/* Camera thumbnail — only shown if printer has a cameraUrl */}
              {p.cameraUrl && (
                <CardContent className="pb-2 pt-0">
                  <CameraViewer printerId={p.id} printerName={p.name} variant="compact" />
                </CardContent>
              )}
              {(p.productionJobs?.length ?? 0) > 0 ? (
                <CardContent className="p-0">
                  <Table>
                    <TableHeader><TableRow><TableHead>#</TableHead><TableHead>Job</TableHead><TableHead>Status</TableHead><TableHead>Order</TableHead><TableHead>Qty</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {p.productionJobs.map((j: any, i: number) => (
                        <TableRow key={j.id}>
                          <TableCell className="text-gray-400 text-xs">{i + 1}</TableCell>
                          <TableCell><Link href={`/production/${j.id}`} className="text-brand-600 hover:underline text-sm">{j.name}</Link></TableCell>
                          <TableCell><StatusBadge status={j.status} /></TableCell>
                          <TableCell>{j.order ? <Link href={`/orders/${j.order.id}`} className="text-brand-600 hover:underline text-xs">{j.order.orderNumber}</Link> : '-'}</TableCell>
                          <TableCell className="text-sm">{j.quantityToProduce}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              ) : (
                <CardContent><p className="text-xs text-gray-400">No jobs queued</p></CardContent>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
