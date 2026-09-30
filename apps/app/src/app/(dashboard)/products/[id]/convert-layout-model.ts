/**
 * Pure text helpers for Convert to plate (ConvertToLayoutDialog and its
 * review). No React, no fetching: everything comes from ProductDetail, the
 * O8a preview and the form.
 */
import type { UnitsPrefillSource } from '@printforge/types';
import { formatGrams, formatMinutes, plural, policyLabel } from '@/lib/product-format';
import type { LayoutConversionPreview, PlanSummary, ProductDetail, SizeOptionDetail, SurplusPolicy } from '@/lib/types/api';
import { isLastActive, lastOfAxisText } from './options-model';

/** "Standard, t50 and c25". */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const plateName = (units: number) => (units === 1 ? 'single' : `×${units}`);

/** One planning cell: "2 × single · 24 min · 4.9 g", "1 × ×50 · 7 h 1 min · 121 g · 48 extra". */
export function planText(s: PlanSummary, policy: SurplusPolicy): string {
  const plates = s.plates.map(p => `${p.plateCount} × ${plateName(p.unitsPerPlate)}`).join(' + ');
  const parts = [plates, formatMinutes(s.minutes), formatGrams(s.grams)];
  if (s.extra > 0) parts.push(policy === 'KEEP_FOR_STOCK' ? `${s.extra} extra` : `${s.extra} skipped`);
  return parts.join(' · ');
}

/** The sentence above the planning table. */
export function planningSentence(p: LayoutConversionPreview): string {
  const keep = p.planning.surplusPolicy === 'KEEP_FOR_STOCK';
  return `Jobs for ${joinList(p.planning.appliesTo)} plan ${p.component.description} on the fewest plates, so a small job can get a whole ×${p.layout.unitsPerPlate} plate. `
    + `With "${policyLabel(p.planning.surplusPolicy)}" (this product's setting) the extra units are ${keep ? 'printed and go to printed stock' : 'skipped on the printer'}. `
    + 'Plates can still be changed when planning.';
}

/** The hint under "Units on the plate". */
export function unitsHint(
  prefill: { units: number | null; source: UnitsPrefillSource | null; ratio: number | null },
  optionName: string,
  optionGrams: number | null,
  componentGrams: number | null,
): string {
  if (prefill.source === 'FILE') return "From the file's object labels";
  if (prefill.source === 'NAME') {
    const byWeight = prefill.ratio !== null && Math.floor(prefill.ratio) !== prefill.units ? ` · by weight about ${Math.floor(prefill.ratio)}` : '';
    return `From the name "${optionName}"${byWeight}`;
  }
  if (prefill.source === 'WEIGHT' && prefill.ratio !== null && optionGrams !== null && componentGrams !== null) {
    return `Estimated: ${optionGrams} g ÷ ${componentGrams} g per unit ≈ ${prefill.ratio.toFixed(1)}`;
  }
  return 'Enter how many units are on the plate';
}

/** The units field's error, or null (whole 2–500; 1 is the part itself). `partName` null = no part chosen yet. */
export function unitsError(raw: string, partName: string | null, optionName: string): string | null {
  if (raw.trim() === '') return null;
  if (/^\s*1\s*$/.test(raw)) {
    return `One unit per plate is ${partName ? `"${partName}"` : 'the part'} itself — close this and use Deactivate on the ${optionName} row`;
  }
  const n = Number(raw);
  return /^\d+$/.test(raw.trim()) && n >= 2 && n <= 500 ? null : 'Whole number from 2 to 500';
}

/** Whole number 2–500, else null. */
export function parseUnits(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n >= 2 && n <= 500 ? n : null;
}

export interface HappensItem {
  text: string;
  /** the open lines, listed under their sentence */
  list?: string[];
}

/** The review's "What happens" sentences, in order. `money` formats a price. */
export function whatHappens(
  product: ProductDetail,
  option: SizeOptionDetail,
  p: LayoutConversionPreview,
  money: (n: number) => string,
): HappensItem[] {
  const name = option.name;
  const out: HappensItem[] = [];
  out.push({
    text: p.option.isActive
      ? `${name} is switched off: it is no longer offered on new orders, quotes, jobs or in the shop.`
      : `${name} is already switched off and stays off.`,
  });
  const h = p.history;
  out.push({
    text: h.orderLines + h.quoteLines + h.jobs > 0
      ? `Its history is kept: ${plural(h.orderLines, 'order line')}, ${plural(h.quoteLines, 'quote line')} and ${plural(h.jobs, 'job')} keep ${name}.`
      : `${name} has never been ordered, quoted or produced.`,
  });
  if (p.openLines.total > 0) {
    const list = p.openLines.lines.map(l => `${l.number} ×${l.quantity}${l.partlyPlanned ? ' (partly planned)' : ''}`);
    const more = p.openLines.total - p.openLines.lines.length;
    if (more > 0) list.push(`and ${more} more`);
    const one = p.openLines.total === 1;
    out.push({
      text: `${plural(p.openLines.total, 'open order or quote line')} on ${name} still ${one ? 'plans' : 'plan'} one standard set per unit, `
        + `as ${one ? 'it does' : 'they do'} today — plan ${one ? 'it' : 'them'} by hand:`,
      list,
    });
  }
  const price = p.option.legacyPrice !== null
    ? `Its own price (${money(p.option.legacyPrice)}) stays on it for its history.`
    : `${name} has no price of its own.`;
  out.push({
    text: `${price} ${product.name}'s price and bulk tiers don't change — a plate layout never changes a price; it changes how jobs are planned and the Bulk pricing card's cost floor.`,
  });
  if (p.option.isActive && isLastActive(product, 'SIZE', option.id)) out.push({ text: lastOfAxisText(product, 'SIZE') });
  return out;
}
