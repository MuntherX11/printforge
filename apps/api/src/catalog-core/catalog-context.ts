import type { CostSettings } from '../costing/costing.service';
import type { ProductConfig } from './catalog-config';
import type { PairRow, VariantLite } from './option-pair';
import { PlanCache } from './plate-planner';

/**
 * Per-request memo (spec §3.7 "Resolver results are memoised per request",
 * §3.8 "loads once per product per request", §3.5 plan tables). Create one at
 * the start of a request or transaction and pass it down; never share it
 * between requests, because it holds configuration that may change.
 */
export class CatalogRequestContext {
  readonly configs = new Map<string, Promise<ProductConfig | null>>();
  /** resolved BOMs by `${productId}|${size ?? ''}|${colour ?? ''}` */
  readonly boms = new Map<string, unknown>();
  readonly planCache = new PlanCache();
  /** option rows by id, across products (legacy lines may point anywhere) */
  readonly variants = new Map<string, VariantLite | null>();
  readonly orderItems = new Map<string, PairRow | null>();
  settings?: Promise<CostSettings>;
}

export const pairKey = (productId: string, sizeOptionId: string | null, colourOptionId: string | null) =>
  `${productId}|${sizeOptionId ?? ''}|${colourOptionId ?? ''}`;
