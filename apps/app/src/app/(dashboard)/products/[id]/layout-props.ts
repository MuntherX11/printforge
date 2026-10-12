'use client';

import { useEffect, useState } from 'react';
import type { ApiPrinter, ProductDetail } from '@/lib/types/api';
import type { BomScope } from './useBomScope';
import type { NewJobPrefill } from './NewJobDialog';
import type { HeaderFacts } from './product-layout';
import { needsPrinterNames } from './product-layout';
import type { ProductPageData } from './useProduct';
import type { ReadinessState } from './useReadiness';
import type { BulkTiersState } from './useBulkTiers';
import type { PartSlices } from './usePartSlices';

/**
 * What both layouts of the product page (ProductTabsLayout, ProductFoldedLayout)
 * are given. The page owns everything that must outlive a tab change or a
 * folded row: the BOM scope, the readiness check, "Show costs per plate", the
 * slicing state of the parts and the bulk pricing drafts.
 */
export interface ProductLayoutProps {
  data: ProductPageData;
  product: ProductDetail;
  scope: BomScope;
  readiness: ReadinessState;
  facts: HeaderFacts;
  /** Printer id → name; null until loaded (or when no part needs it). */
  printers: ReadonlyMap<string, string> | null;
  /** Names the printer of a part's plate, for the Make it plan line. */
  printerOf: (componentId: string, layoutId: string | null) => string | null;
  showPlateCosts: boolean;
  onShowPlateCosts: (show: boolean) => void;
  onCreateJob: (prefill: NewJobPrefill) => void;
  /** Slicing state per part, from the page's one `slice-run` subscription. */
  slices: PartSlices;
  /** The bulk pricing drafts (unsaved tiers survive a tab change or a folded row). */
  bulk: BulkTiersState;
  /** A pricing warning is showing above the layout: Pricing is marked "needs attention". */
  pricingAttention: boolean;
}

/** Printer names for SLICED plates and 3MF sources; loaded once a part needs them. */
export function usePrinterNames(product: ProductDetail, loadPrinters: () => Promise<ApiPrinter[]>): ReadonlyMap<string, string> | null {
  const [names, setNames] = useState<Map<string, string> | null>(null);
  const needed = needsPrinterNames(product);
  useEffect(() => {
    if (!needed || names) return;
    loadPrinters()
      .then(list => setNames(new Map(list.map(p => [p.id, p.name] as const))))
      .catch(() => undefined);
  }, [needed, names, loadPrinters]);
  return names;
}
