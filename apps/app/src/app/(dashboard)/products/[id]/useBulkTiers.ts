'use client';

import { useEffect, useMemo, useState } from 'react';
import type { PriceTierRow, ProductDetail } from '@/lib/types/api';
import { STANDARD_KEY } from './options-model';
import { checkTiers, draftsOf, sameTiers, tiersBody, type TierDraft } from './bulk-pricing-model';

export interface BulkTiersState {
  /** 'standard' or a size id: the size whose tiers are being edited. */
  sizeKey: string;
  setSizeKey: (key: string) => void;
  /** The tiers as typed, saved or not. */
  rows: TierDraft[];
  setRows: (next: TierDraft[] | ((rows: TierDraft[]) => TierDraft[])) => void;
  /** The size's tiers as the server has them. */
  saved: PriceTierRow[];
  /** The typed tiers differ from the saved ones (or cannot be saved as typed). */
  dirty: boolean;
}

/**
 * The bulk pricing drafts. Held by the page rather than by the Bulk pricing
 * section, so tiers that were typed but not saved survive leaving the Pricing
 * tab, folding the row or switching layout. They start again from the saved
 * tiers when another size is chosen or when the saved tiers change (a save).
 */
export function useBulkTiers(product: ProductDetail): BulkTiersState {
  const [sizeKey, setSizeKey] = useState(STANDARD_KEY);
  const saved: PriceTierRow[] = useMemo(
    () => (sizeKey === STANDARD_KEY ? product.priceTiers : product.sizes.find(s => s.id === sizeKey)?.priceTiers ?? []),
    [product, sizeKey],
  );
  const savedKey = JSON.stringify(saved.map(t => [t.minQty, t.unitPrice]));
  const [rows, setRows] = useState<TierDraft[]>(() => draftsOf(saved));

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setRows(draftsOf(saved)); }, [sizeKey, savedKey]);
  useEffect(() => { if (!product.sizes.some(s => s.id === sizeKey)) setSizeKey(STANDARD_KEY); }, [product.sizes, sizeKey]);

  const dirty = useMemo(() => {
    // The list price only adds warnings; it never decides what can be saved.
    const body = tiersBody(checkTiers(rows, null, String));
    return !body || !sameTiers(body, saved);
  }, [rows, saved]);

  return { sizeKey, setSizeKey, rows, setRows, saved, dirty };
}
