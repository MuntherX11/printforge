'use client';

/**
 * Small grey text under a line price (spec §5.3): where the price comes from.
 * Staff screens only — never render this on a customer page (tiers, costs
 * and margins are staff-only, §0.2).
 *
 * - `Tier 50+ · list 1.500 · −20 %` (+ ` (25 across 2 lines of Regular)` on
 *   editable forms when the tier counts more than one line)
 * - `List price`, or `Standard price — size not set up`
 * - `Manual price · list 1.500 · Reset`
 * - red `Below cost (cost 1.420)` / amber `Thin margin`
 * - an S1 `error` in red instead of all of the above
 */
import type { PriceSource } from '@/lib/types/api';

export interface LinePriceInfo {
  priceSource: PriceSource | null;
  listUnitPrice: number | null;
  tierMinQty: number | null;
  unitPrice: number | null;
  tierQuantity?: number | null;
  tierLineCount?: number | null;
  tierSizeLabel?: string | null;
  unitCostFloor?: number | null;
  warningCodes?: string[];
  error?: string | null;
}

interface Props {
  info: LinePriceInfo | null;
  /** The product has sizes: the tier count names the size. */
  hasSizes?: boolean;
  /** Order/quote detail: `Tier 50+` without the line count, no Reset. */
  readOnly?: boolean;
  onReset?: () => void;
}

const money = (n: number) => n.toFixed(3);

export function LinePriceHint({ info, hasSizes, readOnly, onReset }: Props) {
  if (!info) return null;
  if (info.error) return <p className="mt-1 text-xs text-red-600 dark:text-red-400">{info.error}</p>;
  if (!info.priceSource) return null;
  // Custom lines have no list price: nothing to explain.
  if (info.priceSource === 'MANUAL' && info.listUnitPrice === null) return null;

  const codes = info.warningCodes ?? [];
  const list = info.listUnitPrice;
  let text: React.ReactNode;
  if (info.priceSource === 'TIER') {
    const off = list && info.unitPrice !== null && list > 0 ? Math.round((1 - info.unitPrice / list) * 100) : null;
    const across = !readOnly && (info.tierLineCount ?? 0) > 1
      ? ` (${info.tierQuantity} across ${info.tierLineCount} lines${hasSizes && info.tierSizeLabel ? ` of ${info.tierSizeLabel}` : ''})`
      : '';
    text = `Tier ${info.tierMinQty}+${list !== null ? ` · list ${money(list)}` : ''}${off ? ` · −${off} %` : ''}${across}`;
  } else if (info.priceSource === 'MANUAL') {
    text = (
      <>
        Manual price{list !== null ? ` · list ${money(list)}` : ''}
        {!readOnly && onReset && (
          <>
            {' · '}
            <button type="button" onClick={onReset} className="font-medium text-brand-600 hover:underline dark:text-brand-400">Reset</button>
          </>
        )}
      </>
    );
  } else {
    text = codes.includes('OPTION_NOT_SET_UP') ? 'Standard price — size not set up' : 'List price';
  }

  const floor = info.unitCostFloor ?? null;
  return (
    <div className="mt-1 space-y-0.5 text-xs">
      <p className="text-gray-500 dark:text-gray-400">{text}</p>
      {codes.includes('BELOW_COST') && (
        <p className="text-red-600 dark:text-red-400">Below cost{floor !== null ? ` (cost ${money(floor)})` : ''}</p>
      )}
      {codes.includes('THIN_MARGIN') && <p className="text-amber-600 dark:text-amber-400">Thin margin</p>}
    </div>
  );
}

/** S1 line → hint input. */
export function hintFromPreview(p: {
  priceSource: PriceSource | null; listUnitPrice: number | null; tierMinQty: number | null; effectiveUnitPrice: number | null;
  tierQuantity: number | null; tierLineCount: number | null; tierSizeLabel: string | null; unitCostFloor: number | null;
  warningCodes: string[]; error: string | null;
} | null): LinePriceInfo | null {
  if (!p) return null;
  return { ...p, unitPrice: p.effectiveUnitPrice };
}
