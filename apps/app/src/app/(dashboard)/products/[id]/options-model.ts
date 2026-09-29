/**
 * Pure helpers for section C (Sizes & colours, spec §5.2 C). No React, no
 * fetching: everything is derived from ProductDetail / the P16 payload.
 */
import type {
  CellCost,
  ColourOptionDetail,
  ComponentDetail,
  MaterialLite,
  ProductDetail,
  SizeOptionDetail,
  UnlinkedSlot,
} from '@/lib/types/api';

/** Size key used by the API: a size id, or 'standard' for the standard size. */
export const STANDARD_KEY = 'standard';

export type OptionKind = 'SIZE' | 'COLOUR';

export function sizeKeyOf(sizeOptionId: string | null): string {
  return sizeOptionId ?? STANDARD_KEY;
}

export function standardSizeLabel(p: ProductDetail): string {
  return p.baseOptionLabel ?? 'Standard';
}

export function standardColourLabel(p: ProductDetail): string {
  return p.standardColourLabel ?? 'Standard';
}

/** Rule 10 order: sortOrder asc, name asc, id asc. */
function byOrder<T extends { sortOrder: number; name: string; id: string }>(a: T, b: T): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

export function orderedSizes(p: ProductDetail): SizeOptionDetail[] {
  return [...p.sizes].sort(byOrder);
}

export function orderedColours(p: ProductDetail): ColourOptionDetail[] {
  return [...p.colours].sort(byOrder);
}

export function sizeLabelOf(p: ProductDetail, key: string | null): string {
  if (key === null || key === STANDARD_KEY) return standardSizeLabel(p);
  return p.sizes.find(s => s.id === key)?.name ?? 'Unknown size';
}

/** Every component of the product, standard size first. */
export function allComponents(p: ProductDetail): ComponentDetail[] {
  return [...p.components, ...orderedSizes(p).flatMap(s => s.components)];
}

/** The server's multicolour test (stock-ledger `isMultiColourComponent`): slots come from `materials`. */
export function isMultiColour(c: Pick<ComponentDetail, 'isMultiColor' | 'materialId' | 'materials'>): boolean {
  return c.materials.length > 0 && (c.isMultiColor || !c.materialId);
}

/** "Lid" for a single-material part, "Lid colour 2" for slot 1 of a multicolour part. */
export function slotPartLabel(component: ComponentDetail | undefined, description: string, colorIndex: number): string {
  const multi = component ? isMultiColour(component) : colorIndex > 0;
  return multi ? `${description} colour ${colorIndex + 1}` : description;
}

export function unlinkedLabels(p: ProductDetail, slots: UnlinkedSlot[]): string[] {
  const comps = allComponents(p);
  return slots.map(s => slotPartLabel(comps.find(c => c.id === s.componentId), s.description, s.colorIndex));
}

export function totalUnlinked(p: ProductDetail): number {
  return p.unlinkedSlots.length + p.sizes.reduce((n, s) => n + s.unlinkedSlots.length, 0);
}

/** Distinct own filaments of every component (all sizes): what customers buy "as sliced" today. */
export function standardFilaments(p: ProductDetail): MaterialLite[] {
  const out = new Map<string, MaterialLite>();
  for (const c of allComponents(p)) {
    if (isMultiColour(c)) for (const m of c.materials) out.set(m.material.id, m.material);
    else if (c.material) out.set(c.material.id, c.material);
  }
  return [...out.values()];
}

/** Prefill for the standard colour's label, from the as-sliced filament colours ("Black"). */
export function suggestedColourLabel(p: ProductDetail): string {
  if (p.standardColourLabel) return p.standardColourLabel;
  const names = [...new Set(standardFilaments(p).map(m => (m.color ?? '').trim()).filter(Boolean))];
  return names.join(' / ').slice(0, 40);
}

