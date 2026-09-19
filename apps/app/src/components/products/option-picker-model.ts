/**
 * Pure model behind the shared size and colour pickers (spec §5.3, §3.1 rules
 * 8, 10 and 11). No React. Two adapters build the same `PickerOptions` from
 * either source the app has: `ProductDetail` (product page) and the P2
 * `/products/active` row (order, quote and job forms, WP10).
 *
 * Keys are the API's size keys: a size or colour id, or `'standard'`.
 */
import type { ApiActiveProduct, ProductDetail } from '@/lib/types/api';

export const STANDARD = 'standard';

export interface PickerSize {
  key: string;
  /** Option text: `Large — TIN-L`, or the standard size's label. */
  label: string;
  /** Rule 8 customer offer (drives the staff default, rule 10). */
  customerSellable: boolean;
}

export interface PickerColour {
  key: string;
  /** Plain option text, e.g. `Red (PLA Red, PLA Gold)` or `Green (not set up)`. */
  label: string;
  /** Standard colour only, while its filaments differ per size: `As sliced (PLA Grey)`. */
  labelBySize?: Record<string, string>;
  /** Sizes this colour is offered on for staff (not excluded). */
  sizeKeys: string[];
  /** Sizes this colour is offered on to customers. */
  customerSizeKeys: string[];
  /** "Made in" unticked sizes (for the `isn't made in` note). */
  excludedSizeKeys: string[];
}

export interface PickerOptions {
  productId: string;
  /** The product has active sizes: SizeSelect renders. */
  hasSizes: boolean;
  /** The product has active colours: ColourSelect renders. */
  hasColours: boolean;
  /** Staff size list: the standard size (when staff-sellable) first, then active sizes. Empty without sizes. */
  sizes: PickerSize[];
  /** Standard colour first, then active colours. Empty without colours. */
  colours: PickerColour[];
}

export interface PairKeys {
  sizeKey: string;
  colourKey: string;
}

export function keyToId(key: string): string | null {
  return key === STANDARD ? null : key;
}

export function pairIds(pair: PairKeys): { sizeOptionId: string | null; colourOptionId: string | null } {
  return { sizeOptionId: keyToId(pair.sizeKey), colourOptionId: keyToId(pair.colourKey) };
}

function byOrder<T extends { sortOrder: number; name: string; id: string }>(a: T, b: T): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

const sizeText = (name: string, sku: string | null) => `${name}${sku ? ` — ${sku}` : ''}`;
const withNames = (label: string, names: string[]) => (names.length ? `${label} (${names.join(', ')})` : label);

/** The colours offered to staff on a size (rule 8): the standard colour, then colours not excluded there. */
export function coloursForSize(opts: PickerOptions, sizeKey: string): PickerColour[] {
  return opts.colours.filter(c => c.key === STANDARD || c.sizeKeys.includes(sizeKey));
}

export function colourText(c: PickerColour, sizeKey: string): string {
  return c.labelBySize?.[sizeKey] ?? c.label;
}

function defaultColour(opts: PickerOptions, sizeKey: string): string {
  const list = coloursForSize(opts, sizeKey);
  return (list.find(c => c.customerSizeKeys.includes(sizeKey)) ?? list[0])?.key ?? STANDARD;
}

/** Rule 10 staff defaults: the first customer-sellable size, then the first customer-offered colour on it. */
export function defaultPair(opts: PickerOptions): PairKeys {
  const size = (opts.sizes.find(s => s.customerSellable) ?? opts.sizes[0])?.key ?? STANDARD;
  return { sizeKey: size, colourKey: defaultColour(opts, size) };
}

/**
 * Rule 10 size change: the colour is kept when it is offered on the new size;
 * otherwise it moves to the first offered colour, with a note.
 */
export function changeSize(opts: PickerOptions, pair: PairKeys, sizeKey: string): { pair: PairKeys; note: string | null } {
  const offered = coloursForSize(opts, sizeKey);
  if (offered.some(c => c.key === pair.colourKey)) return { pair: { sizeKey, colourKey: pair.colourKey }, note: null };
  const colour = opts.colours.find(c => c.key === pair.colourKey);
  const size = opts.sizes.find(s => s.key === sizeKey);
  const next = { sizeKey, colourKey: defaultColour(opts, sizeKey) };
  if (!colour || !size) return { pair: next, note: null };
  const name = colour.label.replace(/ \(.*\)$/, '');
  const sizeName = size.label.replace(/ — .*$/, '');
  const note = colour.excludedSizeKeys.includes(sizeKey)
    ? `${name} isn't made in ${sizeName}`
    : `${name} isn't available in ${sizeName} yet`;
  return { pair: next, note };
}

/** Is the pair still valid for these options (after a product reload)? */
export function pairValid(opts: PickerOptions, pair: PairKeys): boolean {
  const sizeOk = opts.hasSizes ? opts.sizes.some(s => s.key === pair.sizeKey) : pair.sizeKey === STANDARD;
  const colourOk = opts.hasColours ? coloursForSize(opts, pair.sizeKey).some(c => c.key === pair.colourKey) : pair.colourKey === STANDARD;
  return sizeOk && colourOk;
}

