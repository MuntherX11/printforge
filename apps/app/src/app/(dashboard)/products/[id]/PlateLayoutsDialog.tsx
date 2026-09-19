'use client';

import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { stageLargeFile } from '@/lib/chunked-upload';
import { formatGrams, formatMinutes } from '@/lib/product-format';
import type { ApiGcodeAnalysis, ComponentDetail, PlateLayoutCreateResult, ProductDetail } from '@/lib/types/api';
import { LinkButton, Toggle, errorText } from './options-ui';
import { parseDecimal, parseWhole, vsSingle } from './bom-model';

interface Props {
  product: ProductDetail;
  component: ComponentDetail | null;
  open: boolean;
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => void;
}

type AddState =
  | { mode: 'gcode'; stagedId: string; fileName: string; analysis: ApiGcodeAnalysis }
  | { mode: 'manual' };

const INTRO = 'A plate layout is a saved, sliced plate of this component with several units on it (e.g. ×12). Job planning uses them to pick plate combinations, and bulk pricing uses them for the cost floor. Customers still order loose units.';

function detectedLines(a: ApiGcodeAnalysis): string[] {
  const out: string[] = [];
  if (a.objectCount === null) out.push('No object labels — enter the units');
  else out.push(`Detected: ${a.objectModels.map(m => `${m.count} × ${m.model}`).join(', ') || `${a.objectCount} objects`}`);
  if (a.objectModels.length > 1) out.push('Mixed plate — more than one model; enter the units of this component only');
  if (a.ignoredLabels.length > 0) out.push('Purge tower not counted');
  return out;
}

