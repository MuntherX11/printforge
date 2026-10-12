'use client';

import { useEffect, useId, useState } from 'react';
import { Factory } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { policyLabel, plural } from '@/lib/product-format';
import type { ProductDetail } from '@/lib/types/api';
import { ColourSelect, SizeSelect } from '@/components/products/OptionPickers';
import { PartsTable, ProblemList, ReadinessFilamentTable } from './readiness-ui';
import { planLine, planLines, verdictOf } from './readiness-model';
import { DisclosureButton, Pill, SectionHead } from './section-ui';
import { MAX_READINESS_QTY, type ReadinessState } from './useReadiness';
import type { NewJobPrefill } from './NewJobDialog';

interface Props {
  product: ProductDetail;
  /** The page's readiness check (useReadiness): the pickers, the quantity and the answer. */
  readiness: ReadinessState;
  canEdit: boolean;
  /** Names the printer of a part's plate, for the plan line. */
  printerOf: (componentId: string, layoutId: string | null) => string | null;
  onCreateJob: (prefill: NewJobPrefill) => void;
  /** Heading drawn by the tabs layout; the folded layout's row already says it. */
  title?: string;
}

const DETAILS_KEY = 'pf.readiness.details';
const FIELD = 'h-10 rounded-md border bg-white px-3 text-sm dark:bg-gray-800 dark:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

/** "Show filaments and spools", remembered on this browser; storage may be unavailable. */
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

/**
 * "Make it" (was Production readiness, spec §5.2 F, P20): a quantity, one
 * verdict, one plan line. The filament, spool and hardware tables and the
 * warnings sit behind "Show filaments and spools"; problems that block the
 * job are always shown.
 */
export function MakeItBody({ product, readiness, canEdit, printerOf, onCreateJob, title }: Props) {
  const { options, pair, qtyText, setQtyText, qty, data: r, error, loading } = readiness;
  const [details, toggleDetails] = useDetailsToggle();
  const qtyId = useId();
  const detailsId = useId();
  const verdict = r ? verdictOf(r) : null;
  const plan = r ? planLines(r.components) : null;
  const hasExtras = !!r && r.components.some(c => c.surplus > 0);
  const hasPickers = options.hasSizes || options.hasColours;

  return (
    <div className="space-y-3">
      <SectionHead title={title} />
      <div className="flex flex-wrap items-end gap-3">
        {options.hasSizes && <div className="min-w-[10rem]"><SizeSelect options={options} value={pair.sizeKey} onChange={pair.setSizeKey} /></div>}
        {options.hasColours && (
          <div className="min-w-[12rem]">
            <ColourSelect options={options} sizeKey={pair.sizeKey} value={pair.colourKey} onChange={pair.setColourKey} note={pair.note} />
          </div>
        )}
        <div className="space-y-1">
          <label htmlFor={qtyId} className={hasPickers ? 'block text-sm font-medium text-gray-700 dark:text-gray-300' : 'sr-only'}>Quantity</label>
          <div className="flex items-center gap-2">
            <input id={qtyId} type="number" inputMode="numeric" min={1} max={MAX_READINESS_QTY} step={1} value={qtyText}
              onChange={e => setQtyText(e.target.value)} aria-invalid={qty === null}
              className={`${FIELD} w-24 font-mono tabular-nums ${qty === null ? 'border-red-500' : 'border-gray-300 dark:border-gray-600'}`} />
            <span className="text-sm text-gray-500 dark:text-gray-400">units</span>
          </div>
        </div>
        <div className="flex min-h-[40px] min-w-[12rem] flex-1 items-center" aria-live="polite">
          {verdict && <Pill tone={verdict.tone}>{verdict.text}</Pill>}
          {!r && !error && <span className="text-sm text-gray-500 dark:text-gray-400">Checking…</span>}
        </div>
        {canEdit && qty !== null && (
          <Button variant="outline" className="ml-auto" onClick={() => onCreateJob({ sizeKey: pair.sizeKey, colourKey: pair.colourKey, quantity: qty })}>
            <Factory className="mr-2 h-4 w-4" aria-hidden="true" /> Create job
          </Button>
        )}
      </div>
      {qty === null && <p className="text-xs text-red-600 dark:text-red-400">Whole number from 1 to 100,000</p>}
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {r && plan && (
        <div className={loading ? 'space-y-3 opacity-60' : 'space-y-3'}>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-500 dark:text-gray-400">
            <span>{planLine(r, printerOf)}</span>
            <DisclosureButton open={details} onToggle={toggleDetails} controls={detailsId} show="Show filaments and spools" hide="Hide filaments and spools" />
            {!details && r.warnings.length > 0 && <span className="text-amber-700 dark:text-amber-300">({plural(r.warnings.length, 'warning')})</span>}
          </p>
          <ProblemList problems={r.problems} tone="error" />
          {details && (
            <div id={detailsId} className="space-y-3">
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
    </div>
  );
}
