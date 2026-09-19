import { BadRequestException } from '@nestjs/common';
import { optionalNumber, requiredEnum, requiredNumber, requiredText } from '../common/utils/validate-number';

/**
 * Allowlist parsers for every products-API body (spec §0.2 "Validation", §4.7).
 * Each returns a fresh object holding only the keys it knows; unknown keys are
 * dropped, never spread into Prisma `data`. Every number has a finite lower and
 * upper bound and a bad value is a 400 naming the field.
 */

type Body = Record<string, unknown>;

export const STALE_PAGE = 'This page is out of date — reload it';
const SURPLUS = ['CANCEL_ON_PRINTER', 'KEEP_FOR_STOCK'] as const;
const KINDS = ['SIZE', 'COLOUR'] as const;

export function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim();
}

export function asBody(raw: unknown): Body {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Body) : {};
}

const has = (b: Body, k: string) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined;

function bool(raw: unknown, field: string): boolean {
  if (typeof raw !== 'boolean') throw new BadRequestException(`"${field}" must be true or false`);
  return raw;
}

function id(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 64) throw new BadRequestException(`"${field}" must be an id`);
  return raw.trim();
}

function idOrNull(raw: unknown, field: string): string | null {
  return raw === null ? null : id(raw, field);
}

/** Optional text: null / '' → null, trimmed, at most `max` chars (400 beyond). */
function nullableText(raw: unknown, field: string, max: number, html = true): string | null {
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new BadRequestException(`"${field}" must be text`);
  const s = html ? stripHtml(raw) : raw.trim();
  if (s.length > max) throw new BadRequestException(`"${field}" must be at most ${max} characters`);
  return s || null;
}

function name(raw: unknown, field: string, max: number): string {
  const s = stripHtml(requiredText(typeof raw === 'string' ? raw : '', field, 10_000));
  if (!s) throw new BadRequestException(`${field} is required`);
  return s.slice(0, max);
}

function list(raw: unknown, field: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(raw)) throw new BadRequestException(`${field} must be a list`);
  if (raw.length < min || raw.length > max) {
    throw new BadRequestException(min > 0 ? `${field} must have ${min} to ${max} entries` : `${field} must have at most ${max} entries`);
  }
  return raw;
}

/** `?dryRun=1` / `true`. */
export function flag(raw: unknown): boolean {
  return raw === true || raw === 1 || raw === '1' || raw === 'true';
}

/** `confirm` from the body or the query. */
export function confirmOf(body: unknown, query?: unknown): boolean {
  return flag(asBody(body).confirm) || flag(query);
}

function rejectVariantId(b: Body) {
  if (has(b, 'variantId')) throw new BadRequestException(STALE_PAGE);
}

/** A pair parameter: absent, '' or 'standard' → null. */
export function pairParam(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null || raw === '' || raw === 'standard') return null;
  return id(raw, field);
}

// ------------------------------------------------------------------ products

export interface ProductCreateInput { name: string; description: string | null; sku: string | null; colorChanges: number; defaultPrinterId: string | null }

export function parseProductCreate(raw: unknown): ProductCreateInput {
  const b = asBody(raw);
  return {
    name: name(b.name, 'Product name', 200),
    description: has(b, 'description') ? nullableText(b.description, 'description', 2000) : null,
    sku: has(b, 'sku') ? nullableText(b.sku, 'sku', 64, false) : null,
    colorChanges: optionalNumber(b.colorChanges, 'colorChanges', { min: 0, max: 10_000, integer: true }) ?? 0,
    defaultPrinterId: has(b, 'defaultPrinterId') && b.defaultPrinterId !== '' ? idOrNull(b.defaultPrinterId, 'defaultPrinterId') : null,
  };
}

export interface ProductPatchInput {
  name?: string;
  description?: string | null;
  sku?: string | null;
  isActive?: boolean;
  defaultPrinterId?: string | null;
  colorChanges?: number;
  surplusPolicy?: (typeof SURPLUS)[number];
  baseOptionLabel?: string | null;
  baseOptionSellable?: boolean;
  standardColourLabel?: string | null;
  standardColourSellable?: boolean;
}

