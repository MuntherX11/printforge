'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { StatusBadge } from '@/components/ui/status-badge';
import { Dialog } from '@/components/ui/dialog';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { formatCurrency, formatDateTime } from '@/lib/utils';
import { Calculator, Plus } from 'lucide-react';

const jobStatuses = [
  { value: 'QUEUED', label: 'Queued' },
  { value: 'IN_PROGRESS', label: 'In Progress' },
  { value: 'PAUSED', label: 'Paused' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

export default function JobDetailPage() {
  const { id } = useParams();
  const [job, setJob] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showAddMaterial, setShowAddMaterial] = useState(false);
  const [materials, setMaterials] = useState<any[]>([]);
  const [spools, setSpools] = useState<any[]>([]);

  const load = () => api.get(`/jobs/${id}`).then(setJob).catch(console.error).finally(() => setLoading(false));
  useEffect(() => { load(); }, [id]);

  async function updateJob(data: any) {
    await api.patch(`/jobs/${id}`, data);
    load();
  }

  async function calculateCost() {
    await api.post(`/jobs/${id}/calculate-cost`);
    load();
  }

  async function openAddMaterial() {
    const mats = await api.get<any[]>('/materials');
    setMaterials(mats);
    setShowAddMaterial(true);
  }

  async function handleAddMaterial(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      await api.post(`/jobs/${id}/materials`, {
        materialId: form.get('materialId'),
        spoolId: form.get('spoolId') || undefined,
        gramsUsed: parseFloat(form.get('gramsUsed') as string),
        colorIndex: parseInt(form.get('colorIndex') as string) || 0,
      });
      setShowAddMaterial(false);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function onMaterialChange(materialId: string) {
    const s = await api.get<any[]>(`/spools?materialId=${materialId}`);
    setSpools(s);
  }

  if (loading) return <Loading />;
  if (!job) return <div className="text-center py-12 text-gray-500">Job not found</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{job.name}</h1>
          <p className="text-sm text-gray-500">
            {job.printer?.name || 'No printer'} | {job.assignedTo?.name || 'Unassigned'}
            {job.order && <> | <Link href={`/orders/${job.order.id}`} className="text-brand-600 hover:underline">{job.order.orderNumber}</Link></>}
          </p>
        </div>
        <div className="flex gap-2">
          <Select options={jobStatuses} value={job.status} onChange={e => updateJob({ status: e.target.value })} className="w-36" />
          <Button variant="outline" onClick={calculateCost}><Calculator className="h-4 w-4 mr-2" /> Calculate Cost</Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-gray-500">Print Duration</p>
            <div className="flex items-center gap-2 mt-1">
              <Input type="number" className="w-24 h-8 text-sm" defaultValue={job.printDuration ? Math.round(job.printDuration / 60) : ''} placeholder="min"
                onBlur={e => { const v = parseFloat(e.target.value); if (v) updateJob({ printDuration: v * 60 }); }} />
              <span className="text-xs text-gray-500">minutes</span>
            </div>
          </CardContent>
        </Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Color Changes</p><p className="text-lg font-bold">{job.colorChanges}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Status</p><StatusBadge status={job.status} /></CardContent></Card>
      </div>

      {job.totalCost && (
        <Card>
          <CardHeader><CardTitle>Cost Breakdown</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-5 gap-4 text-center">
              <div><p className="text-xs text-gray-500">Material</p><p className="text-lg font-bold">{formatCurrency(job.materialCost)}</p></div>
              <div><p className="text-xs text-gray-500">Machine</p><p className="text-lg font-bold">{formatCurrency(job.machineCost)}</p></div>
              <div><p className="text-xs text-gray-500">Waste</p><p className="text-lg font-bold">{formatCurrency(job.wasteCost)}</p></div>
              <div><p className="text-xs text-gray-500">Overhead</p><p className="text-lg font-bold">{formatCurrency(job.overheadCost)}</p></div>
              <div><p className="text-xs text-gray-500">Total</p><p className="text-lg font-bold text-brand-600">{formatCurrency(job.totalCost)}</p></div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Materials Used</CardTitle>
            <Button variant="outline" size="sm" onClick={openAddMaterial}><Plus className="h-4 w-4 mr-1" /> Add</Button>
          </div>
        </CardHeader>
        <CardContent>
          {(job.materials || []).length === 0 ? (
            <p className="text-sm text-gray-500">No materials added yet</p>
          ) : (
            <div className="space-y-2">
              {job.materials.map((m: any) => (
                <div key={m.id} className="flex items-center justify-between p-2 bg-gray-50 rounded">
                  <div>
                    <p className="text-sm font-medium">{m.material?.name} (T{m.colorIndex})</p>
                    <p className="text-xs text-gray-500">{m.gramsUsed}g @ {formatCurrency(m.costPerGram)}/g</p>
                  </div>
                  <p className="text-sm font-medium">{formatCurrency(m.gramsUsed * m.costPerGram)}</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {job.startedAt && (
        <Card>
          <CardHeader><CardTitle>Timeline</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-1 text-sm">
              <p>Started: {formatDateTime(job.startedAt)}</p>
              {job.completedAt && <p>Completed: {formatDateTime(job.completedAt)}</p>}
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={showAddMaterial} onClose={() => setShowAddMaterial(false)} title="Add Material">
        <form onSubmit={handleAddMaterial} className="space-y-4">
          <Select name="materialId" label="Material" options={[{ value: '', label: 'Select...' }, ...materials.map(m => ({ value: m.id, label: m.name }))]} onChange={e => onMaterialChange(e.target.value)} required />
          <Select name="spoolId" label="Spool (optional)" options={[{ value: '', label: 'Any' }, ...spools.map(s => ({ value: s.id, label: `${s.lotNumber || 'Spool'} (${Math.round(s.currentWeight)}g)` }))]} />
          <Input name="gramsUsed" label="Grams Used" type="number" step="0.1" required />
          <Input name="colorIndex" label="Color Index (T0, T1...)" type="number" defaultValue="0" min="0" />
          <div className="flex gap-3 justify-end">
            <Button type="button" variant="outline" onClick={() => setShowAddMaterial(false)}>Cancel</Button>
            <Button type="submit">Add</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
