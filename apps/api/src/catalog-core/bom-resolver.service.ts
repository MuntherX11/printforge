import { Injectable, NotFoundException } from '@nestjs/common';
import type { OptionPair, Problem } from '@printforge/types';
import { PrismaService } from '../common/prisma/prisma.service';
import { PRODUCT_CONFIG_INCLUDE, toProductConfig, type ProductConfig } from './catalog-config';
import { CatalogRequestContext, pairKey } from './catalog-context';
import { resolveInConfig, standardMixedWarnings, type ResolvedBom } from './bom-resolve';
import { effectiveOptions, type PairContext, type PairRow, type VariantLite } from './option-pair';

export * from './bom-resolve';

/** An existing order/quote line or job, as resolveForLine reads it. */
export interface ExistingLine extends PairRow {
  productId: string | null;
  description?: string | null;
}

export type LineResolution =
  | { skip: false; bom: ResolvedBom; pair: OptionPair; legacy: boolean }
  | { skip: true; warning: Problem };

type Db = Pick<PrismaService, 'product' | 'productVariant' | 'orderItem'>;

/**
 * The single entry point for "what does this pair print" (spec §3.2). Every
 * consumer — costing, bulk floor, readiness, jobs, planning, availability,
 * print files — goes through here.
 *
 * Loads are memoised in a CatalogRequestContext: one Prisma query per product
 * per request, one resolution per pair.
 */
@Injectable()
export class BomResolverService {
  constructor(private readonly prisma: PrismaService) {}

  /** Load one product's configuration (one query). null when the product doesn't exist. */
  async loadConfig(productId: string, ctx?: CatalogRequestContext, db?: Db): Promise<ProductConfig | null> {
    const client = db ?? this.prisma;
    const load = async () => {
      const row = await client.product.findUnique({ where: { id: productId }, include: PRODUCT_CONFIG_INCLUDE as any });
      if (!row) return null;
      const config = toProductConfig(row);
      if (ctx) for (const o of config.options) ctx.variants.set(o.id, { id: o.id, productId: o.productId, kind: o.kind, name: o.name });
      return config;
    };
    if (!ctx) return load();
    let p = ctx.configs.get(productId);
    if (!p) {
      p = load();
      ctx.configs.set(productId, p);
    }
    return p;
  }

  async requireConfig(productId: string, ctx?: CatalogRequestContext, db?: Db): Promise<ProductConfig> {
    const c = await this.loadConfig(productId, ctx, db);
    if (!c) throw new NotFoundException('Product not found');
    return c;
  }

  /** Resolve a pair against an in-memory (possibly modified) configuration. */
  resolveWithConfig(config: ProductConfig, pair: OptionPair): ResolvedBom {
    return resolveInConfig(config, pair.sizeOptionId, pair.colourOptionId);
  }

  /** Resolve with memo. Validates ownership and kind (404/400), not activity. */
  async resolve(productId: string, pair: OptionPair, ctx?: CatalogRequestContext, db?: Db): Promise<ResolvedBom> {
    const key = pairKey(productId, pair.sizeOptionId, pair.colourOptionId);
    const hit = ctx?.boms.get(key) as ResolvedBom | undefined;
    if (hit) return hit;
    const config = await this.requireConfig(productId, ctx, db);
    const bom = this.resolveWithConfig(config, pair);
    ctx?.boms.set(key, bom);
    return bom;
  }

  /** The context validatePair/colourOffered need, built on the same resolver pass. */
  pairContext(config: ProductConfig): PairContext {
    const mixed = standardMixedWarnings(config).length > 0;
    const memo = new Map<string, string[]>();
    return {
      config,
      standardColourMixed: mixed,
      colourWarningCodes: (sizeOptionId, colourOptionId) => {
        const k = `${sizeOptionId ?? ''}|${colourOptionId}`;
        let codes = memo.get(k);
        if (!codes) {
          codes = resolveInConfig(config, sizeOptionId, colourOptionId).warnings.map((w) => w.code);
          memo.set(k, codes);
        }
        return codes;
      },
    };
  }

