'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Loading } from '@/components/ui/loading';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useFormatCurrency } from '@/lib/locale-context';
import { formatAmount, formatGrams, formatPct } from '@/lib/product-format';
import type { ApiCalculateResult, ApiPrinter, OptionCost, Problem, ProductCostPayload, ProductDetail } from '@/lib/types/api';
import { CostBreakdownTable } from './CostBreakdownTable';
import { slicerColourChanges, splitQuoted, standardSizeColourRange } from './pricing-figures';
import { DisclosureButton, Fact, HowThisWorks, SectionHead } from './section-ui';

interface Props {
  product: ProductDetail;
  cost: ProductCostPayload | null;
  standardCost: OptionCost | null;
  costError: string | null;
  canEdit: boolean;
  loadPrinters: () => Promise<ApiPrinter[]>;
  /** Reload product and cost (after a recalculation or a printer change). */
  onChanged: () => Promise<void> | void;
  /** Heading drawn by the tabs layout; the folded layout's row already says it. */
  title?: string;
}

function ProblemText({ problem }: { problem: Problem }) {
  const parts = problem.code === 'MATERIAL_ZERO_COST' && problem.materialId ? splitQuoted(problem.message) : null;
  if (!parts) return <>{problem.message}</>;
  return (
    <>
      {parts.before}&quot;
      <Link href={`/inventory/${problem.materialId}`} className="underline hover:no-underline">{parts.name}</Link>
      &quot;{parts.after}
    </>
  );
}

/**
 * The pricing warnings, drawn by the page above both layouts so they are seen
 * whichever tab or folded row is open: the cost that could not be loaded (with
 * Retry), the price that was not recalculated because the cost is incomplete,
 * and the stored price that differs from the current calculation (with
 * Recalculate price). Draws nothing when there is none; `pricingNeedsAttention`
 * (product-layout.ts) answers the same question for the Pricing markers.
 */
export function PricingWarnings({ product, cost, standardCost, costError, canEdit, onChanged }: Pick<Props, 'product' | 'cost' | 'standardCost' | 'costError' | 'canEdit' | 'onChanged'>) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  async function recalculate() {
    setBusy(true);
    try {
      const r = await api.post<ApiCalculateResult>(`/products/${product.id}/calculate`);
      const std = r.applied.find(a => a.sizeOptionId === null);
      if (std && !std.applied) toast('warning', 'Price not recalculated. Fix the problems shown at the top of the page first');
      else toast('success', 'Price recalculated');
      await onChanged();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Recalculation failed');
    } finally {
      setBusy(false);
    }
  }

  if (!cost || !standardCost) {
    if (!costError) return null;
    return (
      <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
        Couldn&apos;t load the cost: {costError}.{' '}
        <button type="button" className="rounded font-medium underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" onClick={() => void onChanged()}>Retry</button>
      </p>
    );
  }

  const c = standardCost;
  const price = c.storedPrice ?? product.basePrice;
  if (!c.complete) {
    return (
      <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
        Price not recalculated:{' '}
        {c.problems.slice(0, 3).map((p, i) => (
          <span key={`${p.code}-${i}`}>{i > 0 && '; '}<ProblemText problem={p} /></span>
        ))}
        {'. '}
        {price > 0
          ? `The stored price (${formatAmount(price)}) is still used for orders.`
          : 'No price, so customers can\'t order this product.'}
      </div>
    );
  }
  if (!c.priceUpToDate && c.computedPrice !== null) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
        <span className="flex-1">
          Stored price {formatAmount(price)} differs from the current calculation {formatAmount(c.computedPrice)}.
        </span>
        {canEdit && (
          <Button size="sm" onClick={recalculate} disabled={busy}>
            {busy ? 'Recalculating…' : 'Recalculate price'}
          </Button>
        )}
      </div>
    );
  }
  return null;
}

/**
 * Pricing (spec §5.2 B): the standard size's price on the standard colour,
 * always from the live cost. Price, cost and margin are in the page header
 * and the warnings above the layout (PricingWarnings, drawn by the page);
 * here are the pricing printer and, behind "Show how the cost is worked out",
 * the cost breakdown.
 */
