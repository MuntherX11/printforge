'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loading } from '@/components/ui/loading';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useFormatCurrency } from '@/lib/locale-context';
import { formatAmount, formatGrams, formatMinutes, formatPct } from '@/lib/product-format';
import type { ApiCalculateResult, ApiPrinter, OptionCost, Problem, ProductCostPayload, ProductDetail } from '@/lib/types/api';
import { CostBreakdownTable } from './CostBreakdownTable';
import { slicerColourChanges, splitQuoted, standardSizeColourRange } from './pricing-figures';

interface Props {
  product: ProductDetail;
  cost: ProductCostPayload | null;
  standardCost: OptionCost | null;
  costError: string | null;
  canEdit: boolean;
  loadPrinters: () => Promise<ApiPrinter[]>;
  /** Reload product and cost (after a recalculation or a printer change). */
  onChanged: () => Promise<void> | void;
}

function Figure({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'brand' }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-3">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className={`text-lg font-semibold tabular-nums ${tone === 'brand' ? 'text-brand-600 dark:text-brand-400' : 'text-gray-900 dark:text-gray-100'}`}>{value}</dd>
      {sub && <dd className="text-xs text-gray-500 dark:text-gray-400">{sub}</dd>}
    </div>
  );
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

/** Section B (spec §5.2): the standard size's price on the standard colour, always from the live cost. */
export function PricingCard({ product, cost, standardCost, costError, canEdit, loadPrinters, onChanged }: Props) {
  const formatCurrency = useFormatCurrency();
  const { toast } = useToast();
  const [showBreakdown, setShowBreakdown] = useState(true);
  const [printers, setPrinters] = useState<ApiPrinter[] | null>(null);
  const [busy, setBusy] = useState<'recalc' | 'printer' | null>(null);

  useEffect(() => {
    if (!canEdit) return;
    loadPrinters().then(setPrinters).catch(() => setPrinters([]));
  }, [canEdit, loadPrinters]);

  async function recalculate() {
    setBusy('recalc');
    try {
      const r = await api.post<ApiCalculateResult>(`/products/${product.id}/calculate`);
      const std = r.applied.find(a => a.sizeOptionId === null);
      if (std && !std.applied) toast('warning', 'Price not recalculated — fix the problems shown on the card first');
      else toast('success', 'Price recalculated');
      await onChanged();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Recalculation failed');
    } finally {
      setBusy(null);
    }
  }

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

  let body: React.ReactNode;
  if (!cost || !standardCost) {
    body = costError ? (
      <p className="text-sm text-red-600 dark:text-red-400">
        Couldn&apos;t load the cost — {costError}.{' '}
        <button type="button" className="underline" onClick={() => void onChanged()}>Retry</button>
      </p>
    ) : <Loading text="Loading cost…" />;
  } else {
    const c = standardCost;
    const range = standardSizeColourRange(product, cost);
    const price = c.storedPrice ?? product.basePrice;
    const markupSub = c.markup.source === 'PRINTER' ? `from printer ${c.markup.printerName ?? ''}`.trim() : 'from Settings';
    const gramsPerUnit = c.materials.reduce((s, m) => s + m.grams, 0);
    const estimated = product.components.some(x => x.perUnitEstimatedFrom !== null);

    const costValue = range
      ? `${formatCurrency(range.costMin)}–${formatAmount(range.costMax)}`
      : c.perUnit ? formatCurrency(c.perUnit.total) : '—';
    const marginValue = range && range.marginMin !== null && range.marginMax !== null
      ? `${range.marginMin.toFixed(1)}–${formatPct(range.marginMax)}`
      : c.marginPct !== null ? formatPct(c.marginPct) : '—';

    let colourChanges: { value: string; sub?: string };
    if (c.purge.basis === 'SLICER_INCLUDED') {
      colourChanges = { value: 'In slicer files', sub: `Σ ${slicerColourChanges(product)} changes · purge included in slicer weights` };
    } else if (c.purge.basis === 'COLOUR_CHANGES') {
      colourChanges = { value: String(product.colorChanges), sub: `× ${formatGrams(c.purge.gramsPerChange)} purge each` };
    } else {
      colourChanges = { value: '0' };
    }

    let status: React.ReactNode;
    if (!c.complete) {
      status = (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          Price not recalculated —{' '}
          {c.problems.slice(0, 3).map((p, i) => (
            <span key={`${p.code}-${i}`}>{i > 0 && '; '}<ProblemText problem={p} /></span>
          ))}
          {' '}
          {price > 0
            ? `The stored price (${formatAmount(price)}) is still used for orders.`
            : 'No price — customers can\'t order this product.'}
        </div>
      );
    } else if (!c.priceUpToDate && c.computedPrice !== null) {
      status = (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          <span className="flex-1">
            Stored price {formatAmount(price)} differs from the current calculation {formatAmount(c.computedPrice)}.
          </span>
          {canEdit && (
            <Button size="sm" onClick={recalculate} disabled={busy !== null}>
              {busy === 'recalc' ? 'Recalculating…' : 'Recalculate price'}
            </Button>
          )}
        </div>
      );
    } else {
      status = (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Price is automatic: cost × markup. It updates when components, filaments, parts or the pricing printer change.
        </p>
      );
    }

    body = (
      <div className="space-y-4">
        <dl className="grid grid-cols-2 overflow-hidden rounded-lg border border-gray-200 divide-gray-100 dark:border-gray-700 dark:divide-gray-800 sm:grid-cols-4 sm:divide-x">
          <Figure label="Price per unit" value={formatCurrency(price)} tone="brand" />
          <Figure label="Cost per unit" value={costValue} sub={range ? 'across colours' : undefined} />
          <Figure label="Markup" value={`${c.markup.multiplier}×`} sub={markupSub} />
          <Figure label="Margin" value={marginValue} sub={range?.lowestColour ? `lowest: ${range.lowestColour}` : undefined} />
        </dl>
        {range && (
          <div className="space-y-0.5 text-xs text-gray-500 dark:text-gray-400">
            {range.standard && range.standard.costPerUnit !== null && (
              <p>
                standard colour ({range.standard.colourLabel}): {formatAmount(range.standard.costPerUnit)}
                {range.standard.marginPct !== null && ` · ${formatPct(range.standard.marginPct)}`}
                {!product.standardColourSellableToCustomers && ' — not in the shop'}
              </p>
            )}
            {range.unknown.length > 0 && <p className="text-amber-700 dark:text-amber-400">Cost unknown for {range.unknown.join(', ')} — not in the range.</p>}
            <p>Colours don&apos;t change the price — see Sizes &amp; colours for cost per colour.</p>
          </div>
        )}
        {status}

        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="min-w-[16rem]">
            <label htmlFor="pricing-printer" className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Pricing printer (machine rate × markup)
            </label>
            {canEdit && printers ? (
              <select
                id="pricing-printer"
                className="mt-1 flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                value={product.defaultPrinterId ?? ''}
                disabled={busy !== null}
                onChange={e => void changePrinter(e.target.value)}
              >
                <option value="">None — use Settings</option>
                {printers.filter(p => p.isActive || p.id === product.defaultPrinterId).map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            ) : (
              <p id="pricing-printer" className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                {product.defaultPrinter?.name ?? 'None — uses Settings'}
              </p>
            )}
          </div>
          <dl className="flex flex-wrap gap-x-8 gap-y-2">
            <Figure label="Filament per unit" value={formatGrams(gramsPerUnit)} />
            <Figure label="Print time per unit" value={formatMinutes(c.machine.minutesPerUnit)} />
            <Figure label="Colour changes" value={colourChanges.value} sub={colourChanges.sub} />
          </dl>
        </div>
        {estimated && (
          <p className="text-xs text-gray-500 dark:text-gray-400">Some per-unit figures are estimated from multi-unit plates.</p>
        )}

        <div>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
            aria-expanded={showBreakdown}
            onClick={() => setShowBreakdown(s => !s)}
          >
            {showBreakdown ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
            {showBreakdown ? 'Hide cost breakdown' : 'Show cost breakdown'}
          </button>
          {showBreakdown && <div className="mt-3"><CostBreakdownTable cost={c} /></div>}
        </div>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="dark:text-gray-100">Pricing</CardTitle>
        {sizesExist && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {standardLabel} size on the {product.standardColourLabel ?? 'standard'} colour. Other sizes&apos; prices are in Sizes &amp; colours.
          </p>
        )}
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
