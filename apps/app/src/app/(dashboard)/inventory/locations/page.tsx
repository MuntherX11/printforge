'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Dialog } from '@/components/ui/dialog';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { Plus, MapPin, Trash2, ArrowLeft, Pencil, Search } from 'lucide-react';
import { useToast } from '@/components/ui/toast';

interface AssignableSpool {
  id: string;
  printforgeId: string | null;
  color: string | null;
  type: string | null;
  brand: string | null;
  materialName: string | null;
  gramsRemaining: number;
  assignedHere: boolean;
}

export default function LocationsPage() {
  const { toast } = useToast();
  const [locations, setLocations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showDelete, setShowDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // --- spool assignment ---
  const [spoolTarget, setSpoolTarget] = useState<any | null>(null);
  const [spoolOptions, setSpoolOptions] = useState<AssignableSpool[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [loadingSpools, setLoadingSpools] = useState(false);
  const [savingSpools, setSavingSpools] = useState(false);
  const [spoolFilter, setSpoolFilter] = useState('');

  async function openSpoolPicker(location: any) {
    setSpoolTarget(location);
    setSpoolFilter('');
    setLoadingSpools(true);
    try {
      const rows = await api.get<AssignableSpool[]>(`/locations/${location.id}/assignable-spools`);
      const list = Array.isArray(rows) ? rows : [];
      setSpoolOptions(list);
      setPicked(new Set(list.filter((s) => s.assignedHere).map((s) => s.id)));
    } catch (err: any) {
      toast('error', err?.message || 'Could not load spools');
      setSpoolTarget(null);
    } finally {
      setLoadingSpools(false);
    }
  }

  async function saveSpools() {
    if (!spoolTarget) return;
    setSavingSpools(true);
    try {
      const res = await api.put<{ assigned: number; removed: number }>(
        `/locations/${spoolTarget.id}/spools`,
        { spoolIds: Array.from(picked) },
      );
      toast('success', `${res.assigned} spool${res.assigned === 1 ? '' : 's'} in ${spoolTarget.name}`);
      setSpoolTarget(null);
      load();
    } catch (err: any) {
      toast('error', err?.message || 'Could not save');
    } finally {
      setSavingSpools(false);
    }
  }

  const load = () => api.get<any[]>('/locations').then(setLocations).catch((err: any) => {
    toast('error', err?.message || 'Failed to load');
  }).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  async function handleAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAdding(true);
    const form = new FormData(e.currentTarget);
    try {
      await api.post('/locations', {
        name: form.get('name') as string,
        description: form.get('description') as string || undefined,
      });
      setShowAdd(false);
      load();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: string) {
    setDeleting(id);
    try {
      await api.delete(`/locations/${id}`);
      setShowDelete(null);
      load();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setDeleting(null);
    }
  }

  const spoolQuery = spoolFilter.trim().toLowerCase();
  const visibleSpools = spoolQuery
    ? spoolOptions.filter((s) =>
        [s.color, s.type, s.brand, s.materialName, s.printforgeId]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(spoolQuery)),
      )
    : spoolOptions;

  if (loading) return <Loading />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/inventory">
            <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4" /></Button>
          </Link>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Storage Locations</h1>
        </div>
        <Button onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4 mr-2" /> Add Location
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {locations.length === 0 ? (
            <div className="py-12 text-center text-gray-500">
              <MapPin className="h-12 w-12 mx-auto mb-3 text-gray-400" />
              <p>No storage locations yet</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Spools</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {locations.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="font-medium">{l.name}</TableCell>
                    <TableCell className="text-gray-500">{l.description || '-'}</TableCell>
                    <TableCell>{l._count?.spools || 0}</TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => openSpoolPicker(l)}>
                          <Pencil className="h-3.5 w-3.5 mr-1.5" /> Spools
                        </Button>
                        <button onClick={() => setShowDelete(l.id)} className="text-red-400 hover:text-red-600">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={showAdd} onClose={() => setShowAdd(false)} title="Add Storage Location">
        <form onSubmit={handleAdd} className="space-y-4">
          <Input name="name" label="Location Name" placeholder="e.g. Shelf A, Rack 2" required />
          <Input name="description" label="Description" placeholder="Optional description" />
          <div className="flex gap-3 justify-end">
            <Button type="button" variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button type="submit" disabled={adding}>{adding ? 'Adding...' : 'Add Location'}</Button>
          </div>
        </form>
      </Dialog>

      {/* Which spools live in this location. Identified by colour, type, brand
          and grams remaining — the way you'd recognise one on the shelf. */}
      <Dialog
        open={!!spoolTarget}
        onClose={() => setSpoolTarget(null)}
        title={`Spools in ${spoolTarget?.name ?? ''}`}
        className="max-w-2xl"
      >
        {loadingSpools ? (
          <p className="py-8 text-center text-sm text-gray-500">Loading spools…</p>
        ) : spoolOptions.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-500">
            No unassigned spools available. Every spool is already stored somewhere else.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                value={spoolFilter}
                onChange={(e) => setSpoolFilter(e.target.value)}
                placeholder="Filter by colour, type or brand…"
                className="w-full h-10 pl-9 pr-3 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm dark:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              />
            </div>

            <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>{picked.size} selected</span>
              <div className="flex gap-3">
                <button type="button" className="hover:underline" onClick={() => setPicked(new Set(visibleSpools.map((s) => s.id)))}>Select all shown</button>
                <button type="button" className="hover:underline" onClick={() => setPicked(new Set())}>Clear</button>
              </div>
            </div>

            <div className="max-h-80 overflow-y-auto rounded-md border dark:border-gray-700 divide-y dark:divide-gray-700">
              {visibleSpools.length === 0 ? (
                <p className="py-6 text-center text-sm text-gray-500">Nothing matches that filter.</p>
              ) : visibleSpools.map((s) => {
                const on = picked.has(s.id);
                return (
                  <label
                    key={s.id}
                    className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800"
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => {
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
                          return next;
                        });
                      }}
                      className="rounded border-gray-300 text-brand-600"
                    />
                    <span className="flex-1 min-w-0">
                      <span className="text-sm font-medium dark:text-gray-100">
                        {s.color || s.materialName || 'Unnamed'}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">
                        {[s.type, s.brand].filter(Boolean).join(' · ') || '—'}
                      </span>
                      {s.printforgeId && (
                        <span className="block text-[11px] text-gray-400 font-mono">{s.printforgeId}</span>
                      )}
                    </span>
                    <span className="text-sm tabular-nums text-gray-600 dark:text-gray-300 flex-shrink-0">
                      {s.gramsRemaining}g
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-gray-400">
              Unticking a spool removes it from this location without deleting it.
            </p>
          </div>
        )}
        <div className="flex gap-3 justify-end pt-4">
          <Button type="button" variant="outline" onClick={() => setSpoolTarget(null)}>Cancel</Button>
          <Button type="button" onClick={saveSpools} disabled={savingSpools || loadingSpools}>
            {savingSpools ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </Dialog>

      <Dialog open={!!showDelete} onClose={() => setShowDelete(null)} title="Delete Location">
        <div className="space-y-4 pt-2">
          <p className="text-sm text-gray-500">
            Are you sure you want to delete this storage location?
          </p>
          <div className="flex gap-3 justify-end pt-2">
            <Button variant="outline" onClick={() => setShowDelete(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => showDelete && handleDelete(showDelete)} disabled={!!deleting}>
              {deleting ? 'Deleting...' : 'Delete Location'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
