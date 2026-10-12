'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { ProductDetail, Readiness } from '@/lib/types/api';
import { pickerOptionsFromDetail, useOptionPair, type OptionPairState, type PickerOptions } from '@/components/products/OptionPickers';
import { errorText } from './options-ui';
import { parseWhole } from './bom-model';

export const MAX_READINESS_QTY = 100_000;

export interface ReadinessState {
  options: PickerOptions;
  pair: OptionPairState;
  qtyText: string;
  setQtyText: (text: string) => void;
  /** null while the quantity typed is not a whole number from 1 to 100,000. */
  qty: number | null;
  /** The last answer (kept while a newer one loads). */
  data: Readiness | null;
  error: string | null;
  loading: boolean;
}

/**
 * "Can we make N of this pair from what is on the shelf?" (P20). Held by the
 * page rather than by the Make it section, so the quantity survives a tab
 * change and a folded Make it row can still show its verdict.
 */
export function useReadiness(product: ProductDetail, costVersion: string | null): ReadinessState {
  const options = useMemo(() => pickerOptionsFromDetail(product), [product]);
  const pair = useOptionPair(options);
  const [qtyText, setQtyText] = useState('1');
  const [state, setState] = useState<{ data: Readiness | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const qty = parseWhole(qtyText, 1, MAX_READINESS_QTY);
  const productId = product.id;

  useEffect(() => {
    if (qty === null) return;
    let live = true;
    setState(s => ({ ...s, loading: true }));
    const t = window.setTimeout(() => {
      const q = new URLSearchParams({ sizeOptionId: pair.sizeKey, colourOptionId: pair.colourKey, qty: String(qty) });
      api.get<Readiness>(`/products/${productId}/readiness?${q}`)
        .then(data => { if (live) setState({ data, error: null, loading: false }); })
        .catch(err => { if (live) setState({ data: null, error: errorText(err, 'Couldn\'t check readiness'), loading: false }); });
    }, 300);
    return () => { live = false; window.clearTimeout(t); };
  }, [productId, pair.sizeKey, pair.colourKey, qty, costVersion]);

  return { options, pair, qtyText, setQtyText, qty, data: state.data, error: state.error, loading: state.loading };
}
