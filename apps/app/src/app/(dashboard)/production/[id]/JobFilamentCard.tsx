'use client';

/**
 * The job's picking list (moved out of the job page): which filament, which
 * spool and where it is, with the colour notes of spec §5.3 and the
 * per-line colour swap.
 */
import { useState } from 'react';
import { AlertTriangle, CheckCircle, Plus } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { ApiMaterial } from '@/lib/types/api';
import { filamentNote, isTerminal, loadMaterials, type JobDetail } from './job-detail';

interface Props {
  job: JobDetail;
  onAdd: () => void;
  onChanged: () => void;
  onError: (err: unknown) => void;
}

export function JobFilamentCard({ job, onAdd, onChanged, onError }: Props) {
  const { toast } = useToast();
  // Which picking-list line has its colour picker open, and the same-type
  // colour options for it.
  const [swapLine, setSwapLine] = useState<string | null>(null);
  const [swapOptions, setSwapOptions] = useState<ApiMaterial[]>([]);
  const [swapping, setSwapping] = useState(false);

  async function openSwap(f: { type: string | null; materialId: string | null; lineId?: string }) {
    const mats = await loadMaterials();
    // Same material type only — a colour is the operator's call, a different
    // plastic is not. And only colours with an active spool to pull.
    setSwapOptions(mats.filter(m =>
      m.type === f.type && m.id !== f.materialId &&
      (m.spools ?? []).some(sp => (sp as { isActive?: boolean }).isActive !== false && sp.currentWeight > 0),
    ));
    setSwapLine(f.lineId ?? null);
  }

  async function handleSwap(lineId: string, materialId: string) {
    if (!materialId) return;
    setSwapping(true);
    try {
      await api.patch(`/jobs/materials/${lineId}/colour`, { materialId });
      toast('success', 'Filament changed — new spool reserved');
      setSwapLine(null);
      onChanged();
    } catch (err: unknown) {
      onError(err);
    } finally {
      setSwapping(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Filament Required</CardTitle>
          <Button variant="outline" size="sm" onClick={onAdd}><Plus className="h-4 w-4 mr-1" /> Add</Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {(job.filamentPlan || []).length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-500 dark:text-gray-400">
            No filament recorded for this job yet.
          </p>
        ) : (
          <>
            <div className="divide-y dark:divide-gray-700">
              {job.filamentPlan.map((f, i) => {
                const note = filamentNote(f, job.colour?.name ?? null);
                return (
                <div key={f.lineId ?? f.materialId ?? i} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium dark:text-gray-100">
                      {f.label}
                      {note && (
                        <span className={`ml-2 text-[11px] font-normal ${note.tone === 'blue' ? 'text-blue-600 dark:text-blue-400' : 'text-amber-600 dark:text-amber-400'}`}>
                          {note.text}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {f.spoolRef ? (
                        <>
                          <span className="font-mono">{f.spoolRef}</span>
                          {f.location ? <> · {f.location}</> : <> · <span className="text-amber-600 dark:text-amber-400">no location set</span></>}
                          {f.spoolRemaining != null && <> · {f.spoolRemaining}g on spool</>}
                        </>
                      ) : (
                        <span className="text-amber-600 dark:text-amber-400">No spool available in stock</span>
                      )}
                    </p>
                    {f.assigned && f.lineId && !isTerminal(job.status) && (
                      swapLine === f.lineId ? (
                        <span className="mt-1 flex items-center gap-2">
                          <select
                            autoFocus
                            disabled={swapping}
                            defaultValue=""
                            onChange={(e) => handleSwap(f.lineId!, e.target.value)}
                            className="h-7 rounded border border-gray-300 bg-white px-1.5 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                          >
                            <option value="">Pick new colour…</option>
                            {swapOptions.map(m => (
                              <option key={m.id} value={m.id}>
                                {[m.color, m.brand].filter(Boolean).join(' · ') || m.name}
                              </option>
                            ))}
                          </select>
                          <button type="button" className="text-xs text-gray-500 hover:underline"
                            onClick={() => setSwapLine(null)}>cancel</button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => openSwap(f)}
                          className="mt-1 block text-xs text-blue-600 hover:underline dark:text-blue-400"
                        >
                          Change colour
                        </button>
                      )
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-sm font-semibold tabular-nums dark:text-gray-100">{f.gramsNeeded}g</p>
                    {f.hasEnough ? (
                      <span className="text-[11px] text-green-600 dark:text-green-400 flex items-center gap-1 justify-end">
                        <CheckCircle className="h-3 w-3" /> {f.assigned ? 'reserved' : 'in stock'}
                      </span>
                    ) : (
                      <span className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1 justify-end">
                        <AlertTriangle className="h-3 w-3" /> short
                      </span>
                    )}
                  </div>
                </div>
                );
              })}
            </div>
            <p className="px-4 py-2.5 text-xs text-gray-400 border-t dark:border-gray-700">
              {job.filamentPlan.some(f => f.assigned)
                ? 'Reserved for this job — the smallest spool that still covers it, so part-used spools get finished first. Deducted when the job is marked complete.'
                : 'Suggested from the product’s bill of materials. Nothing is deducted until the job is completed.'}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
