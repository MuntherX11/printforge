'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { useFormatCurrency } from '@/lib/locale-context';
import { Plus, Pencil, Trash2, ScanLine, QrCode } from 'lucide-react';
import { SpoolLabelScanner } from '@/components/spool-label-scanner';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/components/ui/toast';

export default function MaterialDetailPage() {
  const formatCurrency = useFormatCurrency();
  const { id } = useParams();
  const router = useRouter();
  const { user } = useAuth();
  const { toast } = useToast();
  const [material, setMaterial] = useState<any>(null);
  const [locations, setLocations] = useState<any[]>([]);
  const [showScanner, setShowScanner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showAddSpool, setShowAddSpool] = useState(false);
  const [showEditMaterial, setShowEditMaterial] = useState(false);
  const [editingSpool, setEditingSpool] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [selectedSpoolIds, setSelectedSpoolIds] = useState<Set<string>>(new Set());
  const [printingLabels, setPrintingLabels] = useState(false);
  const [scannedFields, setScannedFields] = useState<any>(null);
  const [showDeleteMaterial, setShowDeleteMaterial] = useState(false);
  const [deletingMaterial, setDeletingMaterial] = useState(false);
  const [showDeleteSpool, setShowDeleteSpool] = useState<string | null>(null);
  const [deletingSpool, setDeletingSpool] = useState<string | null>(null);
  const [showDeactivateSpool, setShowDeactivateSpool] = useState<string | null>(null);
  const [deactivatingSpool, setDeactivatingSpool] = useState<string | null>(null);

  const load = () => {
    Promise.all([
      api.get(`/materials/${id}`),
      api.get<any[]>('/locations'),
    ]).then(([m, locs]) => {
      setMaterial(m);
      setLocations(locs);
    }).catch(console.error).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [id]);

  async function handleAddSpool(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    const form = new FormData(e.currentTarget);
    try {
      await api.post('/spools', {
        materialId: id,
        initialWeight: parseFloat(form.get('initialWeight') as string),
        currentWeight: form.get('currentWeight') ? parseFloat(form.get('currentWeight') as string) : undefined,
        spoolWeight: parseFloat(form.get('spoolWeight') as string) || 200,
        purchasePrice: parseFloat(form.get('purchasePrice') as string) || undefined,
        lotNumber: form.get('lotNumber') as string || undefined,
        locationId: form.get('locationId') as string || undefined,
      });
      setShowAddSpool(false);
      load();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleEditMaterial(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    const form = new FormData(e.currentTarget);
    try {
      await api.patch(`/materials/${id}`, {
        name: form.get('name') as string,
        type: form.get('type') as string,
        color: form.get('color') as string || null,
        brand: form.get('brand') as string || null,
        costPerGram: parseFloat(form.get('costPerGram') as string),
        density: parseFloat(form.get('density') as string) || 1.24,
        reorderPoint: parseFloat(form.get('reorderPoint') as string) || 500,
      });
      setShowEditMaterial(false);
      load();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleEditSpool(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    const form = new FormData(e.currentTarget);
    try {
      await api.patch(`/spools/${editingSpool.id}`, {
        currentWeight: parseFloat(form.get('currentWeight') as string),
        locationId: form.get('locationId') as string || null,
        isActive: form.get('isActive') === 'true',
      });
      setEditingSpool(null);
      load();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeactivateSpool(spoolId: string) {
    setDeactivatingSpool(spoolId);
    try {
      await api.patch(`/spools/${spoolId}`, { isActive: false });
      setShowDeactivateSpool(null);
      load();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setDeactivatingSpool(null);
    }
  }

  async function handleDeleteSpool(spoolId: string) {
    setDeletingSpool(spoolId);
    try {
      await api.delete(`/spools/${spoolId}`);
      setShowDeleteSpool(null);
      load();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setDeletingSpool(null);
    }
  }

  async function handleDeleteMaterial() {
    setDeletingMaterial(true);
    try {
      await api.delete(`/materials/${id}`);
      router.push('/inventory');
    } catch (err: any) {
      toast('error', err.message);
      setDeletingMaterial(false);
    }
  }

  function toggleSpoolSelection(spoolId: string) {
    setSelectedSpoolIds((prev) => {
      const next = new Set(prev);
      if (next.has(spoolId)) next.delete(spoolId);
      else next.add(spoolId);
      return next;
    });
  }

  function toggleAllSpools() {
    const allIds = (material?.spools || []).map((s: any) => s.id);
    if (selectedSpoolIds.size === allIds.length) {
      setSelectedSpoolIds(new Set());
    } else {
      setSelectedSpoolIds(new Set(allIds));
    }
  }

  async function handlePrintQrLabels() {
    if (selectedSpoolIds.size === 0) return;
    setPrintingLabels(true);
    try {
      const res = await fetch('/api/spools/qr-labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ spoolIds: Array.from(selectedSpoolIds) }),
      });
      if (!res.ok) throw new Error('Failed to generate QR labels');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setPrintingLabels(false);
    }
  }

  if (loading) return <Loading />;
  if (!material) return <div className="text-center py-12 text-gray-500 dark:text-gray-400">Material not found</div>;

  const totalStock = (material.spools || []).reduce((sum: number, s: any) => sum + s.currentWeight, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{material.name}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">{material.brand} | {material.type} | {material.color}</p>
        </div>
        <div className="flex gap-2">
          {(user?.role === 'ADMIN' || user?.role === 'OPERATOR') && (
            <Button variant="outline" onClick={() => setShowEditMaterial(true)}>
              <Pencil className="h-4 w-4 mr-2" /> Edit
            </Button>
          )}
          {user?.role === 'ADMIN' && (
            <Button variant="destructive" onClick={() => setShowDeleteMaterial(true)}>
              <Trash2 className="h-4 w-4 mr-2" /> Delete
            </Button>
          )}
          {(user?.role === 'ADMIN' || user?.role === 'OPERATOR') && (
            <>
              <Button variant="outline" onClick={() => setShowScanner(true)}>
                <ScanLine className="h-4 w-4 mr-2" /> Scan Label
              </Button>
              <Button
                variant="outline"
                onClick={handlePrintQrLabels}
                disabled={selectedSpoolIds.size === 0 || printingLabels}
              >
                <QrCode className="h-4 w-4 mr-2" />
                {printingLabels ? 'Generating...' : `Print QR Labels (${selectedSpoolIds.size})`}
              </Button>
              <Button onClick={() => setShowAddSpool(true)}>
                <Plus className="h-4 w-4 mr-2" /> Add Spool
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500 dark:text-gray-400">Cost/gram</p><p className="text-lg font-bold dark:text-gray-100">{formatCurrency(material.costPerGram)}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500 dark:text-gray-400">Total Stock</p><p className="text-lg font-bold dark:text-gray-100">{Math.round(totalStock)}g</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500 dark:text-gray-400">Active Spools</p><p className="text-lg font-bold dark:text-gray-100">{material._count?.spools || 0}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500 dark:text-gray-400">Reorder Point</p><p className="text-lg font-bold dark:text-gray-100">{material.reorderPoint}g</p></CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Spools</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    checked={(material.spools || []).length > 0 && selectedSpoolIds.size === (material.spools || []).length}
                    onChange={toggleAllSpools}
                    className="rounded border-gray-300 dark:border-gray-600"
                  />
                </TableHead>
                <TableHead>PF-ID</TableHead>
                <TableHead>Lot #</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Initial</TableHead>
                <TableHead>Current</TableHead>
                <TableHead>Used</TableHead>
                <TableHead>Purchase Price</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Added</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(material.spools || []).map((s: any) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={selectedSpoolIds.has(s.id)}
                      onChange={() => toggleSpoolSelection(s.id)}
                      className="rounded border-gray-300 dark:border-gray-600"
                    />
                  </TableCell>
                  <TableCell>
                    {s.printforgeId ? (
                      <span className="font-mono text-xs bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded text-gray-800 dark:text-gray-200">
                        {s.printforgeId}
                      </span>
                    ) : '-'}
                  </TableCell>
                  <TableCell>{s.lotNumber || '-'}</TableCell>
                  <TableCell>{s.location?.name || '-'}</TableCell>
                  <TableCell>{s.initialWeight}g</TableCell>
                  <TableCell className="font-mono font-medium">{Math.round(s.currentWeight)}g</TableCell>
                  <TableCell>{Math.round(s.initialWeight - s.currentWeight)}g</TableCell>
                  <TableCell>{s.purchasePrice ? formatCurrency(s.purchasePrice) : '-'}</TableCell>
                  <TableCell>
                    <Badge variant={s.isActive ? 'success' : 'default'}>
                      {s.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatDate(s.createdAt)}</TableCell>
                  <TableCell>
                    {(user?.role === 'ADMIN' || user?.role === 'OPERATOR') && (
                      <div className="flex gap-1">
                        <button
                          onClick={() => setEditingSpool(s)}
                          className="p-1 text-gray-400 hover:text-brand-600 dark:hover:text-brand-400"
                          title="Edit spool"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        {s.isActive && (
                          <button
                            onClick={() => setShowDeactivateSpool(s.id)}
                            className="p-1 text-gray-400 hover:text-yellow-600"
                            title="Deactivate spool"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                        {user?.role === 'ADMIN' && (
                          <button
                            onClick={() => setShowDeleteSpool(s.id)}
                            className="p-1 text-gray-400 hover:text-red-600"
                            title="Delete spool permanently"
                          >
                            <Trash2 className="h-4 w-4 text-red-300" />
                          </button>
                        )}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Add Spool Dialog */}
      <Dialog open={showAddSpool} onClose={() => { setShowAddSpool(false); setScannedFields(null); }} title="Add Spool">
        {scannedFields && (
          <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md">
            <p className="text-xs font-medium text-blue-700 dark:text-blue-300 mb-1">Scanned Label Data</p>
            <div className="flex flex-wrap gap-2 text-xs text-blue-600 dark:text-blue-400">
              {scannedFields.brand && <span>Brand: {scannedFields.brand}</span>}
              {scannedFields.materialType && <span>Type: {scannedFields.materialType}</span>}
              {scannedFields.color && <span>Color: {scannedFields.color}</span>}
              {scannedFields.weight && <span>Weight: {scannedFields.weight}g</span>}
              {scannedFields.diameter && <span>Dia: {scannedFields.diameter}mm</span>}
              {scannedFields.printTemp && <span>Temp: {scannedFields.printTemp}°C</span>}
            </div>
            {(scannedFields.brand || scannedFields.materialType || scannedFields.color) && (
              <button
                type="button"
                onClick={() => {
                  setShowEditMaterial(true);
                  setScannedFields(null);
                }}
                className="mt-2 text-xs text-blue-700 dark:text-blue-300 underline hover:no-underline"
              >
                Review Material Details
              </button>
            )}
            {scannedFields.rawText && (
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-blue-700 dark:text-blue-300 hover:underline">
                  Show raw OCR text
                </summary>
                <pre className="mt-2 p-2 bg-white dark:bg-gray-800 rounded max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-gray-700 dark:text-gray-300">
                  {scannedFields.rawText}
                </pre>
              </details>
            )}
          </div>
        )}
        <form onSubmit={(e) => { handleAddSpool(e); setScannedFields(null); }} className="space-y-4">
          <Input name="initialWeight" label="Net Filament Weight (g)" type="number" step="0.1" defaultValue={scannedFields?.weight || ''} required />
          <Input name="currentWeight" label="Current Weight (g) — leave blank if new spool" type="number" step="0.1" />
          <Input name="spoolWeight" label="Empty Spool Weight (g)" type="number" defaultValue="200" />
          <Input name="purchasePrice" label="Purchase Price" type="number" step="0.001" />
          <Input name="lotNumber" label="Lot Number" />
          {locations.length > 0 && (
            <div className="space-y-1">
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Storage Location</label>
              <select name="locationId" className="flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100">
                <option value="">No location</option>
                {locations.map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          )}
          <div className="flex gap-3 justify-end">
            <Button type="button" variant="outline" onClick={() => setShowAddSpool(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Adding...' : 'Add Spool'}</Button>
          </div>
        </form>
      </Dialog>

      {/* Edit Material Dialog */}
      <Dialog open={showEditMaterial} onClose={() => setShowEditMaterial(false)} title="Edit Material">
        <form onSubmit={handleEditMaterial} className="space-y-4">
          <Input name="name" label="Name" defaultValue={material.name} required />
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Type</label>
            <select name="type" defaultValue={material.type} className="flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100">
              {['PLA', 'PETG', 'ABS', 'TPU', 'ASA', 'NYLON', 'RESIN', 'OTHER'].map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <Input name="color" label="Color" defaultValue={material.color || ''} />
          <Input name="brand" label="Brand" defaultValue={material.brand || ''} />
          <Input name="costPerGram" label="Cost per Gram" type="number" step="0.001" defaultValue={material.costPerGram} required />
          <Input name="density" label="Density (g/cm3)" type="number" step="0.01" defaultValue={material.density} />
          <Input name="reorderPoint" label="Reorder Point (g)" type="number" defaultValue={material.reorderPoint} />
          <div className="flex gap-3 justify-end">
            <Button type="button" variant="outline" onClick={() => setShowEditMaterial(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save Changes'}</Button>
          </div>
        </form>
      </Dialog>

      {/* Edit Spool Dialog */}
      <Dialog open={!!editingSpool} onClose={() => setEditingSpool(null)} title="Edit Spool">
        {editingSpool && (
          <form onSubmit={handleEditSpool} className="space-y-4">
            <Input name="currentWeight" label="Current Weight (g)" type="number" step="0.1" defaultValue={editingSpool.currentWeight} required />
            <div className="space-y-1">
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Storage Location</label>
              <select name="locationId" defaultValue={editingSpool.locationId || ''} className="flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100">
                <option value="">No location</option>
                {locations.map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Status</label>
              <select name="isActive" defaultValue={editingSpool.isActive ? 'true' : 'false'} className="flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100">
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </select>
            </div>
            <div className="flex gap-3 justify-end">
              <Button type="button" variant="outline" onClick={() => setEditingSpool(null)}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save Changes'}</Button>
            </div>
          </form>
        )}
      </Dialog>

      {/* Spool Label Scanner */}
      <SpoolLabelScanner
        open={showScanner}
        onClose={() => setShowScanner(false)}
        onResult={(fields) => {
          setScannedFields(fields);
          setShowAddSpool(true);
        }}
      />

      <Dialog open={showDeleteMaterial} onClose={() => setShowDeleteMaterial(false)} title="Delete Material">
        <div className="space-y-4 pt-2">
          <p className="text-sm text-gray-500">
            Are you sure you want to delete this material and all its spools? This cannot be undone.
          </p>
          <div className="flex gap-3 justify-end pt-2">
            <Button variant="outline" onClick={() => setShowDeleteMaterial(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDeleteMaterial} disabled={deletingMaterial}>
              {deletingMaterial ? 'Deleting...' : 'Delete Material'}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={!!showDeleteSpool} onClose={() => setShowDeleteSpool(null)} title="Delete Spool">
        <div className="space-y-4 pt-2">
          <p className="text-sm text-gray-500">
            Permanently delete this spool? This cannot be undone.
          </p>
          <div className="flex gap-3 justify-end pt-2">
            <Button variant="outline" onClick={() => setShowDeleteSpool(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => showDeleteSpool && handleDeleteSpool(showDeleteSpool)} disabled={!!deletingSpool}>
              {deletingSpool ? 'Deleting...' : 'Delete Spool'}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={!!showDeactivateSpool} onClose={() => setShowDeactivateSpool(null)} title="Deactivate Spool">
        <div className="space-y-4 pt-2">
          <p className="text-sm text-gray-500">
            Deactivate this spool?
          </p>
          <div className="flex gap-3 justify-end pt-2">
            <Button variant="outline" onClick={() => setShowDeactivateSpool(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => showDeactivateSpool && handleDeactivateSpool(showDeactivateSpool)} disabled={!!deactivatingSpool}>
              {deactivatingSpool ? 'Deactivating...' : 'Deactivate Spool'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
