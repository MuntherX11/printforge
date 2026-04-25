'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useWebSocket } from '@/lib/use-websocket';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { StatusBadge } from '@/components/ui/status-badge';
import { Loading } from '@/components/ui/loading';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { useFormatCurrency } from '@/lib/locale-context';
import { useToast } from '@/components/ui/toast';
import { Dialog } from '@/components/ui/dialog';
import { Pause, Play, XCircle, RefreshCw, Thermometer, DollarSign, Settings, Trash2, Wrench, Clock, Camera } from 'lucide-react';
import { CameraViewer } from '@/components/camera-viewer';

export default function PrinterDetailPage() {
  const formatCurrency = useFormatCurrency();
  const { id } = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const [printer, setPrinter] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [liveStatus, setLiveStatus] = useState<any>(null);
  const { printerStatuses } = useWebSocket();
  const [controlling, setControlling] = useState(false);
  const [savingCosting, setSavingCosting] = useState(false);
  const [savingDetails, setSavingDetails] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeletePrinter, setShowDeletePrinter] = useState(false);
  const [showCompleteMaintenance, setShowCompleteMaintenance] = useState<string | null>(null);
  const [completingMaintenance, setCompletingMaintenance] = useState(false);
  const [showMaintenanceDialog, setShowMaintenanceDialog] = useState(false);
  const [maintenanceLogs, setMaintenanceLogs] = useState<any[]>([]);
  const [formKey, setFormKey] = useState(0); // forces form re-render on save

  const load = useCallback(() => {
    return api.get(`/printers/${id}`).then(setPrinter).catch(console.error).finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Initial fetch of Moonraker status, then rely on WebSocket for updates
  useEffect(() => {
    if (!printer?.moonrakerUrl) return;
    api.get(`/moonraker/status/${id}`).then((r: any) => setLiveStatus(r.snapshot)).catch(() => {});
  }, [id, printer?.moonrakerUrl]);

  // Apply live WebSocket status updates for this printer
  useEffect(() => {
    const ws = printerStatuses[id as string];
    if (ws) setLiveStatus(ws);
  }, [id, printerStatuses]);

  async function handleControl(action: 'pause' | 'resume' | 'cancel') {
    setControlling(true);
    try {
      await api.post(`/moonraker/control/${id}/${action}`);
      // Refresh status
      const r: any = await api.get(`/moonraker/status/${id}`);
      setLiveStatus(r.snapshot);
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setControlling(false);
    }
  }

  // Load maintenance logs when printer loads
  useEffect(() => {
    if (printer?.id) {
      api.get<any[]>(`/printers/${printer.id}/maintenance`).then(setMaintenanceLogs).catch(() => {});
    }
  }, [printer?.id]);

  async function handleStartMaintenance(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      await api.post(`/printers/${id}/maintenance`, {
        type: form.get('type'),
        description: form.get('description'),
        cost: parseFloat(form.get('cost') as string) || undefined,
        notes: form.get('notes') || undefined,
      });
      setShowMaintenanceDialog(false);
      load();
      api.get<any[]>(`/printers/${id}/maintenance`).then(setMaintenanceLogs);
    } catch (err: any) {
      toast('error', err.message);
    }
  }

  async function handleCompleteMaintenance(logId: string, downtimeMinutes?: number) {
    setCompletingMaintenance(true);
    try {
      await api.patch(`/printers/${id}/maintenance/${logId}/complete`, {
        downtimeMinutes,
      });
      load();
      api.get<any[]>(`/printers/${id}/maintenance`).then(setMaintenanceLogs);
      setShowCompleteMaintenance(null);
      toast('success', 'Maintenance completed — printer restored to IDLE');
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setCompletingMaintenance(false);
    }
  }

  if (loading) return <Loading />;
  if (!printer) return <div className="text-center py-12 text-gray-500">Printer not found</div>;

  const isMoonraker = printer.connectionType === 'MOONRAKER' && printer.moonrakerUrl;
  const hasLiveStatus = ['MOONRAKER', 'CREALITY_WS'].includes(printer.connectionType) && printer.moonrakerUrl;
  const progress = liveStatus?.progress ? Math.round(liveStatus.progress * 100) : 0;
  const isMaintenanceDue = printer.nextMaintenanceDue && new Date(printer.nextMaintenanceDue) <= new Date();
  const activeMaintenance = maintenanceLogs.find((l: any) => !l.completedDate);

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
          {printer.status === 'MAINTENANCE' && activeMaintenance ? (
            <Button variant="outline" size="sm" className="text-green-600 border-green-300" onClick={() => setShowCompleteMaintenance(activeMaintenance.id)}>
              <Wrench className="h-4 w-4 mr-1" /> Complete Maintenance
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setShowMaintenanceDialog(true)}>
              <Wrench className="h-4 w-4 mr-1" /> Start Maintenance
            </Button>
          )}
          <StatusBadge status={printer.status} />
        </div>
      </div>

      {isMaintenanceDue && printer.status !== 'MAINTENANCE' && (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800">
          <Clock className="h-5 w-5 text-amber-500 shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">Maintenance Overdue</p>
            <p className="text-xs text-amber-600 dark:text-amber-300">
              Due since {formatDate(printer.nextMaintenanceDue)} | {Math.round(printer.totalPrintHours || 0)} hours printed
              {printer.maintenanceIntervalHours && <> | Interval: every {printer.maintenanceIntervalHours}h</>}
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-6">
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Status</p><StatusBadge status={printer.status} /></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Hourly Rate</p><p className="text-lg font-bold">{formatCurrency(printer.hourlyRate)}/hr</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Markup</p><p className="text-lg font-bold">{printer.markupMultiplier ?? 2.5}x</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Total Jobs</p><p className="text-lg font-bold">{printer._count?.productionJobs || 0}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Print Hours</p><p className="text-lg font-bold">{Math.round(printer.totalPrintHours || 0)}h</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Last Seen</p><p className="text-sm">{printer.lastSeen ? formatDate(printer.lastSeen) : 'Never'}</p></CardContent></Card>
      </div>

      {/* Printer Details — Edit (key forces re-render with fresh defaultValues) */}
      <Card key={`details-${formKey}`}>
        <CardHeader><CardTitle className="flex items-center gap-2"><Settings className="h-5 w-5" /> Printer Details</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={async (e) => {
            e.preventDefault();
            setSavingDetails(true);
            const form = new FormData(e.currentTarget);
            try {
              await api.patch(`/printers/${id}`, {
                name: form.get('name'),
                model: form.get('model') || undefined,
                connectionType: form.get('connectionType'),
                moonrakerUrl: form.get('moonrakerUrl') || undefined,
                cameraUrl: form.get('cameraUrl') || undefined,
              });
              await load();
              setFormKey(k => k + 1);
              const savedConnectionType = form.get('connectionType') as string;
              if (savedConnectionType === 'CREALITY_WS') {
                await api.post(`/moonraker/reconnect/${id}`).catch(() => {});
              }
              toast('success', 'Printer details saved');
            } catch (err: any) {
              toast('error', err.message);
            } finally {
              setSavingDetails(false);
            }
          }} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Input name="name" label="Printer Name" defaultValue={printer.name} required />
              <Input name="model" label="Model" defaultValue={printer.model || ''} />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Select name="connectionType" label="Connection Type" defaultValue={printer.connectionType} options={[
                { value: 'MANUAL', label: 'Manual' },
                { value: 'MOONRAKER', label: 'Moonraker (Klipper)' },
                { value: 'CREALITY_WS', label: 'Creality LAN (WebSocket)' },
                { value: 'CREALITY_CLOUD', label: 'Creality Cloud' },
              ]} />
              <div>
                {printer.connectionType === 'CREALITY_WS' ? (
                  <>
                    <Input name="moonrakerUrl" label="Printer IP Address" placeholder="192.168.1.55" defaultValue={printer.moonrakerUrl || ''} />
                    <p className="mt-1 text-xs text-gray-500">Local IP of the printer. Connects via WebSocket on port 9999.</p>
                  </>
                ) : (
                  <>
                    <Input name="moonrakerUrl" label="Moonraker URL" placeholder="http://192.168.1.50:7125" defaultValue={printer.moonrakerUrl || ''} />
                    <p className="mt-1 text-xs text-gray-500">Local IPs, .local hostnames, or Tailscale IPs (100.x.x.x) for remote printers.</p>
                  </>
                )}
              </div>
            </div>
            <div>
              <Input name="cameraUrl" label="Camera Stream URL (optional)" placeholder="http://192.168.100.37:8000" defaultValue={printer.cameraUrl || ''} />
              <p className="mt-1 text-xs text-gray-500">MJPEG stream URL (mjpg-streamer, ustreamer, OctoPrint webcam). Must be on your local network.</p>
            </div>
            <div className="flex items-center justify-between">
              <Button type="submit" size="sm" disabled={savingDetails}>{savingDetails ? 'Saving...' : 'Save Details'}</Button>
              <Button type="button" variant="outline" size="sm" className="text-red-500 border-red-300 hover:bg-red-50" disabled={deleting} onClick={() => setShowDeletePrinter(true)}>
                <Trash2 className="h-4 w-4 mr-1" /> {deleting ? 'Deleting...' : 'Delete Printer'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Camera Feed */}
      {printer.cameraUrl && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Camera className="h-5 w-5" /> Camera Feed</CardTitle>
          </CardHeader>
          <CardContent>
            <CameraViewer printerId={id as string} printerName={printer.name} variant="full" />
          </CardContent>
        </Card>
      )}

      {/* Live Status (Moonraker + Creality WS) */}
      {hasLiveStatus && liveStatus && (
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

      {/* Costing & Pricing */}
      <Card key={`costing-${formKey}`}>
        <CardHeader><CardTitle className="flex items-center gap-2"><DollarSign className="h-5 w-5" /> Costing & Pricing</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={async (e) => {
            e.preventDefault();
            setSavingCosting(true);
            const form = new FormData(e.currentTarget);
            try {
              await api.patch(`/printers/${id}`, {
                hourlyRate: parseFloat(form.get('hourlyRate') as string) || 0.40,
                wattage: parseFloat(form.get('wattage') as string) || 200,
                markupMultiplier: parseFloat(form.get('markupMultiplier') as string) || 2.5,
              });
              await load();
              setFormKey(k => k + 1);
              toast('success', 'Costing settings saved');
            } catch (err: any) {
              toast('error', err.message);
            } finally {
              setSavingCosting(false);
            }
          }} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <Input name="hourlyRate" label="Machine Hourly Rate (OMR/hr)" type="number" step="0.001" defaultValue={printer.hourlyRate ?? 0.40}  />
              <Input name="wattage" label="Power Consumption (Watts)" type="number" step="1" defaultValue={printer.wattage ?? 200} />
              <Input name="markupMultiplier" label="Markup Multiplier" type="number" step="0.1" defaultValue={printer.markupMultiplier ?? 2.5} />
            </div>
            <p className="text-xs text-gray-400">
              <strong>Hourly Rate:</strong> covers wear, depreciation & maintenance.{' '}
              <strong>Markup:</strong> total cost × this multiplier = suggested price (e.g. 2.5x means material cost of 3.79 OMR → ~9.50 OMR price).{' '}
              Filament cost is auto-calculated from the material&apos;s spool price in inventory.
            </p>
            <Button type="submit" size="sm" disabled={savingCosting}>{savingCosting ? 'Saving...' : 'Save Costing'}</Button>
          </form>
        </CardContent>
      </Card>

      {/* Maintenance Settings & History */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Wrench className="h-5 w-5" /> Maintenance</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const hours = parseFloat(form.get('intervalHours') as string);
            try {
              await api.patch(`/printers/${id}/maintenance-settings`, {
                maintenanceIntervalHours: hours > 0 ? hours : null,
              });
              load();
              toast('success', 'Maintenance interval updated');
            } catch (err: any) {
              toast('error', err.message);
            }
          }} className="flex items-end gap-4">
            <Input name="intervalHours" label="Maintenance Interval (hours)" type="number" step="1" min="0" defaultValue={printer.maintenanceIntervalHours || ''} placeholder="e.g. 500" className="w-48" />
            <Button type="submit" size="sm" variant="outline">Save</Button>
            {printer.nextMaintenanceDue && <span className="text-xs text-gray-500 pb-2">Next due: {formatDate(printer.nextMaintenanceDue)}</span>}
          </form>

          {maintenanceLogs.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Downtime</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {maintenanceLogs.map((l: any) => (
                  <TableRow key={l.id}>
                    <TableCell><span className="text-xs font-medium px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700">{l.type}</span></TableCell>
                    <TableCell className="max-w-xs truncate">{l.description}</TableCell>
                    <TableCell>
                      {l.completedDate
                        ? <span className="text-xs text-green-600 font-medium">Completed</span>
                        : <span className="text-xs text-amber-600 font-medium">In Progress</span>}
                    </TableCell>
                    <TableCell>{l.downtimeMinutes ? `${l.downtimeMinutes} min` : '-'}</TableCell>
                    <TableCell>{l.cost ? formatCurrency(l.cost) : '-'}</TableCell>
                    <TableCell>{formatDate(l.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-gray-500">No maintenance records yet.</p>
          )}
        </CardContent>
      </Card>

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

      <Dialog open={showMaintenanceDialog} onClose={() => setShowMaintenanceDialog(false)} title="Start Maintenance">
        <form onSubmit={handleStartMaintenance} className="space-y-4">
          <Select name="type" label="Maintenance Type" options={[
            { value: 'SCHEDULED', label: 'Scheduled' },
            { value: 'UNSCHEDULED', label: 'Unscheduled' },
            { value: 'CALIBRATION', label: 'Calibration' },
          ]} required />
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
            <textarea name="description" required rows={3} className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm" placeholder="e.g. Nozzle replacement, belt tensioning..." />
          </div>
          <Input name="cost" label="Estimated Cost (optional)" type="number" step="0.01" min="0" />
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes (optional)</label>
            <textarea name="notes" rows={2} className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm" />
          </div>
          <p className="text-xs text-gray-500">The printer will be set to MAINTENANCE status until you complete it.</p>
          <div className="flex gap-3 justify-end">
            <Button type="button" variant="outline" onClick={() => setShowMaintenanceDialog(false)}>Cancel</Button>
            <Button type="submit">Start Maintenance</Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={showDeletePrinter} onClose={() => setShowDeletePrinter(false)} title="Delete Printer">
        <div className="space-y-4 pt-2">
          <p className="text-sm text-gray-500">
            Are you sure you want to delete printer "{printer.name}"? Completed jobs will be preserved but unlinked from this printer.
          </p>
          <div className="flex gap-3 justify-end pt-2">
            <Button variant="outline" onClick={() => setShowDeletePrinter(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={async () => {
                setDeleting(true);
                try {
                  await api.delete(`/printers/${id}`);
                  router.push('/printers');
                } catch (err: any) {
                  toast('error', err.message);
                  setDeleting(false);
                  setShowDeletePrinter(false);
                }
              }}
              disabled={deleting}
            >
              {deleting ? 'Deleting...' : 'Delete Printer'}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={!!showCompleteMaintenance} onClose={() => setShowCompleteMaintenance(null)} title="Complete Maintenance">
        <form onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const mins = parseInt(form.get('downtimeMinutes') as string) || 0;
          showCompleteMaintenance && handleCompleteMaintenance(showCompleteMaintenance, mins);
        }} className="space-y-4">
          <Input name="downtimeMinutes" label="Downtime in minutes (optional)" type="number" min="0" placeholder="e.g. 60" />
          <p className="text-xs text-gray-500">Completing this will restore the printer status to IDLE.</p>
          <div className="flex gap-3 justify-end">
            <Button type="button" variant="outline" onClick={() => setShowCompleteMaintenance(null)}>Cancel</Button>
            <Button type="submit" disabled={completingMaintenance}>{completingMaintenance ? 'Completing...' : 'Complete Maintenance'}</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
