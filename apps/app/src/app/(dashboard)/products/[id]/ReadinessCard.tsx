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
import { ComponentPlanLines, FilamentTable, PartsTable, ProblemList, ReadinessSummary } from './readiness-ui';
import type { NewJobPrefill } from './NewJobDialog';

interface Props {
  product: ProductDetail;
  /** Changes whenever the cost inputs change (refetch trigger). */
  costVersion: string | null;
  canEdit: boolean;
  onCreateJob: (prefill: NewJobPrefill) => void;
}

const MAX_QTY = 100_000;

/** Section F (spec §5.2 F, P20): can we make N of this pair from what is on the shelf? */
export function ReadinessCard({ product, costVersion, canEdit, onCreateJob }: Props) {
  const options = useMemo(() => pickerOptionsFromDetail(product), [product]);
  const pair = useOptionPair(options);
  const [qtyText, setQtyText] = useState('1');
  const [state, setState] = useState<{ data: Readiness | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
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
          <p className="self-end pb-2 text-xs text-gray-500 dark:text-gray-400">
            Extras on the last plate: {policyLabel(r?.surplusPolicy ?? product.surplusPolicy)} (product setting)
          </p>
        </div>

        {state.error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{state.error}</p>}
        {!r && !state.error && <p className="text-sm text-gray-500 dark:text-gray-400">Checking…</p>}
        {r && (
          <div className={state.loading ? 'space-y-4 opacity-60' : 'space-y-4'}>
            <ProblemList problems={r.problems} tone="error" />
            <ProblemList problems={r.warnings} tone="warning" />
            <ComponentPlanLines components={r.components} />
            <FilamentTable filament={r.filament} />
            <PartsTable parts={r.parts} />
            <ReadinessSummary readiness={r} />
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
