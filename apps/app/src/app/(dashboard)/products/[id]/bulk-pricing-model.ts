/**
 * Pure helpers for section H (bulk pricing, spec §5.2 H, §3.9). Tiers belong
 * to a size; margins only warn, they never block saving.
 */
import type { BulkFloor, PriceTierRow } from '@/lib/types/api';

export interface TierDraft {
  /** Stable React key. */
  key: number;
  minQty: string;
  unitPrice: string;
}

export interface TierCheck {
  minQty: number | null;
  unitPrice: number | null;
  errors: { minQty?: string; unitPrice?: string };
  warnings: string[];
}

let nextKey = 1;
export const newDraft = (minQty = '', unitPrice = ''): TierDraft => ({ key: nextKey++, minQty, unitPrice });

export function draftsOf(tiers: PriceTierRow[]): TierDraft[] {
  return [...tiers].sort((a, b) => a.minQty - b.minQty).map(t => newDraft(String(t.minQty), t.unitPrice.toFixed(3)));
}

function qtyOf(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n >= 2 && n <= 1_000_000 ? n : null;
}

function priceOf(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0.001 && n <= 1_000_000 ? Math.round(n * 1000) / 1000 : null;
}

/** Inline errors (block saving) and warnings (never block) per row. */
export function checkTiers(rows: TierDraft[], listPrice: number | null, fmt: (n: number) => string): TierCheck[] {
  const parsed = rows.map(r => ({ minQty: qtyOf(r.minQty), unitPrice: priceOf(r.unitPrice) }));
  const counts = new Map<number, number>();
  for (const p of parsed) if (p.minQty !== null) counts.set(p.minQty, (counts.get(p.minQty) ?? 0) + 1);
  return parsed.map(p => {
    const errors: TierCheck['errors'] = {};
    if (p.minQty === null) errors.minQty = 'Whole number of 2 or more';
    else if ((counts.get(p.minQty) ?? 0) > 1) errors.minQty = 'Duplicate quantity';
    if (p.unitPrice === null) errors.unitPrice = 'Enter a price above 0';
    const warnings: string[] = [];
    if (p.unitPrice !== null && listPrice !== null && p.unitPrice >= listPrice) warnings.push(`Not a discount — list price is ${fmt(listPrice)}`);
    if (p.unitPrice !== null && p.minQty !== null) {
      const lower = parsed
        .filter(o => o.minQty !== null && o.unitPrice !== null && (o.minQty as number) < (p.minQty as number))
        .sort((a, b) => (b.minQty as number) - (a.minQty as number))[0];
      if (lower && p.unitPrice >= (lower.unitPrice as number)) warnings.push(`Not lower than the ${lower.minQty}+ price`);
    }
    return { ...p, errors, warnings };
  });
}

/** Rows sorted by min qty (invalid ones last, in their order). */
export function sortDrafts(rows: TierDraft[]): TierDraft[] {
  const q = (r: TierDraft) => qtyOf(r.minQty) ?? Number.POSITIVE_INFINITY;
  return [...rows].sort((a, b) => q(a) - q(b));
}

/** The P19 body tiers, or null while any row is invalid. */
export function tiersBody(checks: TierCheck[]): Array<{ minQty: number; unitPrice: number }> | null {
  if (checks.some(c => c.errors.minQty || c.errors.unitPrice)) return null;
  return checks.map(c => ({ minQty: c.minQty as number, unitPrice: c.unitPrice as number })).sort((a, b) => a.minQty - b.minQty);
}

export function sameTiers(a: Array<{ minQty: number; unitPrice: number }>, b: PriceTierRow[]): boolean {
  const sb = [...b].sort((x, y) => x.minQty - y.minQty);
  return a.length === sb.length && a.every((t, i) => t.minQty === sb[i].minQty && Math.abs(t.unitPrice - sb[i].unitPrice) < 0.0005);
}

/**
 * `Plates: Box ×12 × 2, Box single × 1 · Fish: single units · time and filament
 * counted for the units sold only` (layoutsUsed labels come from the server).
 */
export function basisLine(band: BulkFloor['bands'][number]): string {
  const isSingle = (l: string) => / single × \d+$/.test(l);
  const plated = band.basis.filter(b => b.layoutsUsed.some(l => !isSingle(l)));
  const singles = band.basis.filter(b => !plated.includes(b));
  const parts: string[] = [];
  if (plated.length) parts.push(`Plates: ${plated.flatMap(b => b.layoutsUsed).join(', ')}`);
  if (singles.length) parts.push(`${singles.map(b => b.description).join(', ')}: single units`);
  parts.push('time and filament counted for the units sold only');
  return parts.join(' · ');
}

export type MarginTone = 'below' | 'thin' | 'ok';

export function marginTone(pct: number, thinPct: number): MarginTone {
  if (pct < 0) return 'below';
  return pct < thinPct ? 'thin' : 'ok';
}
