'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ProductDetail } from '@/lib/types/api';
import { STANDARD_KEY } from './options-model';

/** DOM id of section D; WP9's ComponentsCard renders its wrapper with this id. */
export const BOM_SECTION_ID = 'bill-of-materials';

/**
 * Which size the bill of materials (section D) shows: `'standard'` or a size
 * option id (spec §5.2 C `Configure`, §6 WP9b declared overlap). Page-level
 * state: the Sizes table's `Configure` sets it; WP9's ComponentsCard is
 * controlled by `bomScope` / `setBomScope`.
 */
export interface BomScope {
  /** `'standard'` or a SIZE option id. */
  bomScope: string;
  setBomScope: (sizeKey: string) => void;
  /** Sets the scope, then scrolls to `#bill-of-materials` (a no-op scroll until section D exists). */
  onConfigureSize: (sizeKey: string) => void;
}

export function useBomScope(product: ProductDetail | null): BomScope {
  const [bomScope, setBomScope] = useState<string>(STANDARD_KEY);

  // A size that was deleted (or reclassified as a colour) falls back to the standard size.
  useEffect(() => {
    if (!product || bomScope === STANDARD_KEY) return;
    if (!product.sizes.some(s => s.id === bomScope)) setBomScope(STANDARD_KEY);
  }, [product, bomScope]);

  const onConfigureSize = useCallback((sizeKey: string) => {
    setBomScope(sizeKey);
    // After the re-render, so section D already shows the chosen size.
    window.setTimeout(() => {
      document.getElementById(BOM_SECTION_ID)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  }, []);

  return { bomScope, setBomScope, onConfigureSize };
}
