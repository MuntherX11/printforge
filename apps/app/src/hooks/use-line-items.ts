'use client';

/**
 * Order and quote lines for the New Order / New Quote forms (spec §5.3,
 * §3.9). The server prices product lines itself: every product, size, colour
 * or quantity change re-prices the whole document through S1
 * (`POST /pricing/lines`, debounced 300 ms) so tiers count across the lines
 * of one product and size. A typed price becomes an override (sent with
 * `priceOverride: true`); lines without one take the automatic price.
 * State objects are never mutated.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { ApiActiveProduct, PricingLineInput, PricingLinePreview } from '@/lib/types/api';
import {
  STANDARD, changeSize, coloursForSize, defaultPair, keyToId, pickerOptionsFromActive, type PickerOptions,
} from '@/components/products/OptionPickers';

export interface LineItem {
  key: string;
  /** '' = custom line (no product). */
  productId: string;
  /** null = the standard size / colour. */
  sizeOptionId: string | null;
  colourOptionId: string | null;
  /** §3.1 rule 10 note after a size change (`Gold isn't made in Large`). */
  note: string | null;
  description: string;
  descriptionTouched: boolean;
  /** 0 = not typed yet. */
  quantity: number;
  unitPrice: number;
  priceOverride: boolean;
  overrideReason: string;
  pricing: PricingLinePreview | null;
}

/** Submit shape of one line (S2/S6). */
export interface LinePayload {
  productId?: string;
  sizeOptionId?: string | null;
  colourOptionId?: string | null;
  description: string;
  quantity: number;
  unitPrice?: number;
  priceOverride: boolean;
  overrideReason?: string;
}

const keyOf = (id: string | null) => id ?? STANDARD;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function blankLine(): LineItem {
  return {
    key: newKey(), productId: '', sizeOptionId: null, colourOptionId: null, note: null,
    description: '', descriptionTouched: false, quantity: 1, unitPrice: 0,
    priceOverride: false, overrideReason: '', pricing: null,
  };
}

/** §3.1 rule 11: `Sardine tin — Large — Red`; standard axes are omitted. */
export function autoDescription(p: ApiActiveProduct | undefined, sizeOptionId: string | null, colourOptionId: string | null): string {
  if (!p) return '';
  const size = sizeOptionId ? p.sizes.find(s => s.id === sizeOptionId) : null;
  const colour = colourOptionId ? p.colours.find(c => c.id === colourOptionId) : null;
  return `${p.name}${size ? ` — ${size.name}` : ''}${colour ? ` — ${colour.name}` : ''}`;
}

