/**
 * Number formatting for the product page (spec §5.1). Every figure the page
 * shows goes through one of these so units and precision are consistent.
 * Money is formatted by the locale's currency formatter (`useFormatCurrency`),
 * not here.
 */
import type { SurplusPolicy } from '@/lib/types/api';

/** <10 → 1 dp ("9.4 g"); <1000 → integer ("112 g"); else thousands separator ("1,240 g"). */
export function formatGrams(g: number): string {
  if (!Number.isFinite(g)) return '—';
  const abs = Math.abs(g);
  if (abs < 10) return `${g.toFixed(1)} g`;
  if (abs < 1000) return `${Math.round(g)} g`;
  return `${Math.round(g).toLocaleString('en-US')} g`;
}

/** <60 → "34 min"; else "4 h 3 min" (or "4 h" on the hour). */
export function formatMinutes(m: number): string {
  if (!Number.isFinite(m)) return '—';
  const total = Math.round(m);
  if (total === 0 && m > 0) return '<1 min';
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

/** "80.0 %" */
export function formatPct(x: number): string {
  if (!Number.isFinite(x)) return '—';
  return `${x.toFixed(1)} %`;
}

/** Tier band: "25–49", or "100+" for the last band. */
export function bandLabel(min: number, nextMin: number | null | undefined): string {
  if (nextMin == null) return `${min}+`;
  return nextMin - 1 <= min ? `${min}` : `${min}–${nextMin - 1}`;
}

/** The surplus default ("Extras on the last plate"). */
export function policyLabel(p: SurplusPolicy): string {
  return p === 'KEEP_FOR_STOCK' ? 'Keep extras in stock' : 'Cancel extras on the printer';
}

/**
 * A rate without the currency code, e.g. a cost per gram or an hourly rate:
 * 3 dp, or 4 dp when 3 dp would hide the value ("0.010", "0.0045").
 */
export function formatRate(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const three = Math.round(n * 1000) / 1000;
  return Math.abs(three - n) > 1e-9 ? n.toFixed(4) : n.toFixed(3);
}

/** A plain money amount without the currency code, 3 dp ("0.094"). */
export function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(3);
}

/** "1 component", "3 components". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