export function PricingBody({ product, cost, standardCost, costError, canEdit, loadPrinters, onChanged, title }: Props) {
  const formatCurrency = useFormatCurrency();
  const { toast } = useToast();
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [printers, setPrinters] = useState<ApiPrinter[] | null>(null);
  const [printersError, setPrintersError] = useState(false);
  const [busy, setBusy] = useState<'printer' | null>(null);
  const breakdownId = useId();

  // A failed load keeps the read-only printer name (never a list without the current printer).
  const fetchPrinters = useCallback(() => {
    setPrintersError(false);
    loadPrinters().then(setPrinters).catch(() => setPrintersError(true));
  }, [loadPrinters]);

  useEffect(() => {
    if (!canEdit) return;
    fetchPrinters();
  }, [canEdit, fetchPrinters]);

  async function changePrinter(value: string) {
    setBusy('printer');
    try {
      await api.patch(`/products/${product.id}`, { defaultPrinterId: value || null });
      await onChanged();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Couldn\'t change the pricing printer');
    } finally {
      setBusy(null);
    }
  }

  const sizesExist = product.sizes.length > 0;
  const standardLabel = product.baseOptionLabel ?? 'Standard';

  if (!cost || !standardCost) {
    return (
      <div className="space-y-3">
        <SectionHead title={title} />
        {/* The error itself, with Retry, is at the top of the page (PricingWarnings). */}
        {costError
          ? <p className="text-sm text-gray-600 dark:text-gray-400">Nothing to show here until the cost has loaded.</p>
          : <Loading text="Loading cost…" />}
      </div>
    );
  }

  const c = standardCost;
  const range = standardSizeColourRange(product, cost);
  const markupSub = c.markup.source === 'PRINTER' ? `from printer ${c.markup.printerName ?? ''}`.trim() : 'from Settings';
  const estimated = product.components.some(x => x.perUnitEstimatedFrom !== null);

  let colourChanges: string;
  if (c.purge.basis === 'SLICER_INCLUDED') {
    colourChanges = `in the slicer files (${slicerColourChanges(product)} changes, purge included in the slicer weights)`;
  } else if (c.purge.basis === 'COLOUR_CHANGES') {
    colourChanges = `${product.colorChanges} × ${formatGrams(c.purge.gramsPerChange)} purge each`;
  } else {
    colourChanges = '0';
  }

  return (
    <div className="space-y-3">
      <SectionHead title={title} />
      {range && range.unknown.length > 0 && (
        <p className="text-sm text-amber-700 dark:text-amber-400">Cost unknown for {range.unknown.join(', ')}; not in the cost range.</p>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label htmlFor="pricing-printer" className="text-sm text-gray-600 dark:text-gray-400" title="Its machine rate and markup price this product">
          Pricing printer
        </label>
        {canEdit && printers ? (
          <select
            id="pricing-printer"
            className="h-10 min-w-[12rem] rounded-md border border-gray-300 bg-white px-3 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            value={product.defaultPrinterId ?? ''}
            disabled={busy !== null}
            onChange={e => void changePrinter(e.target.value)}
          >
            <option value="">None, use Settings</option>
            {printers.filter(p => p.isActive || p.id === product.defaultPrinterId).map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        ) : (
          <span id="pricing-printer" className="text-sm text-gray-900 dark:text-gray-100">
            {product.defaultPrinter?.name ?? 'None, uses Settings'}
            {canEdit && printersError && (
              <span className="ml-2 text-xs text-red-600 dark:text-red-400">
                Couldn&apos;t load printers.{' '}
                <button type="button" className="underline" onClick={fetchPrinters}>Retry</button>
              </span>
            )}
          </span>
        )}
        <DisclosureButton open={showBreakdown} onToggle={() => setShowBreakdown(s => !s)} controls={showBreakdown ? breakdownId : undefined}
          show="Show how the cost is worked out" hide="Hide how the cost is worked out" />
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400">
        Price is cost × markup and updates itself.
        {sizesExist && ` Shown for ${standardLabel} on the ${product.standardColourLabel ?? 'standard'} colour.`}
      </p>
      <HowThisWorks>
        <p>The price is automatic: cost × markup. It updates when components, filaments, parts or the pricing printer change.</p>
        <p>The pricing printer supplies the machine rate and the markup; with none chosen, both come from Settings.</p>
        {sizesExist && <p>Other sizes have their own prices, listed under Sizes and colours.</p>}
        {range && <p>Colours don&apos;t change the price. Cost per colour is listed under Sizes and colours.</p>}
      </HowThisWorks>

      {showBreakdown && (
        <div id={breakdownId} className="space-y-3">
          <p className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-gray-600 dark:text-gray-400">
            <span>Markup <Fact>{c.markup.multiplier}×</Fact> {markupSub}</span>
            <span>Colour changes: {colourChanges}</span>
            {range?.standard && range.standard.costPerUnit !== null && (
              <span>
                Standard colour ({range.standard.colourLabel}): <Fact>{formatCurrency(range.standard.costPerUnit)}</Fact>
                {range.standard.marginPct !== null && <> · <Fact>{formatPct(range.standard.marginPct)}</Fact></>}
                {!product.standardColourSellableToCustomers && ', not in the shop'}
              </span>
            )}
            {range?.lowestColour && <span>Lowest margin: {range.lowestColour}</span>}
          </p>
          {estimated && (
            <p className="text-xs text-gray-500 dark:text-gray-400">Some per-unit figures are estimated from multi-unit plates.</p>
          )}
          <CostBreakdownTable cost={c} />
        </div>
      )}
    </div>
  );
}
