/**
 * Pure logic of the product page's two layouts (TABS and FOLDED): the stored
 * layout choice, the tab <-> URL hash mapping, which folded sections are
 * open, the header's one-line facts and each section's one-line summary.
 * No React, no fetching.
 */
import type { ProductPageLayout } from '@printforge/types';
import { formatAmount, formatPct, plural } from '@/lib/product-format';
import type { ApiProductImage, ComponentDetail, OptionCost, ProductCostPayload, ProductDetail } from '@/lib/types/api';
import { standardSizeColourRange } from './pricing-figures';
import { isSlicedRow, rowPrinterId, sourceOf } from './slice-ui';

// ---------- the layout choice ----------

export const DEFAULT_LAYOUT: ProductPageLayout = 'TABS';
export const LAYOUT_KEY = 'pf.productLayout';
export const LAYOUT_CHOICES: ReadonlyArray<{ value: ProductPageLayout; label: string; hint: string }> = [
  { value: 'TABS', label: 'Tabs', hint: 'One short screen; parts, options, pricing and photos each get a tab' },
  { value: 'FOLDED', label: 'One page', hint: 'Everything on one page as rows that fold away and show a summary' },
];

export function isLayout(raw: unknown): raw is ProductPageLayout {
  return raw === 'TABS' || raw === 'FOLDED';
}

/** The layout last used on this browser, for the first paint before /auth/me answers. */
export function readStoredLayout(): ProductPageLayout {
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    return isLayout(raw) ? raw : DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT; // no window (server) or storage blocked
  }
}

export function writeStoredLayout(layout: ProductPageLayout): void {
  try { window.localStorage.setItem(LAYOUT_KEY, layout); } catch { /* not remembered on this browser */ }
}

// ---------- TABS: tab <-> URL hash ----------

export const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'parts', label: 'Parts and plates' },
  { id: 'options', label: 'Sizes and colours' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'photos', label: 'Photos' },
] as const;

export type TabId = (typeof TABS)[number]['id'];
export const DEFAULT_TAB: TabId = 'overview';

/** `#pricing` (or `pricing`) -> 'pricing'; anything else -> the Overview tab. */
export function tabFromHash(hash: string | null | undefined): TabId {
  const token = (hash ?? '').replace(/^#/, '').trim().toLowerCase();
  // The bill of materials' own anchor still lands on the tab that holds it.
  if (token === 'bill-of-materials') return 'parts';
  return TABS.find(t => t.id === token)?.id ?? DEFAULT_TAB;
}

/** The bare token of a tab: `#pricing`; the Overview tab has none. */
export function hashOfTab(tab: TabId): string {
  return tab === DEFAULT_TAB ? '' : `#${tab}`;
}

/** Arrow-key navigation of the tab bar; null for any other key. */
export function tabAfterKey(current: TabId, key: string): TabId | null {
  const i = TABS.findIndex(t => t.id === current);
  if (key === 'ArrowRight') return TABS[(i + 1) % TABS.length].id;
  if (key === 'ArrowLeft') return TABS[(i - 1 + TABS.length) % TABS.length].id;
  if (key === 'Home') return TABS[0].id;
  if (key === 'End') return TABS[TABS.length - 1].id;
  return null;
}

// ---------- FOLDED: which sections are open ----------

export const FOLDED_SECTIONS = [
  { id: 'make', label: 'Make it' },
  { id: 'parts', label: 'Parts and plates' },
  { id: 'options', label: 'Sizes and colours' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'bulk', label: 'Bulk pricing' },
  { id: 'hardware', label: 'Hardware' },
  { id: 'photos', label: 'Photos' },
] as const;

export type SectionId = (typeof FOLDED_SECTIONS)[number]['id'];
export type FoldedState = Record<SectionId, boolean>;
export const FOLDED_KEY = 'pf.productFolded';

export function defaultFolded(): FoldedState {
  return { make: true, parts: true, options: false, pricing: false, bulk: false, hardware: false, photos: false };
}

/** Stored JSON -> open/closed per section; unknown keys and non-booleans fall back to the default. */
export function parseFolded(raw: string | null): FoldedState {
  const out = defaultFolded();
  if (!raw) return out;
  try {
    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== 'object' || stored === null) return out;
    for (const s of FOLDED_SECTIONS) {
      const v = (stored as Record<string, unknown>)[s.id];
      if (typeof v === 'boolean') out[s.id] = v;
    }
  } catch { /* not JSON: the defaults */ }
  return out;
}

export function readFolded(): FoldedState {
  try { return parseFolded(window.localStorage.getItem(FOLDED_KEY)); } catch { return defaultFolded(); }
}

export function writeFolded(state: FoldedState): void {
  try { window.localStorage.setItem(FOLDED_KEY, JSON.stringify(state)); } catch { /* not remembered on this browser */ }
}

// ---------- the header's facts ----------

export interface HeaderFacts {
  price: number;
  /** Formatted: one cost, or a range across the colours sold; null until the cost has loaded or when it can't be worked out. */
  cost: string | null;
  margin: string | null;
  gramsPerUnit: number | null;
  minutesPerUnit: number | null;
}