/** P6. `basePrice`, `imageUrl`, `estimated*` and anything unknown are ignored. */
export function parseProductPatch(raw: unknown): ProductPatchInput {
  const b = asBody(raw);
  const out: ProductPatchInput = {};
  if (has(b, 'name')) out.name = name(b.name, 'Product name', 200);
  if (has(b, 'description')) out.description = nullableText(b.description, 'description', 2000);
  if (has(b, 'sku')) out.sku = nullableText(b.sku, 'sku', 64, false);
  if (has(b, 'isActive')) out.isActive = bool(b.isActive, 'isActive');
  if (has(b, 'defaultPrinterId')) out.defaultPrinterId = b.defaultPrinterId === '' ? null : idOrNull(b.defaultPrinterId, 'defaultPrinterId');
  if (has(b, 'colorChanges')) out.colorChanges = requiredNumber(b.colorChanges, 'colorChanges', { min: 0, max: 10_000, integer: true });
  if (has(b, 'surplusPolicy')) out.surplusPolicy = requiredEnum(b.surplusPolicy, 'surplusPolicy', SURPLUS);
  if (has(b, 'baseOptionLabel')) out.baseOptionLabel = nullableText(b.baseOptionLabel, 'baseOptionLabel', 40);
  if (has(b, 'baseOptionSellable')) out.baseOptionSellable = bool(b.baseOptionSellable, 'baseOptionSellable');
  if (has(b, 'standardColourLabel')) out.standardColourLabel = nullableText(b.standardColourLabel, 'standardColourLabel', 40);
  if (has(b, 'standardColourSellable')) out.standardColourSellable = bool(b.standardColourSellable, 'standardColourSellable');
  return out;
}

/** P1 `page` int 1–100000 and `limit` int 1–1000 (default 25). */
export function parsePage(rawPage: unknown, rawLimit: unknown): { page: number; limit: number } {
  return {
    page: requiredNumber(rawPage === '' ? undefined : rawPage, 'page', { min: 1, max: 100_000, integer: true }),
    limit: optionalNumber(rawLimit, 'limit', { min: 1, max: 1000, integer: true }) ?? 25,
  };
}

// ---------------------------------------------------------------- components

const GRAMS = { min: 0.1, max: 100_000 };
const MINUTES = { min: 0, max: 100_000 };
const QTY = { min: 1, max: 1000, integer: true };

function linkFields(b: Body, out: { colourSlotId?: string | null; colourFixed?: boolean }) {
  if (has(b, 'colourSlotId')) out.colourSlotId = b.colourSlotId === '' ? null : idOrNull(b.colourSlotId, 'colourSlotId');
  if (has(b, 'colourFixed')) out.colourFixed = bool(b.colourFixed, 'colourFixed');
  if (out.colourFixed === true && out.colourSlotId) throw new BadRequestException("A part can't be linked to a colour slot and fixed at the same time");
}

export interface ComponentCreateInput {
  description: string;
  materialId: string;
  gramsUsed: number;
  printMinutes: number;
  quantity: number;
  sizeOptionId: string | null;
  colourSlotId?: string | null;
  colourFixed?: boolean;
}

/** P9. */
export function parseComponentCreate(raw: unknown): ComponentCreateInput {
  const b = asBody(raw);
  rejectVariantId(b);
  const out: ComponentCreateInput = {
    description: name(b.description, 'description', 120),
    materialId: id(b.materialId, 'materialId'),
    gramsUsed: requiredNumber(b.gramsUsed, 'gramsUsed', GRAMS),
    printMinutes: optionalNumber(b.printMinutes, 'printMinutes', MINUTES) ?? 0,
    quantity: optionalNumber(b.quantity, 'quantity', QTY) ?? 1,
    sizeOptionId: has(b, 'sizeOptionId') ? pairParam(b.sizeOptionId, 'sizeOptionId') : null,
  };
  linkFields(b, out);
  return out;
}

export interface ComponentPatchInput {
  description?: string;
  materialId?: string;
  gramsUsed?: number;
  printMinutes?: number;
  quantity?: number;
  colourSlotId?: string | null;
  colourFixed?: boolean;
  confirm: boolean;
}

/** P10. `plated*`, `stockOnHand`, `productId`, `variantId`, `attachmentId` are ignored. */
export function parseComponentPatch(raw: unknown): ComponentPatchInput {
  const b = asBody(raw);
  const out: ComponentPatchInput = { confirm: flag(b.confirm) };
  if (has(b, 'description')) out.description = name(b.description, 'description', 120);
  if (has(b, 'materialId')) out.materialId = id(b.materialId, 'materialId');
  if (has(b, 'gramsUsed')) out.gramsUsed = requiredNumber(b.gramsUsed, 'gramsUsed', GRAMS);
  if (has(b, 'printMinutes')) out.printMinutes = requiredNumber(b.printMinutes, 'printMinutes', MINUTES);
  if (has(b, 'quantity')) out.quantity = requiredNumber(b.quantity, 'quantity', QTY);
  linkFields(b, out);
  return out;
}

