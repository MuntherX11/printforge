import { BadRequestException } from '@nestjs/common';
import type { OptionPair } from '@printforge/types';
import { optionsOfKind, type OptionRow, type ProductConfig } from './catalog-config';

/**
 * Pairs: (standard size | size) × (standard colour | colour) (spec §3.1).
 * Pure functions over a loaded ProductConfig; the resolver supplies the colour
 * warnings that drive the customer offer rule.
 */

export type Audience = 'STAFF' | 'CUSTOMER';

/** Codes that keep a colour out of the shop on a size (§3.1 rule 8). */
export const OFFER_BLOCKING_CODES = ['COLOUR_OPTION_NOT_SET_UP', 'COLOUR_OPTION_NO_EFFECT', 'COLOUR_SLOT_UNLINKED'];

export interface PairContext {
  config: ProductConfig;
  /** SLOT_STANDARD_MIXED present (§3.3) */
  standardColourMixed: boolean;
  /** Resolver colour-warning codes of (size, colour). Only called for a real colour. */
  colourWarningCodes(sizeOptionId: string | null, colourOptionId: string): string[];
}

export const STANDARD_KEY = 'standard';
export const sizeKey = (sizeOptionId: string | null) => sizeOptionId ?? STANDARD_KEY;

export function standardSizeLabel(config: ProductConfig): string {
  return config.product.baseOptionLabel || 'Standard';
}
export function standardColourLabel(config: ProductConfig): string {
  return config.product.standardColourLabel || 'Standard';
}

const activeOfKind = (config: ProductConfig, kind: 'SIZE' | 'COLOUR') =>
  config.options.filter((o) => o.kind === kind && o.isActive);
const baseComponentCount = (config: ProductConfig) => config.components.filter((c) => c.variantId === null).length;

/** §3.1 rule 6 (staff = baseSellable, customers = baseSellableToCustomers). */
export function standardSizeSellable(config: ProductConfig, audience: Audience): boolean {
  const p = config.product;
  if (!p.isActive || !(p.basePrice > 0)) return false;
  const sizes = activeOfKind(config, 'SIZE').length;
  if (sizes === 0) return true;
  if (audience === 'STAFF') return baseComponentCount(config) > 0;
  return p.baseOptionSellable === true && baseComponentCount(config) > 0;
}

/** §3.1 rule 7. Staff: always. Customers: switch (or no colours) and never while mixed. */
export function standardColourSellable(ctx: PairContext, audience: Audience): boolean {
  if (audience === 'STAFF') return true;
  const colours = activeOfKind(ctx.config, 'COLOUR').length;
  return (colours === 0 || ctx.config.product.standardColourSellable === true) && !ctx.standardColourMixed;
}

export function isExcluded(colour: OptionRow, sizeOptionId: string | null): boolean {
  return colour.excludedSizeKeys.includes(sizeKey(sizeOptionId));
}

/**
 * Is `colour` offered on `size` to `audience` (§3.1 rule 8)? The standard colour
 * (null) is always offered to staff, and to customers per rule 7.
 */
export function colourOffered(ctx: PairContext, sizeOptionId: string | null, colourOptionId: string | null, audience: Audience): boolean {
  if (colourOptionId === null) return standardColourSellable(ctx, audience);
  const colour = ctx.config.options.find((o) => o.id === colourOptionId);
  if (!colour) return false;
  if (isExcluded(colour, sizeOptionId)) return false;
  if (audience === 'STAFF') return true;
  const codes = ctx.colourWarningCodes(sizeOptionId, colourOptionId);
  return !codes.some((c) => OFFER_BLOCKING_CODES.includes(c));
}

/** Pair label using only the axes the product has (§3.1 rule 11). */
export function pairLabel(config: ProductConfig, size: OptionRow | null, colour: OptionRow | null): string {
  const hasSizes = config.options.some((o) => o.kind === 'SIZE');
  const hasColours = config.options.some((o) => o.kind === 'COLOUR');
  const s = size ? size.name : standardSizeLabel(config);
  const c = colour ? colour.name : standardColourLabel(config);
  if (hasSizes && hasColours) return `${s} · ${c}`;
  if (hasColours) return c;
  return s;
}

