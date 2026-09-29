import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { BomResolverService } from '../catalog-core/bom-resolver.service';
import type { OptionRow, ProductConfig } from '../catalog-core/catalog-config';
import type { CatalogRequestContext } from '../catalog-core/catalog-context';
import { round3 } from '../catalog-core/cost-engine';
import { lineDescription, pairLabel, relabelDescription, validatePair, type PairContext } from '../catalog-core/option-pair';
import type { LineInput, ResolvedLine } from '../catalog-core/pricing.service';
import { lockOptions, lockProduct } from '../products/product-locks';
import { requiredNumber } from '../common/utils/validate-number';

/**
 * Order and quote lines (spec §3.9, §4.5): request parsing (explicit allowlist,
 * §0.2), the FOR SHARE locks that serialise line inserts with product and option
 * deletes, totals, the stored line columns, and the S11 colour split. Shared by
 * OrdersService, QuotesService and the pricing preview.
 */

export const MAX_LINES = 100;
export const LINE_QTY_MAX = 100_000;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Optional id: a non-empty string or null. Anything else → 400 naming the field. */
export function optionalId(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new BadRequestException(`${field} must be a string`);
  return raw.trim() || null;
}

function optionalString(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  return typeof raw === 'string' ? raw : String(raw);
}

/** The items array of a request: an array of objects with 1..max entries. */
export function parseItemsArray(raw: unknown, opts: { max: number; min?: number; tooMany: string }): Record<string, unknown>[] {
  const min = opts.min ?? 1;
  if (!Array.isArray(raw)) {
    if (min === 0 && (raw === undefined || raw === null)) return [];
    throw new BadRequestException('items must be a list of lines');
  }
  if (raw.length < min) throw new BadRequestException('Add at least one line');
  if (raw.length > opts.max) throw new BadRequestException(opts.tooMany);
  return raw.map((it, i) => {
    if (!isObject(it)) throw new BadRequestException(`items[${i}] must be an object`);
    return it;
  });
}

/**
 * A staff line body (S1, S2, S6) → resolveLines input. Quantity and price are
 * passed raw: resolveLines validates them (§3.9 steps 1–2). A client unitPrice
 * is only ever used for overrides and custom lines.
 */
export function parseStaffLine(it: Record<string, unknown>, i: number): LineInput {
  const at = `items[${i}]`;
  return {
    productId: optionalId(it.productId, `${at}.productId`),
    sizeOptionId: optionalId(it.sizeOptionId, `${at}.sizeOptionId`),
    colourOptionId: optionalId(it.colourOptionId, `${at}.colourOptionId`),
    variantId: optionalId(it.variantId, `${at}.variantId`),
    quantity: it.quantity,
    unitPrice: it.unitPrice,
    priceOverride: it.priceOverride === true,
    overrideReason: optionalString(it.overrideReason),
    description: optionalString(it.description),
  };
}

/** A customer line body (S5): no price, no description (§3.9 step 10), quantity 1–50. */
export function parseCustomerLine(it: Record<string, unknown>, i: number): LineInput {
  const at = `items[${i}]`;
  const quantity = requiredNumber(it.quantity, `${at}.quantity`, { min: 1, max: 50, integer: true });
  return {
    productId: optionalId(it.productId, `${at}.productId`),
    sizeOptionId: optionalId(it.sizeOptionId, `${at}.sizeOptionId`),
    colourOptionId: optionalId(it.colourOptionId, `${at}.colourOptionId`),
    variantId: optionalId(it.variantId, `${at}.variantId`),
    quantity,
  };
}

type LockTx = { $queryRaw: (q: any) => Promise<unknown> };