export interface SlotMaterialInput { colorIndex: number; materialId: string; colourSlotId?: string | null; colourFixed?: boolean }

/** P11 `{ slots: [{ colorIndex, materialId, colourSlotId?, colourFixed? }], confirm? }`. */
export function parseComponentMaterials(raw: unknown): { slots: SlotMaterialInput[]; confirm: boolean } {
  const b = asBody(raw);
  const slots = list(b.slots, 'slots', 64, 1).map((s, i) => {
    const e = asBody(s);
    const out: SlotMaterialInput = {
      colorIndex: requiredNumber(e.colorIndex, `slots[${i}].colorIndex`, { min: 0, max: 63, integer: true }),
      materialId: id(e.materialId, `slots[${i}].materialId`),
    };
    linkFields(e, out);
    return out;
  });
  const seen = new Set<number>();
  for (const s of slots) {
    if (seen.has(s.colorIndex)) throw new BadRequestException(`Colour ${s.colorIndex + 1} appears twice`);
    seen.add(s.colorIndex);
  }
  return { slots, confirm: flag(b.confirm) };
}

/** P12 `{ sizeOptionId, componentIds }`. */
export function parseComponentOrder(raw: unknown): { sizeOptionId: string | null; componentIds: string[] } {
  const b = asBody(raw);
  rejectVariantId(b);
  const componentIds = list(b.componentIds, 'componentIds', 500).map((x, i) => id(x, `componentIds[${i}]`));
  if (new Set(componentIds).size !== componentIds.length) throw new BadRequestException('componentIds must not repeat');
  return { sizeOptionId: has(b, 'sizeOptionId') ? pairParam(b.sizeOptionId, 'sizeOptionId') : null, componentIds };
}

/** P13 `{ colourKey, stockOnHand, expectedStockOnHand, note? }`. */
export function parseStockSet(raw: unknown): { colourKey: string | null; stockOnHand: number; expectedStockOnHand: number; note: string | null } {
  const b = asBody(raw);
  const colourKey = b.colourKey === undefined || b.colourKey === null || b.colourKey === '' ? null : b.colourKey;
  if (colourKey !== null && typeof colourKey !== 'string') throw new BadRequestException('"colourKey" must be text');
  return {
    colourKey: colourKey as string | null,
    stockOnHand: requiredNumber(b.stockOnHand, 'stockOnHand', { min: 0, max: 1_000_000, integer: true }),
    expectedStockOnHand: requiredNumber(b.expectedStockOnHand, 'expectedStockOnHand', { min: 0, max: 1_000_000, integer: true }),
    note: has(b, 'note') ? nullableText(b.note, 'note', 200) : null,
  };
}

// ------------------------------------------------------------------- pricing

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** P19 `{ sizeOptionId?, tiers }`. */
export function parseTiers(raw: unknown): { sizeOptionId: string | null; tiers: Array<{ minQty: number; unitPrice: number }> } {
  const b = asBody(raw);
  rejectVariantId(b);
  if (!Array.isArray(b.tiers)) throw new BadRequestException('tiers must be a list');
  const tiers = list(b.tiers, 'tiers', 20).map((t, i) => {
    const e = asBody(t);
    return {
      minQty: requiredNumber(e.minQty, `tiers[${i}].minQty`, { min: 2, max: 1_000_000, integer: true }),
      unitPrice: round3(requiredNumber(e.unitPrice, `tiers[${i}].unitPrice`, { min: 0.001, max: 1_000_000 })),
    };
  });
  const seen = new Set<number>();
  tiers.forEach((t, i) => {
    if (seen.has(t.minQty)) throw new BadRequestException(`tiers[${i}]: duplicate quantity ${t.minQty}`);
    seen.add(t.minQty);
  });
  return { sizeOptionId: has(b, 'sizeOptionId') ? pairParam(b.sizeOptionId, 'sizeOptionId') : null, tiers };
}

/** P18 `minQtys=25,50,100`: 1–20 distinct ints 2–1000000; absent → the size's own tier minimums. */
export function parseMinQtys(raw: unknown): number[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parts = String(raw).split(',').map((s) => s.trim());
  if (parts.length > 20) throw new BadRequestException('minQtys must have 1 to 20 quantities');
  const out = parts.map((p, i) => requiredNumber(p === '' ? NaN : p, `minQtys[${i}]`, { min: 2, max: 1_000_000, integer: true }));
  if (new Set(out).size !== out.length) throw new BadRequestException('minQtys must not repeat');
  return out;
}