/** "Large: 2 parts don't follow colours (Large Box, Large Lid colour 1)". */
export function unlinkedSentence(sizeLabel: string, labels: string[]): string {
  const n = labels.length;
  return `${sizeLabel}: ${n} ${n === 1 ? "part doesn't" : "parts don't"} follow colours (${labels.join(', ')})`;
}

// ---------------------------------------------------------------- costs

/** Cells of one size that count for ranges: standard colour + active colours, excluded pairs skipped. */
export function activeCellsOfSize(p: ProductDetail, cells: CellCost[], sizeOptionId: string | null): CellCost[] {
  const active = new Set(p.colours.filter(c => c.isActive).map(c => c.id));
  return cells.filter(c => c.sizeOptionId === sizeOptionId && !c.excluded
    && (c.colourOptionId === null || active.has(c.colourOptionId)));
}

export function marginRange(cells: CellCost[]): { min: number; max: number } | null {
  const m = cells.map(c => c.marginPct).filter((x): x is number => x !== null);
  return m.length ? { min: Math.min(...m), max: Math.max(...m) } : null;
}

/** The colour's worst cost delta vs the standard colour over its made, active sizes. */
export function worstDelta(p: ProductDetail, cells: CellCost[], colourId: string): { pct: number; sizeLabel: string } | null {
  const activeSizes = new Set<string | null>([null, ...p.sizes.filter(s => s.isActive).map(s => s.id)]);
  let worst: CellCost | null = null;
  for (const c of cells) {
    if (c.colourOptionId !== colourId || c.excluded || !activeSizes.has(c.sizeOptionId) || c.deltaVsStandardPct === null) continue;
    if (!worst || c.deltaVsStandardPct > (worst.deltaVsStandardPct as number)) worst = c;
  }
  return worst ? { pct: worst.deltaVsStandardPct as number, sizeLabel: worst.sizeLabel } : null;
}

export function formatDelta(pct: number): string {
  if (Math.abs(pct) < 0.05) return 'same';
  const sign = pct > 0 ? '+' : '−';
  const v = Math.abs(pct);
  return `${sign}${Number.isInteger(v) ? v : v.toFixed(1)} %`;
}

// ------------------------------------------------------ keep-selling step

/**
 * No ACTIVE option of this kind and its switch undecided (§3.1 rules 6 and 7).
 * Inactive options don't count: while every option of a kind is inactive the
 * shop sells the standard option (§3.10), so the next active one would hide it.
 */
function axisUndecided(p: ProductDetail, kind: OptionKind): boolean {
  const list: Array<{ isActive: boolean }> = kind === 'COLOUR' ? p.colours : p.sizes;
  const sellable = kind === 'COLOUR' ? p.standardColourSellable : p.baseOptionSellable;
  return sellable === null && !list.some(o => o.isActive);
}

/** O1: the `Keep selling …` step is required on the first active option of a kind while that axis is undecided. */
export function needsKeepStandardOnCreate(p: ProductDetail, kind: OptionKind): boolean {
  return axisUndecided(p, kind);
}

/** O2: the same step when activating an inactive option on an axis with no active option and an undecided switch. */
export function needsKeepStandardOnActivate(p: ProductDetail, kind: OptionKind, option: { isActive: boolean }): boolean {
  return !option.isActive && axisUndecided(p, kind);
}

/** Texts of the `Keep selling …` step of OptionDialog and the Activate confirm. */
export function keepStepText(p: ProductDetail, kind: OptionKind, sellInShop: boolean): { intro: string; placeholder: string; note?: string } {
  if (kind === 'COLOUR') {
    const filamentNames = standardFilaments(p).map(m => m.name).join(', ');
    return {
      intro: `Customers buy this today in ${filamentNames || 'the filaments it was sliced with'}. Keep selling that as a colour named:`,
      placeholder: 'e.g. Black',
      note: sellInShop ? undefined : 'Unticked: customers no longer see the as-sliced colour once colours exist. Staff can always order it.',
    };
  }
  return {
    intro: 'Customers buy this product today. Keep selling the current one as a size named:',
    placeholder: 'e.g. Regular',
    note: sellInShop ? undefined : 'Unticked: once sizes exist, customers only see the sizes you add. Staff can still order the current one.',
  };
}

