'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { formatDate, formatCurrency } from '@/lib/utils';
import { Plus } from 'lucide-react';

export default function MaterialDetailPage() {
  const { id } = useParams();
  const [material, setMaterial] = useState<any>(null);
  const [locations, setLocations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddSpool, setShowAddSpool] = useState(false);
  const [addingDpool, setAddingSpool] = useState(false);

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
    setAddingSpool(true);
    const form = new FormData(e.currentTarget);
    try {
      await api.post('/spools', {
        materialId: id,
        initialWeight: parseFloat(form.get('initialWeight') as string),
        spoolWeight: parseFloat(form.get('spoolWeight') as string) || 200,
        purchasePrice: parseFloat(form.get('purchasePrice') as string) || undefined,
        lotNumber: form.get('lotNumber') as string || undefined,
        locationId: form.get('locationId') as string || undefined,
      });
      setShowAddSpool(false);
      load();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setAddingSpool(false);
    }
  }

  if (loading) return <Loading />;
  if (!material) return <div className="text-center py-12 text-gray-500">Material not found</div>;

  const totalStock = (material.spools || []).reduce((sum: number, s: any) => sum + s.currentWeight, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{material.name}</h1>
          <p className="text-sm text-gray-500">{material.brand} | {material.type} | {material.color}</p>
        </div>
        <Button onClick={() => setShowAddSpool(true)}>
          <Plus className="h-4 w-4 mr-2" /> Add Spool
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Cost/gram</p><p className="text-lg font-bold">{formatCurrency(material.costPerGram)}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Total Stock</p><p className="text-lg font-bold">{Math.round(totalStock)}g</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Active Spools</p><p className="text-lg font-bold">{material._count?.spools || 0}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Reorder Point</p><p className="text-lg font-bold">{material.reorderPoint}g</p></CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Spools</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lot #</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Initial</TableHead>
                <TableHead>Current</TableHead>
                <TableHead>Used</TableHead>
                <TableHead>Purchase Price</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Added</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(material.spools || []).map((s: any) => (
                <TableRow key={s.id}>
                  <TableCell>{s.lotNumber || '-'}</TableCell>
                  <TableCell>{s.location?.name || '-'}</TableCell>
                  <TableCell>{s.initialWeight}g</TableCell>
                  <TableCell className="font-mono font-medium">{Math.round(s.currentWeight)}g</TableCell>
                  <TableCell>{Math.round(s.initialWeight - s.currentWeight)}g</TableCell>
                  <TableCell>{s.purchasePrice ? formatCurrency(s.purchasePrice) : '-'}</TableCell>
                  <TableCell>
                    <Badge className={s.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}>
                      {s.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatDate(s.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={showAddSpool} onClose={() => setShowAddSpool(false)} title="Add Spool">
        <form onSubmit={handleAddSpool} className="space-y-4">
          <Input name="initialWeight" label="Net Filament Weight (g)" type="number" step="0.1" required />
          <Input name="spoolWeight" label="Empty Spool Weight (g)" type="number" defaultValue="200" />
          <Input name="purchasePrice" label="Purchase Price" type="number" step="0.001" />
          <Input name="lotNumber" label="Lot Number" />
          {locations.length > 0 && (
            <div className="space-y-1">
              <label className="text-sm font-medium text-gray-700">Storage Location</label>
              <select name="locationId" className="flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
                <option value="">No location</option>
                {locations.map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          )}
          <div className="flex gap-3 justify-end">
            <Button type="button" variant="outline" onClick={() => setShowAddSpool(false)}>Cancel</Button>
            <Button type="submit" disabled={addingDpool}>{addingDpool ? 'Adding...' : 'Add Spool'}</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