/**
 * §3.9 "Line inserts vs deletes": FOR SHARE on every option and product row the
 * lines name, before any line is resolved or written. A row that has vanished →
 * 400. Call as the first statements of the transaction; resolveLines then runs
 * on the locked rows (§3.1 rule 3).
 *
 * Lock order: the ProductVariant rows (sorted, one statement), then the Product
 * rows, then — for S11 — the line itself (lockLineForSplit). O7 takes its FOR
 * UPDATE locks in that same order (options, then the product), and J1, J5 and
 * slicer imports lock options before their inserts touch the product row. With
 * one global order a line writer and O7 wait for each other instead of
 * deadlocking (Postgres 40P01 → a 500), so §3.1 rule 3's "writer first, or O7
 * first" is what actually happens.
 */
export async function lockLineRows(tx: LockTx, lines: ReadonlyArray<Pick<LineInput, 'productId' | 'sizeOptionId' | 'colourOptionId' | 'variantId'>>): Promise<void> {
  const optionIds = [...new Set(lines.flatMap((l) => [l.sizeOptionId, l.colourOptionId, l.variantId]).filter((x): x is string => !!x))].sort();
  const options = new Map((await lockOptions(tx, optionIds, 'SHARE')).map((o) => [o.id, o]));
  // A legacy customer body names only the option: its product comes from that locked row (§3.1 rule 13).
  const ownerOf = (l: Pick<LineInput, 'productId' | 'variantId'>) => l.productId ?? (l.variantId ? options.get(l.variantId)?.productId ?? null : null);
  const productIds = [...new Set(lines.map(ownerOf).filter((x): x is string => !!x))].sort();

  const products = new Set<string>();
  for (const id of productIds) {
    const row = await lockProduct(tx, id, 'SHARE');
    if (row) products.add(row.id);
  }

  lines.forEach((l, i) => {
    const prefix = `Line ${i + 1}: `;
    for (const id of [l.sizeOptionId, l.colourOptionId, l.variantId]) {
      if (id && !options.has(id)) throw new BadRequestException(`${prefix}that size or colour no longer exists`);
    }
    const owner = ownerOf(l);
    if ((l.productId || l.variantId) && (!owner || !products.has(owner))) throw new BadRequestException(`${prefix}product not found`);
  });
}

// ------------------------------------------------------- document row locks

type RawTx = { $queryRaw: (q: Prisma.Sql) => Promise<unknown> };
const ROW_TABLES = { OrderItem: '"OrderItem"', QuoteItem: '"QuoteItem"', Quote: '"Quote"' } as const;

/** `SELECT "id" FROM <table> WHERE id = $1 FOR UPDATE` (marker `lock:<Table>:UPDATE`, as product-locks.ts). */
async function lockRowForUpdate(tx: RawTx, table: keyof typeof ROW_TABLES, id: string): Promise<boolean> {
  const sql = Prisma.sql`/* lock:${Prisma.raw(`${table}:UPDATE`)} */ SELECT "id" FROM ${Prisma.raw(ROW_TABLES[table])} WHERE "id" = ANY(${[id]}::text[]) FOR UPDATE`;
  return ((await tx.$queryRaw(sql)) as unknown[]).length > 0;
}

/**
 * The quote row, FOR UPDATE: the first lock of quote S11 and of S7's conversion,
 * so two splits of one quote, or a split and the conversion, run one after the
 * other (the quote's per-document lock, as the plan lock is an order's). Read
 * the quote and its lines after it. False when the quote doesn't exist.
 */
export function lockQuote(tx: RawTx, quoteId: string): Promise<boolean> {
  return lockRowForUpdate(tx, 'Quote', quoteId);
}

/** The line columns an S11 split is computed from. */
const SPLIT_KEYS = ['productId', 'variantId', 'sizeOptionId', 'colourOptionId', 'quantity'] as const;
type SplitSource = { id: string; productId: string | null; variantId?: string | null; sizeOptionId: string | null; colourOptionId: string | null; quantity: number };

export const LINE_CHANGED_MESSAGE = 'This line was changed by someone else — reload and try again';

/**
 * S11's row locks, in the global order of lockLineRows: FOR SHARE on every
 * option the line and the split name, FOR SHARE on the product, then FOR UPDATE
 * on the line itself, which is then re-read. The line's first read picks the
 * rows to lock but is not locked (locking it before the options would invert
 * the order against O7, which rewrites lines after its option locks), so a
 * writer that changed the line's product, options or quantity in between → 409,
 * and the split never adds up to anything but the locked line's quantity.
 * Returns the re-read line and the option ids that were found and locked.
 */