export function useLineItems(products: ApiActiveProduct[]) {
  const [items, setItems] = useState<LineItem[]>(() => [blankLine()]);

  const byId = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);
  const optionsById = useMemo(() => new Map(products.map(p => [p.id, pickerOptionsFromActive(p)])), [products]);
  const pickerOptions = useCallback((productId: string): PickerOptions | null => optionsById.get(productId) ?? null, [optionsById]);

  /** Re-derive the description unless staff typed their own. */
  const withDescription = useCallback((l: LineItem): LineItem => (
    l.descriptionTouched || !l.productId ? l : { ...l, description: autoDescription(byId.get(l.productId), l.sizeOptionId, l.colourOptionId) }
  ), [byId]);

  const patch = useCallback((index: number, fn: (l: LineItem) => LineItem) => {
    setItems(prev => prev.map((l, i) => (i === index ? fn(l) : l)));
  }, []);

  const addItem = useCallback(() => setItems(prev => [...prev, blankLine()]), []);
  const removeItem = useCallback((index: number) => setItems(prev => prev.filter((_, i) => i !== index)), []);

  function handleProductSelect(index: number, productId: string) {
    const opts = optionsById.get(productId);
    patch(index, l => {
      if (!opts) return { ...l, productId: '', sizeOptionId: null, colourOptionId: null, note: null, priceOverride: false, pricing: null };
      const pair = defaultPair(opts);
      return withDescription({
        ...l, productId, sizeOptionId: keyToId(pair.sizeKey), colourOptionId: keyToId(pair.colourKey), note: null,
        descriptionTouched: false, unitPrice: byId.get(productId)?.basePrice ?? 0, priceOverride: false, overrideReason: '', pricing: null,
      });
    });
  }

  function setSize(index: number, sizeKey: string) {
    patch(index, l => {
      const opts = optionsById.get(l.productId);
      if (!opts) return l;
      const r = changeSize(opts, { sizeKey: keyOf(l.sizeOptionId), colourKey: keyOf(l.colourOptionId) }, sizeKey);
      return withDescription({ ...l, sizeOptionId: keyToId(r.pair.sizeKey), colourOptionId: keyToId(r.pair.colourKey), note: r.note });
    });
  }

  function setColour(index: number, colourKey: string) {
    patch(index, l => withDescription({ ...l, colourOptionId: keyToId(colourKey), note: null }));
  }

  function setDescription(index: number, description: string) {
    patch(index, l => ({ ...l, description, descriptionTouched: true }));
  }

  function setQuantity(index: number, quantity: number) {
    patch(index, l => ({ ...l, quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 0 }));
  }

  /** Typing a price overrides it; typing the automatic price back clears the override. */
  function setUnitPrice(index: number, unitPrice: number) {
    patch(index, l => {
      if (!l.productId) return { ...l, unitPrice };
      const auto = l.pricing?.autoUnitPrice ?? null;
      const override = auto === null || Math.abs(round3(unitPrice) - auto) > 1e-9;
      return { ...l, unitPrice, priceOverride: override, overrideReason: override ? l.overrideReason : '' };
    });
  }

  function setOverrideReason(index: number, overrideReason: string) {
    patch(index, l => ({ ...l, overrideReason }));
  }

  function resetPrice(index: number) {
    patch(index, l => ({ ...l, priceOverride: false, overrideReason: '', unitPrice: l.pricing?.autoUnitPrice ?? l.unitPrice }));
  }

  /**
   * `+ colour`: a line right after `index` with the same product and size and
   * the first colour offered on that size that no line of this product and
   * size uses yet (else the first). Returns the new line's key.
   */
  function addColourLine(index: number): string | null {
    const src = items[index];
    const opts = src ? optionsById.get(src.productId) : null;
    if (!src || !opts) return null;
    const sizeKey = keyOf(src.sizeOptionId);
    const offered = coloursForSize(opts, sizeKey);
    const used = new Set(items.filter(l => l.productId === src.productId && keyOf(l.sizeOptionId) === sizeKey).map(l => keyOf(l.colourOptionId)));
    const colourKey = (offered.find(c => !used.has(c.key)) ?? offered[0])?.key ?? STANDARD;
    const line = withDescription({
      ...blankLine(), productId: src.productId, sizeOptionId: src.sizeOptionId, colourOptionId: keyToId(colourKey),
      quantity: 0, unitPrice: src.pricing?.autoUnitPrice ?? src.unitPrice,
    });
    setItems(prev => {
      const at = prev.findIndex(l => l.key === src.key);
      return at < 0 ? [...prev, line] : [...prev.slice(0, at + 1), line, ...prev.slice(at + 1)];
    });
    return line.key;
  }

  // ------------------------------------------------------------ S1 pricing

  const priceKey = JSON.stringify(items.map(l => [l.key, l.productId, l.sizeOptionId, l.colourOptionId, l.quantity, l.priceOverride ? l.unitPrice : null]));
  const seq = useRef(0);
  useEffect(() => {
    const priced = items.filter(l => l.productId && l.quantity > 0);
    if (!priced.length) return;
    const my = ++seq.current;
    const t = setTimeout(() => {
      const lines: PricingLineInput[] = priced.map(l => ({
        productId: l.productId, sizeOptionId: l.sizeOptionId, colourOptionId: l.colourOptionId, quantity: l.quantity,
        ...(l.priceOverride ? { unitPrice: l.unitPrice, priceOverride: true } : {}),
      }));
      api.post<{ lines: PricingLinePreview[] }>('/pricing/lines', { lines })
        .then(res => {
          if (my !== seq.current) return;
          const byKey = new Map(priced.map((l, i) => [l.key, res.lines[i]]));
          setItems(prev => prev.map(l => {
            const p = byKey.get(l.key);
            if (!p) return l;
            const unitPrice = !l.priceOverride && p.autoUnitPrice !== null ? p.autoUnitPrice : l.unitPrice;
            return { ...l, pricing: p, unitPrice };
          }));
        })
        .catch(() => { /* the hint stays as it was; the server prices again on save */ });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceKey]);

  // --------------------------------------------------------------- submit

  function payload(l: LineItem): LinePayload {
    if (!l.productId) return { description: l.description.trim(), quantity: l.quantity, unitPrice: l.unitPrice, priceOverride: false };
    return {
      productId: l.productId,
      sizeOptionId: l.sizeOptionId,
      colourOptionId: l.colourOptionId,
      description: l.description.trim(),
      quantity: l.quantity,
      priceOverride: l.priceOverride,
      ...(l.priceOverride ? { unitPrice: l.unitPrice, overrideReason: l.overrideReason.trim() || undefined } : {}),
    };
  }

  const subtotal = round3(items.reduce((sum, l) => sum + round3(l.quantity * l.unitPrice), 0));

  return {
    items, addItem, removeItem, handleProductSelect, setSize, setColour, setDescription, setQuantity,
    setUnitPrice, setOverrideReason, resetPrice, addColourLine, pickerOptions, payload, subtotal,
  };
}
