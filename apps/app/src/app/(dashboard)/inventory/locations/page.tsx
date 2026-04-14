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
import { Plus, MapPin, Trash2, ArrowLeft } from 'lucide-react';
import { useToast } from '@/components/ui/toast';

export default function LocationsPage() {
  const { toast } = useToast();
  const [locations, setLocations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showDelete, setShowDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = () => api.get<any[]>('/locations').then(setLocations).catch((err) => {
    console.error(err);
    toast('error', 'Failed to load locations');
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

  if (loading) return <Loading />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/inventory">
            <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4" /></Button>
          </Link>
          <h1 className="text-2xl font-bold text-gray-900">Storage Locations</h1>
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
                      <button onClick={() => setShowDelete(l.id)} className="text-red-400 hover:text-red-600">
                        <Trash2 className="h-4 w-4" />
                      </button>
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
