'use client';

import { useEffect, useMemo, useState } from 'react';
import { Factory } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { policyLabel } from '@/lib/product-format';
import type { ProductDetail, Readiness } from '@/lib/types/api';
import { ColourSelect, SizeSelect, pickerOptionsFromDetail, useOptionPair } from '@/components/products/OptionPickers';
import { errorText } from './options-ui';
import { parseWhole } from './bom-model';
import { PartsTable, ProblemList, ReadinessFilamentTable } from './readiness-ui';
import { planLines, readinessStatus } from './readiness-model';
import type { NewJobPrefill } from './NewJobDialog';

interface Props {
  product: ProductDetail;
  /** Changes whenever the cost inputs change (refetch trigger). */
  costVersion: string | null;
  canEdit: boolean;
  onCreateJob: (prefill: NewJobPrefill) => void;
}

const MAX_QTY = 100_000;
const DETAILS_KEY = 'pf.readiness.details';

const TONE = {
  ok: 'text-green-700 dark:text-green-400',
  short: 'text-amber-700 dark:text-amber-300',
  blocked: 'text-red-600 dark:text-red-400',
};

/** "Show details", remembered on this browser; storage may be unavailable. */
function useDetailsToggle(): [boolean, () => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try { setOpen(window.localStorage.getItem(DETAILS_KEY) === '1'); } catch { /* storage blocked: closed */ }
  }, []);
  const toggle = () => setOpen(o => {
    try { window.localStorage.setItem(DETAILS_KEY, o ? '0' : '1'); } catch { /* not remembered */ }
    return !o;
  });
  return [open, toggle];
}

/** Section F (spec §5.2 F, P20): can we make N of this pair from what is on the shelf? */
export function ReadinessCard({ product, costVersion, canEdit, onCreateJob }: Props) {
  const options = useMemo(() => pickerOptionsFromDetail(product), [product]);
  const pair = useOptionPair(options);
  const [qtyText, setQtyText] = useState('1');
  const [state, setState] = useState<{ data: Readiness | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [details, toggleDetails] = useDetailsToggle();
  const qty = parseWhole(qtyText, 1, MAX_QTY);

  useEffect(() => {
    if (qty === null) return;
    let live = true;
    setState(s => ({ ...s, loading: true }));
    const t = window.setTimeout(() => {
      const q = new URLSearchParams({ sizeOptionId: pair.sizeKey, colourOptionId: pair.colourKey, qty: String(qty) });
      api.get<Readiness>(`/products/${product.id}/readiness?${q}`)
        .then(data => { if (live) setState({ data, error: null, loading: false }); })
        .catch(err => { if (live) setState({ data: null, error: errorText(err, 'Couldn\'t check readiness'), loading: false }); });
    }, 300);
    return () => { live = false; window.clearTimeout(t); };
  }, [product.id, pair.sizeKey, pair.colourKey, qty, costVersion]);

  const r = state.data;
  const status = r ? readinessStatus(r) : null;
  const plan = r ? planLines(r.components) : null;
  const hasExtras = !!r && r.components.some(c => c.surplus > 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Production readiness</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-[10rem]"><SizeSelect options={options} value={pair.sizeKey} onChange={pair.setSizeKey} /></div>
          <div className="min-w-[12rem]">
            <ColourSelect options={options} sizeKey={pair.sizeKey} value={pair.colourKey} onChange={pair.setColourKey} note={pair.note} />
          </div>
          <div className="w-32">
            <Input label="Quantity (units)" type="number" min={1} max={MAX_QTY} step={1} value={qtyText}
              onChange={e => setQtyText(e.target.value)} error={qty === null ? 'Whole number from 1 to 100,000' : undefined} />
          </div>
        </div>

        {state.error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{state.error}</p>}
        {!r && !state.error && <p className="text-sm text-gray-500 dark:text-gray-400">Checking…</p>}
        {r && status && plan && (
          <div className={state.loading ? 'space-y-3 opacity-60' : 'space-y-3'}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className={`text-sm font-medium ${TONE[status.tone]}`} aria-live="polite">{status.text}</p>
              <button type="button" onClick={toggleDetails} aria-expanded={details}
                className="text-sm text-brand-600 hover:underline dark:text-brand-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded">
                {details ? 'Hide details' : 'Show details'}
              </button>
            </div>
            <ProblemList problems={r.problems} tone="error" />
            {details && (
              <div className="space-y-3">
                <ProblemList problems={r.warnings} tone="warning" />
                <ul className="space-y-0.5 text-sm text-gray-700 dark:text-gray-300">
                  {plan.lines.map(line => <li key={line}>{line}</li>)}
                  {plan.restOnce && <li>{plan.lines.length > 0 ? 'The other parts print once.' : 'Each part prints once.'}</li>}
                </ul>
                {hasExtras && (
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Extras on the last plate: {policyLabel(r.surplusPolicy ?? product.surplusPolicy)} (product setting)
                  </p>
                )}
                <ReadinessFilamentTable filament={r.filament} />
                <PartsTable parts={r.parts} />
              </div>
            )}
          </div>
        )}

        {canEdit && qty !== null && (
          <Button variant="outline" onClick={() => onCreateJob({ sizeKey: pair.sizeKey, colourKey: pair.colourKey, quantity: qty })}>
            <Factory className="mr-2 h-4 w-4" aria-hidden="true" /> Create job for this
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
