'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Loading } from '@/components/ui/loading';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { useFormatCurrency } from '@/lib/locale-context';
import { PART_CATEGORIES, type PartCategory } from '@printforge/types';
import { Nut, Plus, Minus, Pencil, Trash2, AlertTriangle } from 'lucide-react';

interface Part {
  id: string;
  name: string;
  sku?: string | null;
  category: PartCategory;
  description?: string | null;
  unitCost: number;
  stockQty: number;
  reorderPoint: number;
  supplier?: string | null;
  locationId?: string | null;
  location?: { id: string; name: string } | null;
  isActive: boolean;
}

interface StorageLocation { id: string; name: string }

const CATEGORY_LABELS: Record<PartCategory, string> = {
  FASTENER: 'Fastener',
  ELECTRONICS: 'Electronics',
  HARDWARE: 'Hardware',
  SWITCH: 'Switch',
  PACKAGING: 'Packaging',
  ADHESIVE: 'Adhesive',
  OTHER: 'Other',
};

const emptyForm = {
  name: '', sku: '', category: 'OTHER' as PartCategory, description: '',
  unitCost: '', stockQty: '', reorderPoint: '', supplier: '', locationId: '',
};

export default function PartsPage() {
  const { toast } = useToast();
  const formatCurrency = useFormatCurrency();
  const [parts, setParts] = useState<Part[]>([]);
  const [locations, setLocations] = useState<StorageLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState('');

  const [editing, setEditing] = useState<Part | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Part | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load() {
    api.get<Part[]>('/parts')
      .then(r => setParts(Array.isArray(r) ? r : []))
      .catch((err: any) => toast('error', err?.message || 'Failed to load parts'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    api.get<StorageLocation[]>('/locations')
      .then(r => setLocations(Array.isArray(r) ? r : []))
      .catch(() => setLocations([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setShowForm(true);
  }

  function openEdit(p: Part) {
    setEditing(p);
    setForm({
      name: p.name,
      sku: p.sku || '',
      category: p.category,
      description: p.description || '',
      unitCost: String(p.unitCost ?? ''),
      stockQty: String(p.stockQty ?? ''),
      reorderPoint: String(p.reorderPoint ?? ''),
      supplier: p.supplier || '',
      locationId: p.locationId || '',
    });
    setShowForm(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return toast('error', 'Name is required');
    setSaving(true);
    const payload = {
      name: form.name.trim(),
      sku: form.sku.trim() || undefined,
      category: form.category,
      description: form.description.trim() || undefined,
      unitCost: parseFloat(form.unitCost) || 0,
      stockQty: parseInt(form.stockQty, 10) || 0,
      reorderPoint: parseInt(form.reorderPoint, 10) || 0,
      supplier: form.supplier.trim() || undefined,
      locationId: form.locationId || undefined,
    };
    try {
      if (editing) await api.patch(`/parts/${editing.id}`, payload);
      else await api.post('/parts', payload);
      toast('success', editing ? 'Part updated' : 'Part added');
      setShowForm(false);
      load();
    } catch (err: any) {
      toast('error', err?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function adjust(p: Part, delta: number) {
    setBusyId(p.id);
    try {
      await api.post(`/parts/${p.id}/adjust-stock`, { delta });
      setParts(prev => prev.map(x => x.id === p.id ? { ...x, stockQty: Math.max(0, x.stockQty + delta) } : x));
    } catch (err: any) {
      toast('error', err?.message || 'Failed to adjust stock');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    try {
      await api.delete(`/parts/${deleteTarget.id}`);
      toast('success', 'Part deleted');
      setDeleteTarget(null);
      load();
    } catch (err: any) {
      toast('error', err?.message || 'Failed to delete');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <Loading />;

  const visible = categoryFilter ? parts.filter(p => p.category === categoryFilter) : parts;
  const lowStock = parts.filter(p => p.isActive && p.reorderPoint > 0 && p.stockQty <= p.reorderPoint);
  const stockValue = parts.reduce((sum, p) => sum + p.unitCost * p.stockQty, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Parts</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Bought-in hardware priced per piece — NFC tags, heat inserts, keyrings, switches
          </p>
        </div>
        <Button onClick={openCreate}><Plus className="h-4 w-4 mr-2" /> Add Part</Button>
      </div>

      {/* Summary strip */}
      <dl className="grid grid-cols-2 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-gray-100 dark:divide-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
        <div className="px-5 py-4">
          <dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Distinct Parts</dt>
          <dd className="text-xl font-semibold tabular-nums dark:text-gray-100">{parts.length}</dd>
        </div>
        <div className="px-5 py-4">
          <dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Low Stock</dt>
          <dd className={`text-xl font-semibold tabular-nums ${lowStock.length > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>
            {lowStock.length}
          </dd>
        </div>
        <div className="px-5 py-4">
          <dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Stock Value</dt>
          <dd className="text-xl font-semibold tabular-nums dark:text-gray-100">{formatCurrency(stockValue)}</dd>
        </div>
      </dl>

      {lowStock.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-4 py-3">
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-amber-700 dark:text-amber-400">
            <strong>{lowStock.length}</strong> part{lowStock.length === 1 ? ' is' : 's are'} at or below the reorder point:{' '}
            {lowStock.slice(0, 4).map(p => p.name).join(', ')}{lowStock.length > 4 ? '…' : ''}
          </p>
        </div>
      )}

      <div className="w-full sm:w-56">
        <Select
          label="Filter by category"
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          options={[{ value: '', label: 'All categories' },
            ...PART_CATEGORIES.map(c => ({ value: c, label: CATEGORY_LABELS[c] }))]}
        />
      </div>

      <Card>
        <CardContent className="p-0">
          {visible.length === 0 ? (
            <EmptyState
              icon={<Nut className="h-12 w-12" />}
              title={parts.length === 0 ? 'No parts yet' : 'No parts in this category'}
              description={parts.length === 0
                ? 'Add NFC tags, heat inserts, keyrings and other bought-in hardware to price them into products.'
                : 'Try a different category filter.'}
              action={parts.length === 0 ? <Button size="sm" onClick={openCreate}>Add Part</Button> : undefined}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Unit Cost</TableHead>
                  <TableHead>In Stock</TableHead>
                  <TableHead>Reorder At</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map(p => {
                  const isLow = p.isActive && p.reorderPoint > 0 && p.stockQty <= p.reorderPoint;
                  return (
                    <TableRow key={p.id}>
                      <TableCell>
                        <div className="font-medium dark:text-gray-100">
                          {p.name}
                          {!p.isActive && <span className="ml-2 text-[10px] uppercase text-gray-400">inactive</span>}
                        </div>
                        {p.sku && <div className="text-xs text-gray-400 font-mono">{p.sku}</div>}
                      </TableCell>
                      <TableCell><Badge variant="default">{CATEGORY_LABELS[p.category]}</Badge></TableCell>
                      <TableCell className="tabular-nums">{formatCurrency(p.unitCost)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => adjust(p, -1)}
                            disabled={busyId === p.id || p.stockQty === 0}
                            aria-label={`Decrease ${p.name} stock`}
                            className="w-7 h-7 rounded border border-gray-300 dark:border-gray-600 flex items-center justify-center text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40"
                          >
                            <Minus className="h-3 w-3" />
                          </button>
                          <span className={`w-12 text-center font-semibold tabular-nums ${isLow ? 'text-red-600 dark:text-red-400' : 'dark:text-gray-200'}`}>
                            {p.stockQty}
                          </span>
                          <button
                            onClick={() => adjust(p, 1)}
                            disabled={busyId === p.id}
                            aria-label={`Increase ${p.name} stock`}
                            className="w-7 h-7 rounded border border-gray-300 dark:border-gray-600 flex items-center justify-center text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40"
                          >
                            <Plus className="h-3 w-3" />
                          </button>
                          <button
                            onClick={() => adjust(p, 10)}
                            disabled={busyId === p.id}
                            className="ml-1 text-xs px-1.5 py-1 rounded border border-gray-200 dark:border-gray-700 text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800"
                          >
                            +10
                          </button>
                        </div>
                      </TableCell>
                      <TableCell className="tabular-nums text-gray-500 dark:text-gray-400">
                        {p.reorderPoint > 0 ? p.reorderPoint : '—'}
                      </TableCell>
                      <TableCell className="text-gray-500 dark:text-gray-400">{p.location?.name || '—'}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="outline" size="sm" onClick={() => openEdit(p)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="destructive" size="sm" disabled={busyId === p.id} onClick={() => setDeleteTarget(p)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Create / edit */}
      <Dialog open={showForm} onClose={() => setShowForm(false)} title={editing ? 'Edit Part' : 'Add Part'}>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Input label="Name" required value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })} placeholder="NFC Tag 25mm" />
            <Input label="SKU" value={form.sku}
              onChange={e => setForm({ ...form, sku: e.target.value })} placeholder="NFC-25" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Select label="Category" value={form.category}
              onChange={e => setForm({ ...form, category: e.target.value as PartCategory })}
              options={PART_CATEGORIES.map(c => ({ value: c, label: CATEGORY_LABELS[c] }))} />
            <Input label="Unit Cost" type="number" step="0.001" min="0" value={form.unitCost}
              onChange={e => setForm({ ...form, unitCost: e.target.value })} placeholder="0.120" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input label="Stock Qty" type="number" min="0" value={form.stockQty}
              onChange={e => setForm({ ...form, stockQty: e.target.value })} placeholder="100" />
            <Input label="Reorder Point" type="number" min="0" value={form.reorderPoint}
              onChange={e => setForm({ ...form, reorderPoint: e.target.value })} placeholder="20" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input label="Supplier" value={form.supplier}
              onChange={e => setForm({ ...form, supplier: e.target.value })} placeholder="AliExpress" />
            <Select label="Location" value={form.locationId}
              onChange={e => setForm({ ...form, locationId: e.target.value })}
              options={[{ value: '', label: '— none —' }, ...locations.map(l => ({ value: l.id, label: l.name }))]} />
          </div>
          <Textarea label="Description" value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })} />
          <p className="text-xs text-gray-400">
            Reorder point 0 means stock isn&apos;t tracked for alerts.
          </p>
          <div className="flex gap-3 justify-end pt-2">
            <Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Part'}</Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete Part">
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Delete <strong>{deleteTarget?.name}</strong>? If it&apos;s used on any product BOM you&apos;ll need to remove it there first.
        </p>
        <div className="flex gap-3 justify-end">
          <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button variant="destructive" disabled={!!busyId} onClick={handleDelete}>Delete</Button>
        </div>
      </Dialog>
    </div>
  );
}