export interface ValidatePairOptions {
  audience: Audience;
  allowInactive?: boolean;
  prefix?: string;
}

/**
 * The single pair check for new lines and jobs (§3.1 rule 9). The option rows it
 * reads must be the ones the writer locked FOR SHARE.
 */
export function validatePair(
  ctx: PairContext,
  sizeOptionId: string | null,
  colourOptionId: string | null,
  opts: ValidatePairOptions,
): { size: OptionRow | null; colour: OptionRow | null } {
  const { config } = ctx;
  const product = config.product;
  const prefix = opts.prefix ?? '';
  const size = sizeOptionId ? config.options.find((o) => o.id === sizeOptionId) ?? null : null;
  const colour = colourOptionId ? config.options.find((o) => o.id === colourOptionId) ?? null : null;
  if (sizeOptionId && !size) throw new BadRequestException(`${prefix}that size belongs to another product`);
  if (size && size.kind !== 'SIZE') throw new BadRequestException(`${prefix}"${size.name}" is a colour, not a size`);
  if (colourOptionId && !colour) throw new BadRequestException(`${prefix}that colour belongs to another product`);
  if (colour && colour.kind !== 'COLOUR') throw new BadRequestException(`${prefix}"${colour.name}" is a size, not a colour`);
  if (!opts.allowInactive) {
    if (!product.isActive) throw new BadRequestException(`${prefix}"${product.name}" is inactive`);
    if (size && !size.isActive) throw new BadRequestException(`${prefix}size "${size.name}" is no longer available`);
    if (colour && !colour.isActive) throw new BadRequestException(`${prefix}colour "${colour.name}" is no longer available`);
    if (!size && !standardSizeSellable(config, opts.audience)) throw new BadRequestException(`${prefix}choose a size for "${product.name}"`);
    if (!colour && !standardColourSellable(ctx, opts.audience)) throw new BadRequestException(`${prefix}choose a colour for "${product.name}"`);
    if (colour && isExcluded(colour, sizeOptionId)) {
      const sizeLabel = size ? size.name : standardSizeLabel(config);
      throw new BadRequestException(`${prefix}"${colour.name}" isn't made in ${sizeLabel}`);
    }
    if (colour && opts.audience === 'CUSTOMER' && !colourOffered(ctx, sizeOptionId, colourOptionId, 'CUSTOMER')) {
      throw new BadRequestException(`${prefix}"${pairLabel(config, size, colour)}" can't be ordered yet`);
    }
  }
  return { size, colour };
}

// ---------------------------------------------------------------- legacy rows

export interface VariantLite {
  id: string;
  productId: string;
  kind: 'SIZE' | 'COLOUR' | string;
  name?: string;
}

export interface PairRow {
  sizeOptionId?: string | null;
  colourOptionId?: string | null;
  variantId?: string | null;
  /** present on ProductionJob rows only */
  orderItemId?: string | null;
}

export type EffectiveOptions =
  | (OptionPair & { legacy: boolean; skip?: undefined })
  | { skip: 'LINE_OPTION_MISSING'; sizeOptionId?: undefined; colourOptionId?: undefined; legacy?: undefined };

/**
 * The pair of an existing OrderItem, QuoteItem or ProductionJob (§3.2). Legacy
 * rows follow their option's CURRENT kind; a pre-release order-planned job reads
 * its order line. Never throws. Lookups are memoised by the caller per request.
 */
export function effectiveOptions(
  row: PairRow,
  lookups: { variant(id: string): VariantLite | undefined | null; orderItem?(id: string): PairRow | undefined | null },
): EffectiveOptions {
  if (row.sizeOptionId || row.colourOptionId) {
    return { sizeOptionId: row.sizeOptionId ?? null, colourOptionId: row.colourOptionId ?? null, legacy: false };
  }
  if (row.variantId) {
    const v = lookups.variant(row.variantId);
    if (!v) return { skip: 'LINE_OPTION_MISSING' };
    return v.kind === 'COLOUR'
      ? { sizeOptionId: null, colourOptionId: v.id, legacy: true }
      : { sizeOptionId: v.id, colourOptionId: null, legacy: true };
  }
  if (row.orderItemId && lookups.orderItem) {
    const item = lookups.orderItem(row.orderItemId);
    if (item) {
      const e = effectiveOptions({ sizeOptionId: item.sizeOptionId, colourOptionId: item.colourOptionId, variantId: item.variantId }, lookups);
      return e.skip ? e : { ...e, legacy: true };
    }
  }
  return { sizeOptionId: null, colourOptionId: null, legacy: false };
}