// ------------------------------------------------------------- adapters

/** From ProductDetail (the product page). */
export function pickerOptionsFromDetail(p: ProductDetail): PickerOptions {
  const activeSizes = p.sizes.filter(s => s.isActive).sort(byOrder);
  const hasSizes = activeSizes.length > 0;
  const standardSize: PickerSize = {
    key: STANDARD, label: p.baseOptionLabel ?? 'Standard', customerSellable: p.baseSellableToCustomers,
  };
  const sizes: PickerSize[] = hasSizes
    ? [
        ...(p.baseSellable ? [standardSize] : []),
        ...activeSizes.map(s => ({ key: s.id, label: sizeText(s.name, s.sku), customerSellable: p.isActive && (s.basePrice ?? 0) > 0 })),
      ]
    : [];
  const staffKeys = hasSizes ? sizes.map(s => s.key) : [STANDARD];
  const customerKeys = hasSizes ? sizes.filter(s => s.customerSellable).map(s => s.key) : [STANDARD];

  const activeColours = p.colours.filter(c => c.isActive).sort(byOrder);
  const hasColours = activeColours.length > 0;
  if (!hasColours) return { productId: p.id, hasSizes, hasColours, sizes, colours: [] };

  const standardNames = [...new Set(p.colourSlots.flatMap(s => s.standardMaterials.map(m => m.name)))];
  const componentsOf = (key: string) => {
    const own = key === STANDARD ? p.components : p.sizes.find(s => s.id === key)?.components ?? [];
    return own.length ? own : p.components;
  };
  const labelBySize = p.standardColourMixed
    ? Object.fromEntries(staffKeys.map(key => {
        const names = new Set<string>();
        for (const c of componentsOf(key)) {
          if (c.materials.length) { for (const m of c.materials) if (m.colourSlotId) names.add(m.material.name); }
          else if (c.colourSlotId && c.material) names.add(c.material.name);
        }
        return [key, `As sliced (${[...names].join(', ')})`];
      }))
    : undefined;

  const colours: PickerColour[] = [
    {
      key: STANDARD,
      label: withNames(p.standardColourLabel ?? 'Standard', standardNames),
      labelBySize,
      sizeKeys: staffKeys,
      customerSizeKeys: p.standardColourSellableToCustomers ? customerKeys : [],
      excludedSizeKeys: [],
    },
    ...activeColours.map(c => ({
      key: c.id,
      label: c.assignments.length ? withNames(c.name, [...new Set(c.assignments.map(a => a.material.name))]) : `${c.name} (not set up)`,
      sizeKeys: staffKeys.filter(k => !c.excludedSizeKeys.includes(k)),
      customerSizeKeys: c.customerSizeKeys,
      excludedSizeKeys: c.excludedSizeKeys,
    })),
  ];
  return { productId: p.id, hasSizes, hasColours, sizes, colours };
}

/**
 * From a P2 `/products/active` row (WP10 forms). P2 does not say whether the
 * standard colour is offered to customers, so the staff default colour is the
 * first real colour offered to customers on the size (the standard colour
 * stays in the list).
 */
export function pickerOptionsFromActive(p: ApiActiveProduct): PickerOptions {
  const activeSizes = [...p.sizes].sort(byOrder);
  const hasSizes = activeSizes.length > 0;
  const sizes: PickerSize[] = hasSizes
    ? [
        ...(p.baseSellable ? [{ key: STANDARD, label: p.baseOptionLabel ?? 'Standard', customerSellable: p.baseSellableToCustomers }] : []),
        ...activeSizes.map(s => ({ key: s.id, label: sizeText(s.name, s.sku), customerSellable: s.sellableToCustomers })),
      ]
    : [];
  const staffKeys = hasSizes ? sizes.map(s => s.key) : [STANDARD];
  const hasColours = p.colours.length > 0;
  if (!hasColours) return { productId: p.id, hasSizes, hasColours, sizes, colours: [] };
  const colours: PickerColour[] = [
    {
      key: STANDARD,
      label: p.standardColourLabel ?? 'Standard',
      labelBySize: p.standardColourLabelBySize ?? undefined,
      sizeKeys: staffKeys,
      customerSizeKeys: [],
      excludedSizeKeys: [],
    },
    ...[...p.colours].sort(byOrder).map(c => ({
      key: c.id,
      label: c.notSetUp ? `${c.name} (not set up)` : withNames(c.name, c.filamentNames),
      sizeKeys: c.sizeKeys,
      customerSizeKeys: c.customerSizeKeys,
      excludedSizeKeys: staffKeys.filter(k => !c.sizeKeys.includes(k)),
    })),
  ];
  return { productId: p.id, hasSizes, hasColours, sizes, colours };
}