/** Section E (spec §5.2 E): the component's plate layouts (M3–M6). */
export function PlateLayoutsDialog({ product, component: c, open, canEdit, onClose, onChanged }: Props) {
  const { toast } = useToast();
  const [add, setAdd] = useState<AddState | null>(null);
  const [units, setUnits] = useState('');
  const [minutes, setMinutes] = useState('');
  const [grams, setGrams] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAdd(null); setError(null); setConfirmDelete(null);
  }, [open, c?.id]);

  if (!c) return null;
  const base = `/products/${product.id}/components/${c.id}/plate-layouts`;
  const layouts = [...c.plateLayouts].sort((a, b) => a.unitsPerPlate - b.unitsPerPlate);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try { await fn(); } catch (err) { setError(errorText(err, 'Something went wrong')); } finally { setBusy(null); }
  }

  const pickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    void run('stage', async () => {
      // Always staged: M6 reads it with keep, M3 consumes it (spec §5.2 E).
      const stagedId = await stageLargeFile(file);
      const fd = new FormData();
      fd.append('assembledUploadId', stagedId);
      const analysis = await api.postForm<ApiGcodeAnalysis>('/file-parser/parse-gcode', fd);
      const toolGrams = (analysis.tools ?? []).reduce((s, t) => s + (t.filamentGrams ?? 0), 0);
      setUnits(analysis.objectCount != null ? String(analysis.objectCount) : '');
      setMinutes(analysis.estimatedTimeSeconds ? String(Math.round(analysis.estimatedTimeSeconds / 60)) : '');
      const g = analysis.filamentUsedGrams || toolGrams;
      setGrams(g ? String(Math.round(g * 10) / 10) : '');
      setAdd({ mode: 'gcode', stagedId, fileName: file.name, analysis });
    });
  };

  const startManual = () => { setUnits(''); setMinutes(''); setGrams(''); setError(null); setAdd({ mode: 'manual' }); };

  const u = parseWhole(units, 1, 500);
  const m = parseDecimal(minutes, 1, 100_000);
  const g = parseDecimal(grams, 0.1, 100_000);
  const valid = u !== null && m !== null && g !== null;

  const saveLayout = () => void run('save', async () => {
    if (!add || !valid) return;
    const body = add.mode === 'gcode'
      ? { assembledUploadId: add.stagedId, unitsPerPlate: u, plateMinutes: m, plateGrams: g }
      : { unitsPerPlate: u, plateMinutes: m, plateGrams: g };
    const r = await api.post<PlateLayoutCreateResult>(base, body);
    toast(r.warnings.length ? 'warning' : 'success',
      r.warnings.length ? `Layout ×${r.layout.unitsPerPlate} saved — ${r.warnings.map(w => w.message).join(' ')}` : `Layout ×${r.layout.unitsPerPlate} saved`);
    setAdd(null);
    onChanged();
  });

  const setActive = (id: string, isActive: boolean) => void run(id, async () => {
    await api.patch(`${base}/${id}`, { isActive });
    onChanged();
  });

  const remove = (id: string) => void run(id, async () => {
    const r = await api.delete<{ deleted?: true; deactivated?: true }>(`${base}/${id}`);
    toast('success', r.deactivated ? 'Layout is used by jobs, so it was deactivated instead of deleted' : 'Layout deleted');
    setConfirmDelete(null);
    onChanged();
  });

  return (
    <Dialog open={open} onClose={busy ? () => undefined : onClose} title={`Plate layouts — ${c.description}`} className="max-w-4xl">
      <div className="max-h-[75vh] space-y-4 overflow-y-auto">
        <p className="text-sm text-gray-600 dark:text-gray-400">{INTRO}</p>
        {layouts.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No layouts yet — jobs print single units ({formatMinutes(c.printMinutes)}, {formatGrams(c.gramsUsed)} each).</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  <th className="py-2 pr-3">Units per plate</th><th className="pr-3">Plate time</th><th className="pr-3">Plate filament</th>
                  <th className="pr-3">Per unit (time, g)</th><th className="pr-3">vs single</th><th className="pr-3">File</th>
                  <th className="pr-3">Active</th>{canEdit && <th />}
                </tr>
              </thead>
              <tbody>
                {layouts.map(l => (
                  <tr key={l.id} className="border-b last:border-0 dark:border-gray-800">
                    <td className="py-2 pr-3 font-medium">×{l.unitsPerPlate}</td>
                    <td className="pr-3 tabular-nums">{formatMinutes(l.plateMinutes)}</td>
                    <td className="pr-3 tabular-nums">{formatGrams(l.plateGrams)}</td>
                    <td className="pr-3 tabular-nums">{formatMinutes(l.minutesPerUnit)}, {formatGrams(l.gramsPerUnit)}</td>
                    <td className="pr-3 text-gray-600 dark:text-gray-400">{vsSingle(l.minutesPerUnit, c.printMinutes) ?? '—'}</td>
                    <td className="pr-3">
                      {l.file
                        ? <a href={l.file.downloadUrl} download className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-400"><Download className="h-3.5 w-3.5" aria-hidden="true" />Download</a>
                        : <span className="text-xs text-gray-400">{l.source === 'MANUAL' ? 'Entered by hand' : '—'}</span>}
                    </td>
                    <td className="pr-3">
                      {canEdit
                        ? <Toggle checked={l.isActive} label={`×${l.unitsPerPlate} layout active`} disabled={busy !== null} onChange={v => setActive(l.id, v)} />
                        : l.isActive ? 'Yes' : 'No'}
                    </td>
                    {canEdit && (
                      <td className="whitespace-nowrap text-right">
                        {confirmDelete === l.id ? (
                          <>
                            <LinkButton tone="danger" disabled={busy !== null} onClick={() => remove(l.id)}>Delete ×{l.unitsPerPlate}?</LinkButton>
                            <LinkButton onClick={() => setConfirmDelete(null)}>Keep</LinkButton>
                          </>
                        ) : <LinkButton tone="danger" disabled={busy !== null} onClick={() => setConfirmDelete(l.id)}>Delete</LinkButton>}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canEdit && !add && (
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex min-h-[36px] cursor-pointer items-center rounded-md border border-gray-300 px-3 text-sm font-medium hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800">
              <input type="file" accept=".gcode,.gco,.g" className="hidden" onChange={pickFile} disabled={busy !== null} />
              {busy === 'stage' ? 'Reading file…' : 'Add from G-code'}
            </label>
            <Button type="button" variant="outline" size="sm" onClick={startManual} disabled={busy !== null}>Add manually</Button>
          </div>
        )}

        {canEdit && add && (
          <div className="space-y-3 rounded-md border border-gray-200 p-3 dark:border-gray-700">
            <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
              {add.mode === 'gcode' ? `New layout from ${add.fileName}` : 'New layout (entered by hand)'}
            </p>
            {add.mode === 'gcode' && (
              <ul className="list-disc pl-5 text-xs text-gray-600 dark:text-gray-400">
                {detectedLines(add.analysis).map(t => <li key={t}>{t}</li>)}
              </ul>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Input label="Units on the plate" required type="number" min={1} max={500} step={1} value={units} onChange={e => setUnits(e.target.value)}
                error={units !== '' && u === null ? 'Whole number from 1 to 500' : undefined} />
              <Input label="Plate time (min)" required type="number" min={1} max={100000} step="0.1" value={minutes} onChange={e => setMinutes(e.target.value)}
                error={minutes !== '' && m === null ? 'Minutes from 1 to 100,000' : undefined} />
              <Input label="Plate filament (g)" required type="number" min={0.1} max={100000} step="0.1" value={grams} onChange={e => setGrams(e.target.value)}
                error={grams !== '' && g === null ? 'Grams from 0.1 to 100,000' : undefined} />
            </div>
            {u !== null && m !== null && g !== null && (
              <p className="text-xs text-gray-500 dark:text-gray-400">Per unit: {formatMinutes(m / u)}, {formatGrams(g / u)}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setAdd(null)} disabled={busy !== null}>Cancel</Button>
              <Button type="button" size="sm" onClick={saveLayout} disabled={!valid || busy !== null}>{busy === 'save' ? 'Saving…' : 'Save layout'}</Button>
            </div>
          </div>
        )}
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </Dialog>
  );
}