  /** Batch-load option rows by id (any product) into the context. */
  async preloadVariants(ids: Iterable<string>, ctx: CatalogRequestContext, db?: Db): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => id && !ctx.variants.has(id));
    if (!missing.length) return;
    const rows = await (db ?? this.prisma).productVariant.findMany({
      where: { id: { in: missing } },
      select: { id: true, productId: true, kind: true, name: true },
    });
    for (const id of missing) ctx.variants.set(id, null);
    for (const r of rows) ctx.variants.set(r.id, r as VariantLite);
  }

  /** Batch-load order lines (for pre-release order jobs, §3.2) into the context. */
  async preloadOrderItems(ids: Iterable<string>, ctx: CatalogRequestContext, db?: Db): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => id && !ctx.orderItems.has(id));
    if (!missing.length) return;
    const rows = await (db ?? this.prisma).orderItem.findMany({
      where: { id: { in: missing } },
      select: { id: true, variantId: true, sizeOptionId: true, colourOptionId: true },
    });
    for (const id of missing) ctx.orderItems.set(id, null);
    for (const r of rows) ctx.orderItems.set(r.id, r);
    await this.preloadVariants(rows.map((r) => r.variantId).filter((v): v is string => !!v), ctx, db);
  }

  /** effectiveOptions over the context's preloaded rows (call the preloads first). */
  effectiveOptions(row: PairRow, ctx: CatalogRequestContext) {
    return effectiveOptions(row, {
      variant: (id) => ctx.variants.get(id) ?? null,
      orderItem: (id) => ctx.orderItems.get(id) ?? null,
    });
  }

  /**
   * Resolve an EXISTING line or job (§3.2 "Existing order and quote lines"). Never
   * throws: a line whose product or option is gone, or points at another
   * product, is skipped with a warning. Inactive products and options never skip.
   * `where` names the document in the message, e.g. "Order ORD-0107".
   */
  async resolveForLine(line: ExistingLine, where: string, ctx: CatalogRequestContext, db?: Db): Promise<LineResolution> {
    const desc = line.description ?? '';
    const warn = (code: string, tail: string): LineResolution => ({
      skip: true,
      warning: { code, message: `${where} line "${desc}": ${tail}` },
    });
    try {
      if (!line.productId) return warn('LINE_PRODUCT_MISSING', 'product no longer exists — skipped');
      const config = await this.loadConfig(line.productId, ctx, db);
      if (!config) return warn('LINE_PRODUCT_MISSING', 'product no longer exists — skipped');

      const ids = [line.variantId, line.sizeOptionId, line.colourOptionId].filter((x): x is string => !!x);
      await this.preloadVariants(ids, ctx, db);
      if (line.orderItemId) await this.preloadOrderItems([line.orderItemId], ctx, db);
      const eff = this.effectiveOptions(line, ctx);
      if (eff.skip) return warn('LINE_OPTION_MISSING', 'its size or colour no longer exists — skipped');

      for (const [id, want] of [[eff.sizeOptionId, 'SIZE'], [eff.colourOptionId, 'COLOUR']] as const) {
        if (!id) continue;
        const v = ctx.variants.get(id);
        if (!v) return warn('LINE_OPTION_MISSING', 'its size or colour no longer exists — skipped');
        if (v.productId !== config.product.id) return warn('LINE_OPTION_MISMATCH', 'its size or colour belongs to another product — skipped');
        if (v.kind !== want) {
          return warn('LINE_OPTION_KIND_MISMATCH', `"${v.name ?? id}" is no longer a ${want === 'SIZE' ? 'size' : 'colour'} — skipped`);
        }
      }
      const pair = { sizeOptionId: eff.sizeOptionId, colourOptionId: eff.colourOptionId };
      const bom = await this.resolve(config.product.id, pair, ctx, db);
      return { skip: false, bom, pair, legacy: eff.legacy };
    } catch (e) {
      return warn('LINE_OPTION_MISSING', `couldn't be resolved (${(e as Error).message}) — skipped`);
    }
  }
}