export async function lockLineForSplit<T extends SplitSource>(
  tx: RawTx,
  table: 'OrderItem' | 'QuoteItem',
  seen: T,
  colours: ColourSplitInput['colours'],
  reread: () => Promise<T | null>,
): Promise<{ item: T; lockedOptions: Set<string> }> {
  const optionIds = [...new Set([seen.variantId, seen.sizeOptionId, seen.colourOptionId, ...colours.map((c) => c.colourOptionId)].filter((x): x is string => !!x))].sort();
  const lockedOptions = new Set((await lockOptions(tx, optionIds, 'SHARE')).map((o) => o.id));
  for (const c of colours) {
    if (c.colourOptionId && !lockedOptions.has(c.colourOptionId)) throw new BadRequestException('That colour no longer exists');
  }
  if (!seen.productId || !(await lockProduct(tx, seen.productId, 'SHARE'))) throw new BadRequestException("This line's product no longer exists");
  await lockRowForUpdate(tx, table, seen.id);
  const item = await reread();
  if (!item || SPLIT_KEYS.some((k) => (item[k] ?? null) !== (seen[k] ?? null))) throw new ConflictException(LINE_CHANGED_MESSAGE);
  return { item, lockedOptions };
}

/** tax_rate setting as a fraction; anything outside 0–100 counts as 0 (as createForCustomer did). */
export async function taxRateOf(db: { systemSetting: { findUnique: (a: any) => Promise<{ value: string } | null> } }): Promise<number> {
  const row = await db.systemSetting.findUnique({ where: { key: 'tax_rate' } });
  const raw = parseFloat(row?.value || '0');
  return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw / 100 : 0;
}

/** §0.2 Money: line totals, subtotal, tax and total rounded separately. */
export function documentTotals(lines: ReadonlyArray<{ totalPrice: number }>, taxRate: number) {
  const subtotal = round3(lines.reduce((s, l) => s + l.totalPrice, 0));
  const tax = round3(subtotal * taxRate);
  return { subtotal, tax, total: round3(subtotal + tax) };
}

/** The stored columns of a resolved line (§3.9 "What is recorded"). */
export function quoteItemColumns(l: ResolvedLine) {
  return {
    productId: l.productId,
    sizeOptionId: l.sizeOptionId,
    colourOptionId: l.colourOptionId,
    description: l.description,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    totalPrice: l.totalPrice,
    listUnitPrice: l.listUnitPrice,
    priceSource: l.priceSource,
    tierMinQty: l.tierMinQty,
    priceOverrideReason: l.priceOverrideReason,
  };
}

/** OrderItem also stores the `variantId` mirror (§2.2). */
export function orderItemColumns(l: ResolvedLine) {
  return { ...quoteItemColumns(l), variantId: l.variantId };
}

/** `priceWarnings: [{ line, codes }]` (S2, S6): warnings never block. */
export function priceWarningsOf(lines: ReadonlyArray<ResolvedLine>): Array<{ line: number; codes: string[] }> {
  return lines.filter((l) => l.warnings.length).map((l) => ({ line: l.index + 1, codes: l.warnings.map((w) => w.code) }));
}

// ---------------------------------------------------------------- display

export interface LineRow {
  id: string;
  productId: string | null;
  variantId?: string | null;
  sizeOptionId: string | null;
  colourOptionId: string | null;
}

export interface LineOptions {
  size: { id: string; name: string } | null;
  colour: { id: string; name: string } | null;
  optionLabel: string | null;
}

/**
 * S4/S8 `items[].size`, `items[].colour`, `items[].optionLabel` via
 * effectiveOptions (legacy lines follow their option's current kind). Never throws.
 */
