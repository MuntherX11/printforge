'use client';

import { useEffect, useState } from 'react';
import { defaultPartFor, unitsPerPlatePrefill } from '@printforge/types';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { stageLargeFile } from '@/lib/chunked-upload';
import { formatGrams, formatMinutes } from '@/lib/product-format';
import type {
  ApiGcodeAnalysis, ComponentDetail, LayoutConversionPreview, LayoutConversionResult, ProductDetail, SizeOptionDetail,
} from '@/lib/types/api';
import { LinkButton, errorText } from './options-ui';
import { allComponents, isMultiColour } from './options-model';
import { componentGrams, detectedLines, parseDecimal } from './bom-model';
import { parseUnits, unitsError, unitsHint } from './convert-layout-model';
import { ConvertLayoutReview } from './ConvertLayoutReview';

interface Props {
  product: ProductDetail;
  option: SizeOptionDetail | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

interface Staged { stagedId: string; fileName: string; analysis: ApiGcodeAnalysis }
type FigureSource = 'OPTION' | 'FILE' | null;
type Busy = 'stage' | 'check' | 'convert' | null;

const round2 = (x: number) => Math.round(x * 100) / 100;
const fileMinutes = (a: ApiGcodeAnalysis) => (a.estimatedTimeSeconds ? Math.round(a.estimatedTimeSeconds / 60) : null);
function fileGrams(a: ApiGcodeAnalysis): number | null {
  const tools = (a.tools ?? []).reduce((s, t) => s + (t.filamentGrams ?? 0), 0);
  const g = a.filamentUsedGrams || tools;
  return g ? round2(g) : null;
}
const num = (x: number | null) => (x !== null && x > 0 ? String(x) : '');

function partLabel(product: ProductDetail, c: ComponentDetail): string {
  const size = c.variantId ? product.sizes.find(s => s.id === c.variantId)?.name : null;
  return `${size ? `${size} · ` : ''}${c.description} — ${formatGrams(componentGrams(c))}, ${formatMinutes(c.printMinutes)} each${isMultiColour(c) ? ' · multicolour' : ''}`;
}

/**
 * Convert a legacy "N per plate" size option into a plate layout on one part
 * (O8a preview, then O8). The option is switched off; its orders, quotes and
 * jobs keep it.
 */
export function ConvertToLayoutDialog({ product, option, open, onClose, onSaved }: Props) {
  const { toast } = useToast();
  const parts = allComponents(product);
  const [step, setStep] = useState<'form' | 'review'>('form');
  const [componentId, setComponentId] = useState('');
  const [file, setFile] = useState<Staged | null>(null);
  const [units, setUnits] = useState('');
  const [unitsTouched, setUnitsTouched] = useState(false);
  const [minutes, setMinutes] = useState('');
  const [grams, setGrams] = useState('');
  const [minutesFrom, setMinutesFrom] = useState<FigureSource>(null);
  const [gramsFrom, setGramsFrom] = useState<FigureSource>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<LayoutConversionPreview | null>(null);
  const [active, setActive] = useState(true);

  const prefillFor = (partId: string, analysis: ApiGcodeAnalysis | null) => {
    const c = parts.find(x => x.id === partId);
    return unitsPerPlatePrefill({
      optionName: option?.name ?? '',
      optionGrams: option?.estimatedGrams ?? null,
      componentGrams: c ? componentGrams(c) : null,
      objectCount: analysis?.objectCount ?? null,
    });
  };

  useEffect(() => {
    if (!open || !option) return;
    const part = defaultPartFor(option.name, allComponents(product));
    const pf = unitsPerPlatePrefill({
      optionName: option.name, optionGrams: option.estimatedGrams, componentGrams: part ? componentGrams(part) : null, objectCount: null,
    });
    setStep('form'); setPreview(null); setError(null); setFile(null); setBusy(null);
    setComponentId(part?.id ?? '');
    setUnits(pf.units !== null ? String(pf.units) : ''); setUnitsTouched(false);
    setMinutes(num(option.estimatedMinutes)); setMinutesFrom(option.estimatedMinutes ? 'OPTION' : null);
    setGrams(num(option.estimatedGrams)); setGramsFrom(option.estimatedGrams ? 'OPTION' : null);
    // Reset only when the dialog opens for an option, not on every product reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, option?.id]);

  if (!option) return null;
  const part = parts.find(c => c.id === componentId) ?? null;
  const prefill = prefillFor(componentId, file?.analysis ?? null);
  const u = parseUnits(units);
  const m = parseDecimal(minutes, 1, 100_000);
  const g = parseDecimal(grams, 0.1, 100_000);
  const uError = unitsError(units, part?.description ?? 'the part', option.name);
  const valid = !!part && u !== null && m !== null && g !== null;
  const base = `/products/${product.id}/variants/${option.id}/convert-to-layout`;

  const refillUnits = (partId: string, analysis: ApiGcodeAnalysis | null) => {
    if (unitsTouched) return;
    const pf = prefillFor(partId, analysis);
    setUnits(pf.units !== null ? String(pf.units) : '');
  };

  async function run(key: Busy, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try { await fn(); } catch (err) { setError(errorText(err, 'Something went wrong')); } finally { setBusy(null); }
  }

  const pickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    void run('stage', async () => {
      const stagedId = await stageLargeFile(f);
      const fd = new FormData();
      fd.append('assembledUploadId', stagedId);
      const analysis = await api.postForm<ApiGcodeAnalysis>('/file-parser/parse-gcode', fd);
      const fm = fileMinutes(analysis);
      const fg = fileGrams(analysis);
      if (fm !== null) { setMinutes(String(fm)); setMinutesFrom('FILE'); }
      if (fg !== null) { setGrams(String(fg)); setGramsFrom('FILE'); }
      setFile({ stagedId, fileName: f.name, analysis });
      refillUnits(componentId, analysis);
    });
  };

  const removeFile = () => {
    setFile(null);
    if (minutesFrom === 'FILE') { setMinutes(num(option.estimatedMinutes)); setMinutesFrom(option.estimatedMinutes ? 'OPTION' : null); }
    if (gramsFrom === 'FILE') { setGrams(num(option.estimatedGrams)); setGramsFrom(option.estimatedGrams ? 'OPTION' : null); }
    refillUnits(componentId, null);
  };

  const check = () => void run('check', async () => {
    if (!valid) return;
    const q = new URLSearchParams({ componentId, unitsPerPlate: String(u), plateMinutes: String(m), plateGrams: String(g) });
    if (file) q.set('assembledUploadId', file.stagedId);
    const p = await api.get<LayoutConversionPreview>(`${base}?${q.toString()}`);
    setPreview(p);
    setActive(p.recommendActive);
    setStep('review');
  });

  const convert = () => void run('convert', async () => {
    if (!valid || !preview) return;
    const r = await api.post<LayoutConversionResult>(base, {
      componentId, unitsPerPlate: u, plateMinutes: m, plateGrams: g, isActive: active,
      ...(file ? { assembledUploadId: file.stagedId } : {}),
    });
    const done = `${option.name} converted to ${preview.component.description} ×${r.layout.unitsPerPlate}`
      + (r.layout.isActive ? '' : ' — the plate is off until you switch it on under Manage');
    toast(r.warnings.length ? 'warning' : 'success', r.warnings.length ? `${done} — ${r.warnings.map(w => w.message).join(' ')}` : done);
    onSaved();
    onClose();
  });

  const figureHint = (from: FigureSource) => (from === 'FILE' ? 'From the file' : from === 'OPTION' ? `From ${option.name}'s saved estimate` : undefined);

  return (
    <Dialog open={open} onClose={busy ? () => undefined : onClose} title={`Convert ${option.name} to a plate layout`} className="max-w-2xl">
      <div className="max-h-[75vh] space-y-4 overflow-y-auto">
        {step === 'form' ? (
          <>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Use this when &quot;{option.name}&quot; is a plate of several units of one part. It becomes a plate layout on that part and
              &quot;{option.name}&quot; is switched off. Its orders, quotes and jobs keep it.
            </p>
            <Select
              label="Part on the plate"
              required
              value={componentId}
              disabled={busy !== null}
              onChange={e => { setComponentId(e.target.value); refillUnits(e.target.value, file?.analysis ?? null); }}
              options={[{ value: '', label: 'Choose the part' }, ...parts.map(c => ({ value: c.id, label: partLabel(product, c) }))]}
            />

            <div className="space-y-2">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Add the plate&apos;s G-code (optional)</p>
              {file ? (
                <div className="space-y-1 text-sm">
                  <p className="break-words text-gray-800 dark:text-gray-200">
                    File: {file.fileName} <LinkButton onClick={removeFile} disabled={busy !== null}>Remove file</LinkButton>
                  </p>
                  <ul className="list-disc pl-5 text-xs text-gray-600 dark:text-gray-400">
                    {detectedLines(file.analysis).map(t => <li key={t}>{t}</li>)}
                  </ul>
                </div>
              ) : (
                <label className="inline-flex min-h-[36px] cursor-pointer items-center rounded-md border border-gray-300 px-3 text-sm font-medium hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800">
                  <input type="file" accept=".gcode,.gco,.g" className="hidden" onChange={pickFile} disabled={busy !== null} />
                  {busy === 'stage' ? 'Reading file…' : 'Choose G-code'}
                </label>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Input label="Units on the plate" required type="number" min={2} max={500} step={1} value={units}
                  onChange={e => { setUnits(e.target.value); setUnitsTouched(true); }} error={uError ?? undefined} />
                {!unitsTouched && !uError && (
                  <p className="text-xs text-gray-500 dark:text-gray-400">{unitsHint(prefill, option.name, option.estimatedGrams, part ? componentGrams(part) : null)}</p>
                )}
              </div>
              <div className="space-y-1">
                <Input label="Plate time (min)" required type="number" min={1} max={100000} step="0.1" value={minutes}
                  onChange={e => { setMinutes(e.target.value); setMinutesFrom(null); }}
                  error={minutes !== '' && m === null ? 'Minutes from 1 to 100,000' : undefined} />
                {figureHint(minutesFrom) && <p className="text-xs text-gray-500 dark:text-gray-400">{figureHint(minutesFrom)}</p>}
              </div>
              <div className="space-y-1">
                <Input label="Plate filament (g)" required type="number" min={0.1} max={100000} step="0.01" value={grams}
                  onChange={e => { setGrams(e.target.value); setGramsFrom(null); }}
                  error={grams !== '' && g === null ? 'Grams from 0.1 to 100,000' : undefined} />
                {figureHint(gramsFrom) && <p className="text-xs text-gray-500 dark:text-gray-400">{figureHint(gramsFrom)}</p>}
              </div>
            </div>
          </>
        ) : preview && (
          <ConvertLayoutReview product={product} option={option} preview={preview} active={active} disabled={busy !== null} onActive={setActive} />
        )}

        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {step === 'form' ? (
            <>
              <Button type="button" variant="outline" onClick={onClose} disabled={busy !== null}>Cancel</Button>
              <Button type="button" onClick={check} disabled={!valid || busy !== null}>{busy === 'check' ? 'Checking…' : 'Next'}</Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => { setStep('form'); setError(null); }} disabled={busy !== null}>Back</Button>
              <Button type="button" onClick={convert} disabled={!valid || busy !== null}>{busy === 'convert' ? 'Converting…' : 'Convert'}</Button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