/** P18/P20 query guard: a `variantId` parameter means a stale tab (§3.1 rule 13). */
export function rejectStaleQuery(query: Body) {
  if (has(query, 'variantId')) throw new BadRequestException(STALE_PAGE);
}

/** P20 `qty` int 1–100000 (default 1). */
export function parseReadinessQty(raw: unknown): number {
  return optionalNumber(raw, 'qty', { min: 1, max: 100_000, integer: true }) ?? 1;
}

/** P21 `{ partId, quantity }`. */
export function parsePartLine(raw: unknown): { partId: string; quantity: number } {
  const b = asBody(raw);
  const partId = requiredText(b.partId, 'partId', 64);
  const q = typeof b.quantity === 'number' ? b.quantity : typeof b.quantity === 'string' && b.quantity.trim() ? Number(b.quantity) : NaN;
  if (!Number.isInteger(q) || q < 1 || q > 1000) throw new BadRequestException('Quantity must be a whole number from 1 to 1000');
  return { partId, quantity: q };
}

// ------------------------------------------------------------------- options

export interface KeepStandardInput { label: string; sellInShop: boolean }

function keepStandard(raw: unknown, field: string): KeepStandardInput {
  const e = asBody(raw);
  const label = typeof e.label === 'string' ? stripHtml(e.label) : '';
  if (label.length < 1 || label.length > 40) throw new BadRequestException(`${field}.label must be 1 to 40 characters`);
  return { label, sellInShop: bool(e.sellInShop, `${field}.sellInShop`) };
}

const SORT_ORDER = { min: 0, max: 10_000, integer: true };

export interface OptionCreateInput {
  name: string;
  sku: string | null;
  kind: 'SIZE' | 'COLOUR';
  isActive: boolean;
  sortOrder?: number;
  keepStandard?: KeepStandardInput;
}

/** O1. Price, minutes and grams are never accepted: prices are automatic. */
export function parseOptionCreate(raw: unknown): OptionCreateInput {
  const b = asBody(raw);
  const out: OptionCreateInput = {
    name: name(b.name, 'Name', 80),
    sku: has(b, 'sku') ? nullableText(b.sku, 'sku', 64, false) : null,
    kind: requiredEnum(b.kind, 'kind', KINDS),
    isActive: has(b, 'isActive') ? bool(b.isActive, 'isActive') : true,
  };
  if (has(b, 'sortOrder')) out.sortOrder = requiredNumber(b.sortOrder, 'sortOrder', SORT_ORDER);
  if (has(b, 'keepStandard')) out.keepStandard = keepStandard(b.keepStandard, 'keepStandard');
  return out;
}

/** O2. A `kind` key → 400 (§3.1 rule 3); `basePrice`/`estimated*` ignored. */
export function parseOptionPatch(raw: unknown): { name?: string; sku?: string | null; isActive?: boolean; sortOrder?: number } {
  const b = asBody(raw);
  if (has(b, 'kind')) throw new BadRequestException('Change an option between size and colour on the Sizes & colours card');
  const out: { name?: string; sku?: string | null; isActive?: boolean; sortOrder?: number } = {};
  if (has(b, 'name')) out.name = name(b.name, 'Name', 80);
  if (has(b, 'sku')) out.sku = nullableText(b.sku, 'sku', 64, false);
  if (has(b, 'isActive')) out.isActive = bool(b.isActive, 'isActive');
  if (has(b, 'sortOrder')) out.sortOrder = requiredNumber(b.sortOrder, 'sortOrder', SORT_ORDER);
  return out;
}

/** O5 `{ slots, excludedSizeKeys?, confirm? }`. */
export function parseAssignments(raw: unknown): {
  slots: Array<{ colourSlotId: string; materialId: string | null }>;
  excludedSizeKeys?: string[];
  confirm: boolean;
} {
  const b = asBody(raw);
  const slots = list(b.slots ?? [], 'slots', 12).map((s, i) => {
    const e = asBody(s);
    return { colourSlotId: id(e.colourSlotId, `slots[${i}].colourSlotId`), materialId: e.materialId === null || e.materialId === '' ? null : id(e.materialId, `slots[${i}].materialId`) };
  });
  if (new Set(slots.map((s) => s.colourSlotId)).size !== slots.length) throw new BadRequestException('Each colour slot can be set once');
  let excludedSizeKeys: string[] | undefined;
  if (has(b, 'excludedSizeKeys')) {
    excludedSizeKeys = list(b.excludedSizeKeys, 'excludedSizeKeys', 31).map((k, i) => id(k, `excludedSizeKeys[${i}]`));
    if (new Set(excludedSizeKeys).size !== excludedSizeKeys.length) throw new BadRequestException('excludedSizeKeys must not repeat');
  }
  return { slots, excludedSizeKeys, confirm: flag(b.confirm) };
}

