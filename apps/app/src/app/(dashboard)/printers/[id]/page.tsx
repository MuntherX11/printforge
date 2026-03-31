'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Loading } from '@/components/ui/loading';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatDate, formatCurrency } from '@/lib/utils';
import { Pause, Play, XCircle, RefreshCw, Thermometer } from 'lucide-react';

export default function PrinterDetailPage() {
  const { id } = useParams();
  const [printer, setPrinter] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [liveStatus, setLiveStatus] = useState<any>(null);
  const [controlling, setControlling] = useState(false);

  const load = useCallback(() => {
    api.get(`/printers/${id}`).then(setPrinter).catch(console.error).finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Poll Moonraker status every 10s for this printer
  useEffect(() => {
    if (!printer?.moonrakerUrl) return;
    const fetchLive = () => api.get(`/moonraker/status/${id}`).then((r: any) => setLiveStatus(r.snapshot)).catch(() => {});
    fetchLive();
    const interval = setInterval(fetchLive, 10000);
    return () => clearInterval(interval);
  }, [id, printer?.moonrakerUrl]);

  async function handleControl(action: 'pause' | 'resume' | 'cancel') {
    setControlling(true);
    try {
      await api.post(`/moonraker/control/${id}/${action}`);
      // Refresh status
      const r: any = await api.get(`/moonraker/status/${id}`);
      setLiveStatus(r.snapshot);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setControlling(false);
    }
  }

  if (loading) return <Loading />;
  if (!printer) return <div className="text-center py-12 text-gray-500">Printer not found</div>;

  const isMoonraker = printer.connectionType === 'MOONRAKER' && printer.moonrakerUrl;
  const progress = liveStatus?.progress ? Math.round(liveStatus.progress * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{printer.name}</h1>
          <p className="text-sm text-gray-500">{printer.model} | {printer.connectionType}</p>
        </div>
        <div className="flex items-center gap-3">
          {isMoonraker && (
            <Button variant="outline" size="sm" onClick={() => {
              api.get(`/moonraker/status/${id}`).then((r: any) => setLiveStatus(r.snapshot)).catch(() => {});
            }}>
              <RefreshCw className="h-4 w-4 mr-1" /> Refresh
            </Button>
          )}
          <StatusBadge status={printer.status} />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Status</p><StatusBadge status={printer.status} /></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Hourly Rate</p><p className="text-lg font-bold">{formatCurrency(printer.hourlyRate)}/hr</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Total Jobs</p><p className="text-lg font-bold">{printer._count?.productionJobs || 0}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Last Seen</p><p className="text-sm">{printer.lastSeen ? formatDate(printer.lastSeen) : 'Never'}</p></CardContent></Card>
      </div>

      {/* Live Moonraker Status */}
      {isMoonraker && liveStatus && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Thermometer className="h-5 w-5" /> Live Status</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-4">
              <div>
                <p className="text-xs text-gray-500">Printer State</p>
                <p className="font-semibold capitalize">{liveStatus.printerState}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Nozzle Temp</p>
                <p className="font-semibold">
                  {liveStatus.extruder ? `${liveStatus.extruder.temperature.toFixed(1)}°C / ${liveStatus.extruder.target}°C` : '-'}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Bed Temp</p>
                <p className="font-semibold">
                  {liveStatus.heaterBed ? `${liveStatus.heaterBed.temperature.toFixed(1)}°C / ${liveStatus.heaterBed.target}°C` : '-'}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Current File</p>
                <p className="font-semibold truncate">{liveStatus.printStats?.filename || '-'}</p>
              </div>
            </div>

            {/* Progress bar */}
            {liveStatus.printStats?.state === 'printing' && (
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-gray-500">Progress</span>
                  <span className="font-medium">{progress}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-3">
                  <div className="bg-brand-500 h-3 rounded-full transition-all" style={{ width: `${progress}%` }} />
                </div>
              </div>
            )}

            {/* Control buttons */}
            <div className="flex gap-2">
              {liveStatus.printStats?.state === 'printing' && (
                <Button variant="outline" size="sm" onClick={() => handleControl('pause')} disabled={controlling}>
                  <Pause className="h-4 w-4 mr-1" /> Pause
                </Button>
              )}
              {liveStatus.printStats?.state === 'paused' && (
                <Button variant="outline" size="sm" onClick={() => handleControl('resume')} disabled={controlling}>
                  <Play className="h-4 w-4 mr-1" /> Resume
                </Button>
              )}
              {['printing', 'paused'].includes(liveStatus.printStats?.state) && (
                <Button variant="outline" size="sm" className="text-red-500" onClick={() => handleControl('cancel')} disabled={controlling}>
                  <XCircle className="h-4 w-4 mr-1" /> Cancel
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Recent Jobs</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Completed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(printer.productionJobs || []).map((j: any) => (
                <TableRow key={j.id}>
                  <TableCell><Link href={`/production/${j.id}`} className="text-brand-600 hover:underline">{j.name}</Link></TableCell>
                  <TableCell><StatusBadge status={j.status} /></TableCell>
                  <TableCell>{j.totalCost ? formatCurrency(j.totalCost) : '-'}</TableCell>
                  <TableCell>{j.startedAt ? formatDate(j.startedAt) : '-'}</TableCell>
                  <TableCell>{j.completedAt ? formatDate(j.completedAt) : '-'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
