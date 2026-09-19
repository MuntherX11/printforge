import type { CellCost, ProductCostPayload, ProductDetail } from '@/lib/types/api';

/** Cost and margin across what is actually sold on the standard size (spec §5.2 B). */
export interface ColourRange {
  costMin: number;
  costMax: number;
  marginMin: number | null;
  marginMax: number | null;
  /** Colour label of the lowest margin. */
  lowestColour: string | null;
  /** The standard colour's own cell (for the sub-label). */
  standard: CellCost | null;
  /** Colours whose cost couldn't be computed (left out of the range). */
  unknown: string[];
}

/**
 * Ranges over the standard size's P16 cells: the standard colour and every
 * active colour, excluded pairs skipped. null when the product has no active
 * colours (the Pricing card then shows the single standard figures).
 */
export function standardSizeColourRange(product: ProductDetail, cost: ProductCostPayload): ColourRange | null {
  const activeColours = new Set(product.colours.filter(c => c.isActive).map(c => c.id));
  if (activeColours.size === 0) return null;

  const cells = cost.cells.filter(c =>
    c.sizeOptionId === null
    && !c.excluded
    && (c.colourOptionId === null || activeColours.has(c.colourOptionId)));
  const known = cells.filter(c => c.costPerUnit !== null);
  if (known.length === 0) return null;

  const costs = known.map(c => c.costPerUnit as number);
  const withMargin = known.filter(c => c.marginPct !== null);
  let lowest: CellCost | null = null;
  for (const c of withMargin) {
    if (!lowest || (c.marginPct as number) < (lowest.marginPct as number)) lowest = c;
  }
  const margins = withMargin.map(c => c.marginPct as number);

  return {
    costMin: Math.min(...costs),
    costMax: Math.max(...costs),
    marginMin: margins.length ? Math.min(...margins) : null,
    marginMax: margins.length ? Math.max(...margins) : null,
    lowestColour: lowest ? lowest.colourLabel : null,
    standard: cells.find(c => c.colourOptionId === null) ?? null,
    unknown: cells.filter(c => c.costPerUnit === null).map(c => c.colourLabel),
  };
}

/** Σ colour changes over the standard size's components (slicer-imported products). */
export function slicerColourChanges(product: ProductDetail): number {
  return product.components.reduce((s, c) => s + (c.colorChanges || 0), 0);
}

/**
 * Splits a problem message around its first quoted name, so the page can link
 * the filament name in `Filament "PLA Red" has no cost per gram …`.
 */
export function splitQuoted(message: string): { before: string; name: string; after: string } | null {
  const m = /^(.*?)"([^"]+)"(.*)$/.exec(message);
  return m ? { before: m[1], name: m[2], after: m[3] } : null;
}