/** O7 `{ changes: [{ variantId, kind }], keepStandard?: { colour?, size? } }`. */
export function parseKindChanges(raw: unknown): {
  changes: Array<{ variantId: string; kind: 'SIZE' | 'COLOUR' }>;
  keepStandard: { colour?: KeepStandardInput; size?: KeepStandardInput };
} {
  const b = asBody(raw);
  const changes = list(b.changes, 'changes', 60, 1).map((c, i) => {
    const e = asBody(c);
    return { variantId: id(e.variantId, `changes[${i}].variantId`), kind: requiredEnum(e.kind, `changes[${i}].kind`, KINDS) };
  });
  if (new Set(changes.map((c) => c.variantId)).size !== changes.length) throw new BadRequestException('Each option can be changed once');
  const ks = asBody(b.keepStandard);
  const keep: { colour?: KeepStandardInput; size?: KeepStandardInput } = {};
  if (has(ks, 'colour')) keep.colour = keepStandard(ks.colour, 'keepStandard.colour');
  if (has(ks, 'size')) keep.size = keepStandard(ks.size, 'keepStandard.size');
  return { changes, keepStandard: keep };
}

// -------------------------------------------------------------- colour slots

/** C1. */
export function parseSlotName(raw: unknown): string {
  return name(asBody(raw).name, 'Name', 40);
}

/** C2. */
export function parseSlotPatch(raw: unknown): { name?: string; sortOrder?: number } {
  const b = asBody(raw);
  const out: { name?: string; sortOrder?: number } = {};
  if (has(b, 'name')) out.name = name(b.name, 'Name', 40);
  if (has(b, 'sortOrder')) out.sortOrder = requiredNumber(b.sortOrder, 'sortOrder', { min: 0, max: 1000, integer: true });
  return out;
}

export interface LinkInput { componentId: string; colorIndex: number; colourSlotId: string | null; slotRef: string | null; fixed: boolean }

/** C4 `{ slots?, links, confirm? }`. */
export function parseColourLinks(raw: unknown): {
  slots: Array<{ id: string | null; ref: string | null; name: string }>;
  links: LinkInput[];
  confirm: boolean;
} {
  const b = asBody(raw);
  const slots = list(b.slots ?? [], 'slots', 12).map((s, i) => {
    const e = asBody(s);
    const sid = has(e, 'id') ? id(e.id, `slots[${i}].id`) : null;
    const ref = has(e, 'ref') ? id(e.ref, `slots[${i}].ref`) : null;
    if (!!sid === !!ref) throw new BadRequestException(`slots[${i}] needs either an id or a ref`);
    return { id: sid, ref, name: name(e.name, `slots[${i}].name`, 40) };
  });
  if (new Set(slots.filter((s) => s.ref).map((s) => s.ref)).size !== slots.filter((s) => s.ref).length) throw new BadRequestException('Slot refs must not repeat');
  const links = list(b.links ?? [], 'links', 500).map((l, i) => {
    const e = asBody(l);
    const out: LinkInput = {
      componentId: id(e.componentId, `links[${i}].componentId`),
      colorIndex: requiredNumber(e.colorIndex, `links[${i}].colorIndex`, { min: 0, max: 63, integer: true }),
      colourSlotId: has(e, 'colourSlotId') ? idOrNull(e.colourSlotId, `links[${i}].colourSlotId`) : null,
      slotRef: has(e, 'slotRef') && e.slotRef !== null ? id(e.slotRef, `links[${i}].slotRef`) : null,
      fixed: has(e, 'fixed') ? bool(e.fixed, `links[${i}].fixed`) : false,
    };
    if ([!!out.colourSlotId, !!out.slotRef, out.fixed].filter(Boolean).length > 1) {
      throw new BadRequestException(`links[${i}] sets more than one of colourSlotId, slotRef and fixed`);
    }
    return out;
  });
  if (!slots.length && !links.length) throw new BadRequestException('Nothing to save');
  return { slots, links, confirm: flag(b.confirm) };
}