/** Price, cost, margin, grams and minutes of one unit of the standard size (what the four tiles used to say). */
export function headerFacts(
  product: ProductDetail,
  cost: ProductCostPayload | null,
  standardCost: OptionCost | null,
  formatCurrency: (n: number) => string,
): HeaderFacts {
  if (!cost || !standardCost) {
    return { price: product.basePrice, cost: null, margin: null, gramsPerUnit: null, minutesPerUnit: null };
  }
  const c = standardCost;
  const range = standardSizeColourRange(product, cost);
  const spread = (min: number, max: number) => Math.abs(max - min) >= 0.0005;
  let costText: string | null = c.perUnit ? formatCurrency(c.perUnit.total) : null;
  let marginText: string | null = c.marginPct !== null ? formatPct(c.marginPct) : null;
  if (range) {
    costText = spread(range.costMin, range.costMax)
      ? `${formatCurrency(range.costMin)} to ${formatAmount(range.costMax)}`
      : formatCurrency(range.costMin);
    if (range.marginMin !== null && range.marginMax !== null) {
      marginText = Math.abs(range.marginMax - range.marginMin) >= 0.05
        ? `${range.marginMin.toFixed(1)} to ${formatPct(range.marginMax)}`
        : formatPct(range.marginMin);
    }
  }
  return {
    price: c.storedPrice ?? product.basePrice,
    cost: costText,
    margin: marginText,
    gramsPerUnit: c.materials.reduce((s, m) => s + m.grams, 0),
    minutesPerUnit: c.machine.minutesPerUnit,
  };
}

// ---------- printers of plates ----------

type PlateRowLike = NonNullable<ComponentDetail['plates']>[number];

/** The farm printer a plate's file is for: the slicer's own, else the one matched from the file's header. */
export function plateRowPrinter(row: PlateRowLike, c: ComponentDetail, printers: ReadonlyMap<string, string> | null): string | null {
  if (isSlicedRow(row)) {
    const id = rowPrinterId(row, c.plateLayouts);
    const name = id ? printers?.get(id) ?? null : null;
    if (name) return name;
  }
  return row.printer?.name ?? null;
}

export function allComponents(p: ProductDetail): ComponentDetail[] {
  return [...p.components, ...p.sizes.flatMap(s => s.components)];
}

/** (component, layout) -> printer name, for the Make it plan line. */
export function platePrinterLookup(p: ProductDetail, printers: ReadonlyMap<string, string> | null) {
  const byId = new Map(allComponents(p).map(c => [c.id, c] as const));
  return (componentId: string, layoutId: string | null): string | null => {
    const c = byId.get(componentId);
    const row = c?.plates?.find(r => r.layoutId === layoutId);
    return c && row ? plateRowPrinter(row, c, printers) : null;
  };
}

/** Whether any part needs printer names by id (a source model, or a plate tied to a printer). */
export function needsPrinterNames(p: ProductDetail): boolean {
  return allComponents(p).some(c => sourceOf(c) !== null || c.plateLayouts.some(l => l.printerId));
}

// ---------- one-line summaries (FOLDED rows) ----------

export function partsSummary(components: ComponentDetail[]): string {
  if (components.length === 0) return 'No parts yet';
  const files = components.reduce((n, c) => n + (c.plates ?? []).filter(r => r.file).length, 0);
  return `${plural(components.length, 'part')} · ${plural(files, 'plate file')}`;
}

/** The standard size and the standard colour each count as one. */
export function optionsSummary(p: ProductDetail): string {
  const sizes = 1 + p.sizes.filter(s => s.isActive).length;
  const colours = 1 + p.colours.filter(c => c.isActive).length;
  return `${plural(sizes, 'size')} · ${plural(colours, 'colour')}`;
}

/** The words that mark Pricing (its tab, its folded row) while a pricing warning is showing. */
export const NEEDS_ATTENTION = 'needs attention';

/**
 * Whether the page shows a pricing warning: the cost could not be loaded, the
 * price was not recalculated (incomplete cost), or the stored price differs
 * from the current calculation. The same three cases PricingWarnings draws.
 */
export function pricingNeedsAttention(cost: ProductCostPayload | null, standardCost: OptionCost | null, costError: string | null): boolean {
  if (!cost || !standardCost) return costError !== null;
  return !standardCost.complete || (!standardCost.priceUpToDate && standardCost.computedPrice !== null);
}

export function pricingSummary(facts: HeaderFacts, formatCurrency: (n: number) => string, attention = false): string {
  const price = facts.price > 0 ? formatCurrency(facts.price) : 'No price';
  const text = facts.margin ? `${price} · ${facts.margin} margin` : price;
  return attention ? `${text} · ${NEEDS_ATTENTION}` : text;
}

/** Tiers over every size; `unsaved` when tiers were typed and not saved yet. */
export function bulkSummary(p: ProductDetail, unsaved = false): string {
  const n = p.priceTiers.length + p.sizes.reduce((s, x) => s + x.priceTiers.length, 0);
  const text = n === 0 ? 'No tiers' : plural(n, 'tier');
  return unsaved ? `${text} · unsaved changes` : text;
}

/** Bought-in hardware per unit, from the cost payload (the section itself loads its own list when opened). */
export function hardwareSummary(standardCost: OptionCost | null): string {
  if (!standardCost) return '';
  if (standardCost.parts.length === 0) return 'None';
  return standardCost.parts.map(x => `${x.name} × ${x.quantity}`).join(', ');
}

export function photosSummary(images: ApiProductImage[] | null): string {
  if (!images) return '';
  return images.length === 0 ? 'No photos' : plural(images.length, 'photo');
}
