import type { StockStatus } from '@printforge/types';

/**
 * Stock status of a filament from its active-spool grams.
 *
 * Invariant: `stockStatus(g, rp) !== 'ok'` exactly when `g < rp` — the same
 * rule as the dashboard Low Stock KPI (accounting/reports.service.ts) and the
 * hourly LOW_STOCK worker (worker/low-stock.processor.ts), so the Filaments
 * list's Low stock count equals the dashboard number. A reorder point of 0
 * is never flagged.
 */
export function stockStatus(totalGrams: number, reorderPoint: number): StockStatus {
  return totalGrams < reorderPoint ? (totalGrams <= 0 ? 'out' : 'low') : 'ok';
}
