'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { JOB_PURPOSES, type JobPurpose } from '@printforge/types';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatGrams, policyLabel } from '@/lib/product-format';
import type { ApiPrinter, JobPreview, JobReservation, JobStockMode, ProductDetail, SurplusPolicy } from '@/lib/types/api';
import { ColourSelect, SizeSelect, pickerOptionsFromDetail, useOptionPair, type PairKeys } from '@/components/products/OptionPickers';
import { PlatePlanEditor, planProblem, type PlanPlate } from '@/components/production/PlatePlanEditor';
import { errorText } from './options-ui';
import { parseWhole } from './bom-model';
import { FilamentTable, ProblemList } from './readiness-ui';

export interface NewJobPrefill extends PairKeys {
  quantity: number;
}

interface Props {
  product: ProductDetail;
  /** null = closed. */
  prefill: NewJobPrefill | null;
  loadPrinters: () => Promise<ApiPrinter[]>;
  onClose: () => void;
}

const PURPOSES: Array<{ value: JobPurpose; label: string }> = [{ value: 'CUSTOMER', label: 'For sale or stock' }, ...JOB_PURPOSES];
const POLICIES: SurplusPolicy[] = ['KEEP_FOR_STOCK', 'CANCEL_ON_PRINTER'];
type Plans = Record<string, PlanPlate[]>;

function reservationToast(r: JobReservation | undefined): string {
  if (!r) return 'Job created';
  const base = `Job created — spools assigned for ${r.withSpool} of ${r.lines} filaments`;
  if (!r.short.length) return base;
  return `${base}; no spool covers ${r.short.map(s => `${s.label} (short ${formatGrams(s.gramsShort)})`).join(', ')}`;
}