/** Prefill of the step's name: the stored label, else the as-sliced colour names. */
export function keepStepLabel(p: ProductDetail, kind: OptionKind): string {
  return kind === 'COLOUR' ? suggestedColourLabel(p) : p.baseOptionLabel ?? '';
}

/** The step's name must be 1–40 characters; null when it is. */
export function keepStepProblem(kind: OptionKind, label: string): string | null {
  const l = label.trim();
  return l.length < 1 || l.length > 40
    ? `Enter a name (1 to 40 characters) for the ${kind === 'SIZE' ? 'current size' : 'as-sliced colour'}`
    : null;
}

export interface KindChange {
  variantId: string;
  kind: OptionKind;
}

export interface KeepStandardDefaults {
  colour: { required: boolean; sellInShop: boolean; boughtAsColours: string[] };
  size: { required: boolean; sellInShop: boolean };
}

/**
 * O7 `keepStandard` requirement and the §3.1 rule 7 default tick, from
 * ProductDetail only (spec §5.2 C "Kind classification").
 */
export function keepStandardDefault(p: ProductDetail, changes: KindChange[]): KeepStandardDefaults {
  const target = new Map(changes.map(c => [c.variantId, c.kind]));
  const options = [
    ...p.sizes.map(s => ({ id: s.id, name: s.name, isActive: s.isActive, kind: 'SIZE' as OptionKind, customerBought: s.isActive && (s.basePrice ?? 0) > 0 })),
    ...p.colours.map(c => ({ id: c.id, name: c.name, isActive: c.isActive, kind: 'COLOUR' as OptionKind, customerBought: false })),
  ];
  const after = (o: { id: string; kind: OptionKind }) => target.get(o.id) ?? o.kind;
  const activeBefore = (k: OptionKind) => options.some(o => o.isActive && o.kind === k);
  const activeAfter = (k: OptionKind) => options.some(o => o.isActive && after(o) === k);

  const customerSizes = options.filter(o => o.kind === 'SIZE' && o.customerBought && p.isActive);
  const stillSold = p.baseSellableToCustomers || customerSizes.some(o => after(o) === 'SIZE');
  return {
    colour: {
      required: !activeBefore('COLOUR') && activeAfter('COLOUR') && p.standardColourSellable === null,
      sellInShop: stillSold,
      boughtAsColours: customerSizes.filter(o => after(o) === 'COLOUR').map(o => o.name),
    },
    size: {
      required: !activeBefore('SIZE') && activeAfter('SIZE') && p.baseOptionSellable === null,
      sellInShop: true,
    },
  };
}

/** New order of one kind after moving `id` up (-1) or down (+1); null when it can't move. */
export function reorder<T extends { id: string }>(list: T[], id: string, dir: -1 | 1): T[] | null {
  const i = list.findIndex(o => o.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return null;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** Text of the §3.10 confirm when the last active option of an axis is deactivated. */
export function lastOfAxisText(p: ProductDetail, kind: OptionKind): string {
  if (kind === 'COLOUR') return `No colours left — the shop will sell the standard colour (${standardColourLabel(p)}).`;
  const base = `No sizes left — the standard size (${standardSizeLabel(p)}) will be sold.`;
  return p.components.length === 0
    ? `${base} It has no components of its own, so it can't be produced — add components or deactivate the product.`
    : base;
}

export function isLastActive(p: ProductDetail, kind: OptionKind, id: string): boolean {
  const list: Array<{ id: string; isActive: boolean }> = kind === 'SIZE' ? p.sizes : p.colours;
  const active = list.filter(o => o.isActive);
  return active.length === 1 && active[0].id === id;
}