export async function lineOptionsOf(resolver: BomResolverService, rows: ReadonlyArray<LineRow>, ctx: CatalogRequestContext): Promise<Map<string, LineOptions>> {
  await resolver.preloadVariants(rows.flatMap((r) => [r.variantId, r.sizeOptionId, r.colourOptionId]).filter((x): x is string => !!x), ctx);
  const out = new Map<string, LineOptions>();
  for (const r of rows) {
    const eff = resolver.effectiveOptions({ sizeOptionId: r.sizeOptionId, colourOptionId: r.colourOptionId, variantId: r.variantId ?? null }, ctx);
    const named = (id: string | null | undefined) => {
      if (!id) return null;
      const v = ctx.variants.get(id);
      return v ? { id: v.id, name: v.name ?? '' } : null;
    };
    if (eff.skip) {
      out.set(r.id, { size: null, colour: null, optionLabel: null });
      continue;
    }
    const size = named(eff.sizeOptionId);
    const colour = named(eff.colourOptionId);
    let optionLabel: string | null = null;
    if (r.productId) {
      const config = await resolver.loadConfig(r.productId, ctx).catch(() => null);
      if (config) {
        const sizeRow = size ? config.options.find((o) => o.id === size.id) ?? null : null;
        const colourRow = colour ? config.options.find((o) => o.id === colour.id) ?? null : null;
        optionLabel = pairLabel(config, sizeRow, colourRow);
      }
    }
    out.set(r.id, { size, colour, optionLabel });
  }
  return out;
}

// ------------------------------------------------------------------ S11

export interface ColourSplitInput {
  colours: Array<{ colourOptionId: string | null; quantity: number }>;
  confirm: boolean;
}

/** S11 body (§3.9, §4.7): 1–30 distinct colours, int quantities summing to the line's. */
export function parseColourSplit(body: unknown, lineQuantity: number): ColourSplitInput {
  const b = isObject(body) ? body : {};
  const raw = b.colours;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 30) throw new BadRequestException('colours must list 1 to 30 colours');
  const seen = new Set<string>();
  const colours = raw.map((c, i) => {
    if (!isObject(c)) throw new BadRequestException(`colours[${i}] must be an object`);
    const colourOptionId = optionalId(c.colourOptionId, `colours[${i}].colourOptionId`);
    const quantity = requiredNumber(c.quantity, `colours[${i}].quantity`, { min: 1, max: LINE_QTY_MAX, integer: true });
    const k = colourOptionId ?? '';
    if (seen.has(k)) throw new BadRequestException('Each colour can be listed only once');
    seen.add(k);
    return { colourOptionId, quantity };
  });
  const sum = colours.reduce((s, c) => s + c.quantity, 0);
  if (sum !== lineQuantity) throw new BadRequestException(`The colours must add up to ${lineQuantity}`);
  return { colours, confirm: b.confirm === true };
}

export interface SplitLine {
  colourOptionId: string | null;
  quantity: number;
  totalPrice: number;
  description: string;
}

/**
 * The lines an S11 split writes (§3.9 "Changing a sold line's colour"): the
 * price never changes; each pair is validated (STAFF, active only) on the locked
 * rows; the description's label is replaced, its note kept.
 */
export function splitLineByColour(
  pc: PairContext,
  line: { unitPrice: number; description: string },
  size: OptionRow | null,
  oldColour: OptionRow | null,
  oldColourName: string | null,
  colours: ColourSplitInput['colours'],
): SplitLine[] {
  const config: ProductConfig = pc.config;
  const oldLabel = oldColour
    ? lineDescription(config.product, size, oldColour)
    : lineDescription(config.product, size, oldColourName ? { name: oldColourName } : null);
  return colours.map((c) => {
    const { colour } = validatePair(pc, size?.id ?? null, c.colourOptionId, { audience: 'STAFF' });
    const newLabel = lineDescription(config.product, size, colour);
    return {
      colourOptionId: c.colourOptionId,
      quantity: c.quantity,
      totalPrice: round3(c.quantity * line.unitPrice),
      description: relabelDescription(line.description, oldLabel, newLabel),
    };
  });
}
