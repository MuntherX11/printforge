'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Loading } from '@/components/ui/loading';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { Plus, Printer, Clock, Wrench } from 'lucide-react';
import { useToast } from '@/components/ui/toast';

export default function PrintersPage() {
  const { toast } = useToast();
  const [printers, setPrinters] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = () => api.get<any[]>('/printers').then(setPrinters).catch(console.error).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  async function handleAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAdding(true);
    const form = new FormData(e.currentTarget);
    try {
      await api.post('/printers', {
        name: form.get('name'),
        model: form.get('model') || undefined,
        connectionType: form.get('connectionType'),
        moonrakerUrl: form.get('moonrakerUrl') || undefined,
        hourlyRate: parseFloat(form.get('hourlyRate') as string) || 0.40,
        wattage: parseFloat(form.get('wattage') as string) || 200,
        markupMultiplier: parseFloat(form.get('markupMultiplier') as string) || 2.5,
      });
      setShowAdd(false);
      load();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setAdding(false);
    }
  }

  if (loading) return <Loading />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Printers</h1>
        <Button onClick={() => setShowAdd(true)}><Plus className="h-4 w-4 mr-2" /> Add Printer</Button>
      </div>

      {printers.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-gray-500"><Printer className="h-12 w-12 mx-auto mb-3 text-gray-400" /><p>No printers configured</p></CardContent></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {printers.map(p => (
            <Link key={p.id} href={`/printers/${p.id}`}>
              <Card className="hover:shadow-md transition-shadow cursor-pointer">
                <CardContent className="p-6">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold">{p.name}</h3>
                    <div className="flex items-center gap-2">
                      {p.status === 'MAINTENANCE' && (
                        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                          <Wrench className="h-3 w-3" /> In Maintenance
                        </span>
                      )}
                      {p.nextMaintenanceDue && new Date(p.nextMaintenanceDue) <= new Date() && p.status !== 'MAINTENANCE' && (
                        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                          <Clock className="h-3 w-3" /> Overdue
                        </span>
                      )}
                      <StatusBadge status={p.status} />
                    </div>
                  </div>
                  {p.model && <p className="text-sm text-gray-500">{p.model}</p>}
                  <div className="mt-3 flex items-center justify-between text-sm text-gray-500">
                    <span>{p.connectionType}</span>
                    <div className="flex items-center gap-3">
                      {p.totalPrintHours > 0 && <span>{Math.round(p.totalPrintHours)}h printed</span>}
                      <span>{p._count?.productionJobs || 0} jobs</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Dialog open={showAdd} onClose={() => setShowAdd(false)} title="Add Printer">
        <form onSubmit={handleAdd} className="space-y-4">
          <Input name="name" label="Name" placeholder="e.g. Ender 3 V3 SE #1" required />
          <Input name="model" label="Model" placeholder="e.g. Creality Ender 3 V3 SE" />
          <Select name="connectionType" label="Connection Type" options={[
            { value: 'MANUAL', label: 'Manual' },
            { value: 'MOONRAKER', label: 'Moonraker (Klipper)' },
            { value: 'CREALITY_CLOUD', label: 'Creality Cloud' },
          ]} />
          <Input name="moonrakerUrl" label="Moonraker URL" placeholder="http://192.168.1.50:7125" />
          <div className="grid grid-cols-3 gap-4">
            <Input name="hourlyRate" label="Hourly Rate (OMR)" type="number" step="0.001" defaultValue="0.400" />
            <Input name="wattage" label="Wattage (W)" type="number" step="1" defaultValue="200" />
            <Input name="markupMultiplier" label="Markup (×)" type="number" step="0.1" defaultValue="2.5" />
          </div>
          <div className="flex gap-3 justify-end">
            <Button type="button" variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button type="submit" disabled={adding}>{adding ? 'Adding...' : 'Add Printer'}</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
