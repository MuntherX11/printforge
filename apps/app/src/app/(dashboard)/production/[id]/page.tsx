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
import { formatDateTime } from '@/lib/utils';
import { useFormatCurrency } from '@/lib/locale-context';
import { Calculator, Plus, AlertTriangle, RefreshCw, Camera, CheckCircle, XCircle, Loader2, Clock } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { CameraViewer } from '@/components/camera-viewer';
import { useWebSocket } from '@/lib/use-websocket';

/** Format seconds into "1h 23m remaining" */
function fmtRemaining(secs: number): string {
  if (secs <= 60) return 'finishing up…';
  const hrs = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  return hrs > 0 ? `${hrs}h ${mins}m remaining` : `${mins}m remaining`;
}

const jobStatuses = [
  { value: 'QUEUED', label: 'Queued' },
  { value: 'IN_PROGRESS', label: 'In Progress' },
  { value: 'PAUSED', label: 'Paused' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

export default function JobDetailPage() {
  const formatCurrency = useFormatCurrency();
  const { id } = useParams();
  const { toast } = useToast();
  const [job, setJob] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showAddMaterial, setShowAddMaterial] = useState(false);
  const [showFailDialog, setShowFailDialog] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [showReprintDialog, setShowReprintDialog] = useState(false);
  const [submittingFail, setSubmittingFail] = useState(false);
  const [submittingReprint, setSubmittingReprint] = useState(false);
  const [savingMaterial, setSavingMaterial] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [materials, setMaterials] = useState<any[]>([]);
  const [spools, setSpools] = useState<any[]>([]);
  const [showCamera, setShowCamera] = useState(false);
  const [gcodeCheck, setGcodeCheck] = useState<{ loading: boolean; match: boolean | null; printing: string | null }>({ loading: false, match: null, printing: null });

  const ws = useWebSocket();
  const liveProgress = ws.jobProgress[id as string];

  const load = () => api.get(`/jobs/${id}`).then(setJob).catch(console.error).finally(() => setLoading(false));
  useEffect(() => { load(); }, [id]);

  // Auto-reload when the job completes/fails via WebSocket
  useEffect(() => {
    if (!liveProgress) return;
    if (liveProgress.status === 'COMPLETED' || liveProgress.status === 'FAILED') {
      load();
    }
  }, [liveProgress?.status]);

  // Auto-reload when the job auto-starts (QUEUED → IN_PROGRESS detected by printer bridge)
  useEffect(() => {
    if (!liveProgress) return;
    if (liveProgress.status === 'IN_PROGRESS' && job?.status === 'QUEUED') {
      load();
    }
  }, [liveProgress?.status, job?.status]);

  // GCode verification: compare what Moonraker is actually printing vs what the job expects
  useEffect(() => {
    if (!job) return;
    if (job.status !== 'IN_PROGRESS') return;
    if (!job.printer?.moonrakerUrl || !job.gcodeFilename) return;

    setGcodeCheck({ loading: true, match: null, printing: null });
    api.get<any>(`/moonraker/status/${job.printer.id}`)
      .then(res => {
        const printing = res?.snapshot?.printStats?.filename ?? null;
        const match = printing ? printing === job.gcodeFilename : null;
        setGcodeCheck({ loading: false, match, printing });
      })
      .catch(() => setGcodeCheck({ loading: false, match: null, printing: null }));
  }, [id, job?.status]);

  async function updateJob(data: any) {
    try {
      await api.patch(`/jobs/${id}`, data);
      toast('success', 'Job updated');
      load();
    } catch (err: any) {
      toast('error', err.message);
    }
  }

  async function calculateCost() {
    try {
      await api.post(`/jobs/${id}/calculate-cost`);
      toast('success', 'Cost calculated');
      load();
    } catch (err: any) {
      toast('error', err.message);
    }
  }

  async function openAddMaterial() {
    const mats = await api.get<any[]>('/materials');
    setMaterials(mats);
    setShowAddMaterial(true);
  }

  async function handleAddMaterial(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSavingMaterial(true);
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
      toast('error', err.message);
    } finally {
      setSavingMaterial(false);
    }
  }

  async function onMaterialChange(materialId: string) {
    const s = await api.get<any[]>(`/spools?materialId=${materialId}`);
    setSpools(s);
  }

  async function handleFail(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSubmittingFail(true);
    try {
      await api.post(`/jobs/${id}/fail`, {
        failureReason: form.get('failureReason'),
        wasteGrams: parseFloat(form.get('wasteGrams') as string) || 0,
      });
      setShowFailDialog(false);
      load();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setSubmittingFail(false);
    }
  }

  async function handleCancel() {
    setCancelling(true);
    try {
      await api.patch(`/jobs/${id}`, { status: 'CANCELLED' });
      setShowCancelDialog(false);
      toast('success', 'Job cancelled');
      load();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setCancelling(false);
    }
  }

  async function handleReprint() {
    setSubmittingReprint(true);
    try {
      const newJob = await api.post<any>(`/jobs/${id}/reprint`);
      setShowReprintDialog(false);
      toast('success', `Reprint job created: ${newJob.name}`);
      load();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setSubmittingReprint(false);
    }
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
        <div className="flex gap-2 flex-wrap items-center">
          {/* GCode match indicator — only for IN_PROGRESS Moonraker jobs with a gcodeFilename */}
          {job.status === 'IN_PROGRESS' && job.gcodeFilename && job.printer?.moonrakerUrl && (
            <span className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium ${
              gcodeCheck.loading ? 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400' :
              gcodeCheck.match === true ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
              gcodeCheck.match === false ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
              'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
            }`}
              title={gcodeCheck.printing ? `Printing: ${gcodeCheck.printing}` : 'Could not read printer state'}
            >
              {gcodeCheck.loading ? <Loader2 className="h-3 w-3 animate-spin" /> :
               gcodeCheck.match === true ? <CheckCircle className="h-3 w-3" /> :
               gcodeCheck.match === false ? <XCircle className="h-3 w-3" /> :
               <Camera className="h-3 w-3" />}
              {gcodeCheck.loading ? 'Checking gcode…' :
               gcodeCheck.match === true ? 'Correct gcode' :
               gcodeCheck.match === false ? `Wrong gcode (${gcodeCheck.printing ?? 'unknown'})` :
               'Gcode unknown'}
            </span>
          )}

          {/* Camera button — only when IN_PROGRESS and printer has a camera */}
          {job.status === 'IN_PROGRESS' && job.printer?.cameraUrl && (
            <Button variant="outline" onClick={() => setShowCamera(true)}>
              <Camera className="h-4 w-4 mr-2" /> View Camera
            </Button>
          )}

          <Select options={jobStatuses} value={job.status} onChange={e => updateJob({ status: e.target.value })} className="w-36" />
          <Button variant="outline" onClick={calculateCost}><Calculator className="h-4 w-4 mr-2" /> Calculate Cost</Button>
          {!['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status) && (
            <>
              <Button variant="outline" className="text-red-600 border-red-300 hover:bg-red-50" onClick={() => setShowFailDialog(true)}>
                <AlertTriangle className="h-4 w-4 mr-2" /> Mark Failed
              </Button>
              <Button variant="outline" className="text-gray-600 border-gray-300 hover:bg-gray-50" onClick={() => setShowCancelDialog(true)}>
                Cancel Job
              </Button>
            </>
          )}
          {job.status === 'FAILED' && (
            <Button variant="outline" onClick={() => setShowReprintDialog(true)}>
              <RefreshCw className="h-4 w-4 mr-2" /> Reprint
            </Button>
          )}
        </div>
      </div>

      {/* Live progress bar — visible only when printer is actively printing this job */}
      {(job.status === 'IN_PROGRESS' || liveProgress) && (
        <Card className={liveProgress ? 'border-brand-300 dark:border-brand-700' : ''}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-gray-600 dark:text-gray-400 flex items-center gap-1.5">
                {liveProgress ? (
                  <><span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse" /> Printing — live progress</>
                ) : (
                  <><span className="inline-block w-2 h-2 rounded-full bg-amber-400" /> In progress</>
                )}
              </p>
              <span className="text-sm font-bold text-brand-600 dark:text-brand-400 tabular-nums">
                {liveProgress ? `${liveProgress.progress}%` : '—'}
              </span>
            </div>
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5 overflow-hidden">
              <div
                className="bg-brand-500 h-2.5 rounded-full transition-all duration-1000 ease-linear"
                style={{ width: `${liveProgress?.progress ?? 0}%` }}
              />
            </div>
            {/* Remaining / elapsed time row */}
            <div className="flex items-center justify-between mt-2">
              <p className="text-xs text-gray-400 dark:text-gray-500">
                {liveProgress ? 'Updated live via WebSocket' : 'Waiting for printer telemetry…'}
              </p>
              {liveProgress?.remainingSecs != null && liveProgress.remainingSecs > 0 && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-600 dark:text-gray-400">
                  <Clock className="h-3 w-3" /> {fmtRemaining(liveProgress.remainingSecs)}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

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

      {job.status === 'FAILED' && (
        <Card className="border-red-200 bg-red-50 dark:bg-red-950/20">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-red-500 mt-0.5 shrink-0" />
              <div className="space-y-1">
                <p className="font-semibold text-red-700 dark:text-red-400">Print Failed</p>
                {job.failureReason && <p className="text-sm text-red-600 dark:text-red-300">{job.failureReason}</p>}
                <div className="flex gap-4 text-xs text-red-500">
                  {job.failedAt && <span>Failed: {formatDateTime(job.failedAt)}</span>}
                  {job.wasteGrams > 0 && <span>Wasted: {job.wasteGrams}g filament</span>}
                  {job.reprintOfId && <span>Reprint of a previous job</span>}
                </div>
                {job.reprints && job.reprints.length > 0 && (
                  <div className="mt-2">
                    <p className="text-xs font-medium text-red-600">Reprints:</p>
                    {job.reprints.map((r: any) => (
                      <Link key={r.id} href={`/production/${r.id}`} className="text-xs text-brand-600 hover:underline block">{r.name} — <StatusBadge status={r.status} /></Link>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

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

      {/* Camera feed dialog */}
      <Dialog open={showCamera} onClose={() => setShowCamera(false)} title={`${job.printer?.name ?? 'Printer'} — Camera`}>
        {showCamera && job.printer?.cameraUrl && (
          <div className="space-y-3">
            <CameraViewer printerId={job.printer.id} printerName={job.printer.name} cameraUrl={job.printer.cameraUrl} variant="full" />
            {job.gcodeFilename && (
              <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
                Expected gcode: <span className="font-mono">{job.gcodeFilename}</span>
                {gcodeCheck.match === true && <span className="text-green-600 ml-1">✓ confirmed on printer</span>}
                {gcodeCheck.match === false && <span className="text-red-600 ml-1">⚠ printer is running a different file</span>}
              </p>
            )}
          </div>
        )}
      </Dialog>

      <Dialog open={showCancelDialog} onClose={() => setShowCancelDialog(false)} title="Cancel Job">
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">Are you sure you want to cancel <strong>{job.name}</strong>? This cannot be undone.</p>
        <div className="flex gap-3 justify-end">
          <Button variant="outline" onClick={() => setShowCancelDialog(false)}>Back</Button>
          <Button className="bg-gray-700 hover:bg-gray-800 text-white" onClick={handleCancel} disabled={cancelling}>{cancelling ? 'Cancelling...' : 'Cancel Job'}</Button>
        </div>
      </Dialog>

      <Dialog open={showReprintDialog} onClose={() => setShowReprintDialog(false)} title="Create Reprint Job">
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">This will clone <strong>{job.name}</strong> as a new QUEUED job. Continue?</p>
        <div className="flex gap-3 justify-end">
          <Button variant="outline" onClick={() => setShowReprintDialog(false)}>Back</Button>
          <Button disabled={submittingReprint} onClick={handleReprint}><RefreshCw className="h-4 w-4 mr-2" />{submittingReprint ? 'Creating...' : 'Create Reprint'}</Button>
        </div>
      </Dialog>

      <Dialog open={showAddMaterial} onClose={() => setShowAddMaterial(false)} title="Add Material">
        <form onSubmit={handleAddMaterial} className="space-y-4">
          <Select name="materialId" label="Material" options={[{ value: '', label: 'Select...' }, ...materials.map(m => ({ value: m.id, label: m.name }))]} onChange={e => onMaterialChange(e.target.value)} required />
          <Select name="spoolId" label="Spool (optional)" options={[{ value: '', label: 'Any' }, ...spools.map(s => ({ value: s.id, label: `${s.lotNumber || 'Spool'} (${Math.round(s.currentWeight)}g)` }))]} />
          <Input name="gramsUsed" label="Grams Used" type="number" step="0.1" required />
          <Input name="colorIndex" label="Color Index (T0, T1...)" type="number" defaultValue="0" min="0" />
          <div className="flex gap-3 justify-end">
            <Button type="button" variant="outline" onClick={() => setShowAddMaterial(false)}>Cancel</Button>
            <Button type="submit" disabled={savingMaterial}>{savingMaterial ? 'Adding...' : 'Add'}</Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={showFailDialog} onClose={() => setShowFailDialog(false)} title="Mark Job as Failed">
        <form onSubmit={handleFail} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Failure Reason</label>
            <textarea name="failureReason" required rows={3} className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm" placeholder="e.g. Bed adhesion failure, spaghetti at layer 45..." />
          </div>
          <Input name="wasteGrams" label="Estimated Filament Wasted (grams)" type="number" step="0.1" defaultValue="0" min="0" />
          <p className="text-xs text-gray-500">Waste grams will be deducted proportionally from the assigned spools.</p>
          <div className="flex gap-3 justify-end">
            <Button type="button" variant="outline" onClick={() => setShowFailDialog(false)}>Cancel</Button>
            <Button type="submit" disabled={submittingFail} className="bg-red-600 hover:bg-red-700 text-white">{submittingFail ? 'Saving...' : 'Mark Failed'}</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