export interface LegacyLine {
  productId?: string | null;
  variantId?: string | null;
  sizeOptionId?: string | null;
  colourOptionId?: string | null;
}

/**
 * §3.1 rule 13: a request that sends `variantId` and neither new column is mapped
 * by that option's kind; a body without productId takes it from the option. The
 * result is then validated by validatePair as usual.
 */
export function mapLegacyVariantId(
  line: LegacyLine,
  variant: (id: string) => VariantLite | undefined | null,
  prefix = '',
): { productId: string | null; sizeOptionId: string | null; colourOptionId: string | null } {
  const sizeOptionId = line.sizeOptionId ?? null;
  const colourOptionId = line.colourOptionId ?? null;
  let productId = line.productId ?? null;
  if (!line.variantId || sizeOptionId || colourOptionId) return { productId, sizeOptionId, colourOptionId };
  const v = variant(line.variantId);
  if (!v) throw new BadRequestException(`${prefix}that size or colour no longer exists`);
  productId = productId ?? v.productId;
  return v.kind === 'COLOUR'
    ? { productId, sizeOptionId: null, colourOptionId: v.id }
    : { productId, sizeOptionId: v.id, colourOptionId: null };
}

// ---------------------------------------------------------------- descriptions

const MAX_DESCRIPTION = 200;

/** `Sardine tin — Large — Red`; standard axes are omitted (§3.1 rule 11). */
export function lineDescription(product: { name: string }, size: { name: string } | null, colour: { name: string } | null): string {
  return product.name + (size ? ` — ${size.name}` : '') + (colour ? ` — ${colour.name}` : '');
}

export function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, '').replace(/[<>]/g, '');
}

/** True when `text` starts with `label` followed by the end or a separator. */
function startsWithLabel(text: string, label: string): boolean {
  if (!text.startsWith(label)) return false;
  const next = text.charAt(label.length);
  return next === '' || /[\s—–\-,;:]/.test(next);
}

const LEADING_SEPARATORS = /^[\s—–-]+/;

function joinCut(label: string, note: string): string {
  if (!note) return label;
  const room = MAX_DESCRIPTION - label.length - 3;
  if (room <= 0) return label;
  return `${label} — ${note.slice(0, room).trimEnd()}`;
}

/**
 * The stored description of a product line (§3.9 step 10): always the server
 * label first; client text only as a note after it. A leading copy of the label
 * (the staff forms prefill it) is removed from the note. ≤ 200 chars, label never cut.
 */
export function withLineNote(label: string, clientText: string | null | undefined): string {
  let note = stripHtml(String(clientText ?? '')).trim();
  if (startsWithLabel(note, label)) note = note.slice(label.length);
  note = note.replace(LEADING_SEPARATORS, '').trim();
  return joinCut(label, note);
}

/**
 * S11: a split line's description names its new pair. A description that starts
 * with the old label keeps its note; a pre-release one becomes the note.
 */
export function relabelDescription(oldDescription: string, oldLabel: string, newLabel: string): string {
  if (startsWithLabel(oldDescription, oldLabel)) {
    const note = oldDescription.slice(oldLabel.length).replace(LEADING_SEPARATORS, '').trim();
    return joinCut(newLabel, note);
  }
  return joinCut(newLabel, oldDescription.trim());
}

/** Sizes in display order for an audience: standard first when sellable (§3.1 rule 10). */
export function orderedSizes(config: ProductConfig, audience: Audience): Array<OptionRow | null> {
  const out: Array<OptionRow | null> = [];
  if (standardSizeSellable(config, audience)) out.push(null);
  for (const s of optionsOfKind(config, 'SIZE')) {
    if (!s.isActive || !config.product.isActive) continue;
    const price = audience === 'CUSTOMER' ? s.basePrice : s.basePrice ?? config.product.basePrice;
    if ((price ?? 0) > 0) out.push(s);
  }
  return out;
}