/** Section G (spec §5.2 G): a job for one pair, with a live J2 preview and editable plates. */
export function NewJobDialog({ product, prefill, loadPrinters, onClose }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const options = useMemo(() => pickerOptionsFromDetail(product), [product]);
  const pair = useOptionPair(options, prefill);
  const [purpose, setPurpose] = useState<JobPurpose>('CUSTOMER');
  const [qtyText, setQtyText] = useState('1');
  const [stockMode, setStockMode] = useState<JobStockMode | ''>('');
  const [policy, setPolicy] = useState<SurplusPolicy>(product.surplusPolicy);
  const [printerId, setPrinterId] = useState('');
  const [printers, setPrinters] = useState<ApiPrinter[]>([]);
  const [plans, setPlans] = useState<Plans | null>(null);
  const [preview, setPreview] = useState<{ data: JobPreview | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: false });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = prefill !== null;
  const qty = parseWhole(qtyText, 1, 100_000);
  const { setPair } = pair;

  useEffect(() => {
    if (!prefill) return;
    setPair({ sizeKey: prefill.sizeKey, colourKey: prefill.colourKey });
    setQtyText(String(prefill.quantity));
    setPurpose('CUSTOMER'); setStockMode(''); setPolicy(product.surplusPolicy);
    setPrinterId(product.defaultPrinterId ?? ''); setPlans(null); setError(null);
    loadPrinters().then(setPrinters).catch(() => setPrinters([]));
    // Reset on open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  // A different pair, quantity or policy gets fresh suggested plates.
  useEffect(() => { setPlans(null); }, [pair.sizeKey, pair.colourKey, qty, policy]);

  const planProblems = (p: JobPreview | null, edited: Plans | null) => {
    if (!p || !edited) return null;
    for (const c of p.components) {
      const problem = planProblem(edited[c.componentId] ?? [], p.layoutsByComponent[c.componentId] ?? [], c.unitsRequired);
      if (problem) return `${c.description}: ${problem}`;
    }
    return null;
  };
  const editedProblem = planProblems(preview.data, plans);
  const platesBody = plans ? Object.entries(plans).flatMap(([componentId, list]) => list.map(p => ({ componentId, ...p }))) : undefined;
  const common = {
    productId: product.id, sizeOptionId: pair.sizeOptionId, colourOptionId: pair.colourOptionId, surplusPolicy: policy,
    ...(purpose === 'CUSTOMER' && stockMode ? { stockMode } : {}),
    ...(platesBody ? { plates: platesBody } : {}),
  };
  const bodyKey = JSON.stringify({ ...common, qty });

  useEffect(() => {
    if (!open || qty === null || editedProblem) return;
    let live = true;
    setPreview(s => ({ ...s, loading: true }));
    const t = window.setTimeout(() => {
      api.post<JobPreview>('/jobs/preview', { ...common, quantity: qty })
        .then(data => { if (live) setPreview({ data, error: null, loading: false }); })
        .catch(err => { if (live) setPreview(s => ({ data: s.data, error: errorText(err, 'Couldn\'t preview the job'), loading: false })); });
    }, 400);
    return () => { live = false; window.clearTimeout(t); };
    // `common` is captured through bodyKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bodyKey, editedProblem]);

  if (!open) return null;
  const p = preview.data;
  const planOf = (componentId: string): PlanPlate[] =>
    plans?.[componentId] ?? p?.components.find(c => c.componentId === componentId)?.plates.map(x => ({ layoutId: x.layoutId, plateCount: x.plateCount })) ?? [];
  const editPlan = (componentId: string, next: PlanPlate[]) => {
    if (!p) return;
    const base: Plans = plans ?? Object.fromEntries(p.components.map(c => [c.componentId, planOf(c.componentId)]));
    setPlans({ ...base, [componentId]: next });
  };

  const needsFor = purpose === 'CUSTOMER' && !stockMode;
  const credits = p?.components.filter(c => (c.creditOnComplete ?? 0) > 0) ?? [];
  const stockLine = purpose !== 'CUSTOMER'
    ? 'On completion: nothing is added to printed stock'
    : !stockMode ? 'Choose who this job is for to see what goes to printed stock'
      : credits.length ? `On completion: ${credits.map(c => `+${c.creditOnComplete} ${c.description}`).join(', ')} to printed stock`
        : 'On completion: nothing is added to printed stock';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (qty === null || needsFor || editedProblem) return;
    setSubmitting(true);
    setError(null);
    try {
      const job = await api.post<{ id: string; reservation?: JobReservation }>('/jobs', {
        ...common, quantityToProduce: qty, purpose, ...(printerId ? { printerId } : {}),
      });
      toast(job.reservation && job.reservation.short.length ? 'warning' : 'success', reservationToast(job.reservation));
      onClose();
      router.push(`/production/${job.id}`);
    } catch (err) {
      setError(errorText(err, 'Couldn\'t create the job'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onClose={submitting ? () => undefined : onClose} title={`New job — ${product.name}`} className="max-w-4xl">
      <form onSubmit={submit} className="max-h-[78vh] space-y-4 overflow-y-auto pr-1" noValidate>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <SizeSelect options={options} value={pair.sizeKey} onChange={pair.setSizeKey} />
          <ColourSelect options={options} sizeKey={pair.sizeKey} value={pair.colourKey} onChange={pair.setColourKey} note={pair.note} />
          <Select label="Purpose" value={purpose} onChange={e => setPurpose(e.target.value as JobPurpose)} options={PURPOSES} />
          <Input label="Quantity (units)" required type="number" min={1} max={100000} step={1} value={qtyText}
            onChange={e => setQtyText(e.target.value)} error={qty === null ? 'Whole number from 1 to 100,000' : undefined} />
          <Select label="Extras on the last plate" value={policy} onChange={e => setPolicy(e.target.value as SurplusPolicy)}
            options={POLICIES.map(v => ({ value: v, label: `${policyLabel(v)}${v === product.surplusPolicy ? ' (product setting)' : ''}` }))} />
          <Select label="Printer" value={printerId} onChange={e => setPrinterId(e.target.value)}
            options={[{ value: '', label: 'No printer — assign later' }, ...printers.filter(x => x.isActive).map(x => ({ value: x.id, label: x.name }))]} />
        </div>
        {p && <ProblemList problems={p.warnings} tone="warning" />}

        {purpose === 'CUSTOMER' && (
          <fieldset>
            <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">This job is for<span className="ml-0.5 text-red-500" aria-hidden="true">*</span></legend>
            <div className="mt-1 flex flex-wrap gap-4 text-sm">
              {([['BUILD_STOCK', 'Printed stock'], ['DIRECT_SALE', 'A customer — no order in the system']] as const).map(([v, label]) => (
                <label key={v} className="flex items-center gap-2">
                  <input type="radio" name="job-for" value={v} checked={stockMode === v} onChange={() => setStockMode(v)} /> {label}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <section className="space-y-3 rounded-md border border-gray-200 p-3 dark:border-gray-700">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Plates {preview.loading && <span className="font-normal text-gray-500">— updating…</span>}</h3>
          {preview.error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{preview.error}</p>}
          {editedProblem && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{editedProblem}</p>}
          {!p && !preview.error && <p className="text-sm text-gray-500 dark:text-gray-400">Loading the plan…</p>}
          {p && (
            <>
              <ProblemList problems={p.problems} tone="error" />
              {p.components.map(c => (
                <div key={c.componentId} className="space-y-1">
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
                    {c.description} <span className="font-normal text-gray-500 dark:text-gray-400">· {c.unitsRequired} needed{c.colourLabel ? ` · ${c.colourLabel}` : ''}</span>
                  </p>
                  {c.unitsRequired > 0 && (p.layoutsByComponent[c.componentId]?.length ?? 0) > 0 && (
                    <PlatePlanEditor unitsRequired={c.unitsRequired} layouts={p.layoutsByComponent[c.componentId]} plates={planOf(c.componentId)}
                      onChange={next => editPlan(c.componentId, next)} label={c.description} disabled={submitting} />
                  )}
                </div>
              ))}
              <FilamentTable filament={p.filament} />
              <p className="text-sm text-gray-700 dark:text-gray-300">{stockLine}</p>
            </>
          )}
        </section>

        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" disabled={submitting || qty === null || needsFor || !!editedProblem}>
            {submitting ? 'Creating…' : needsFor ? 'Choose who it is for' : 'Create job'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
