import { Injectable } from '@nestjs/common';
import type { OptionCost } from '@printforge/types';
import { BomResolverService } from '../catalog-core/bom-resolver.service';
import { optionsOfKind, type OptionRow, type ProductConfig } from '../catalog-core/catalog-config';
import { CatalogRequestContext } from '../catalog-core/catalog-context';
import { likelyColour } from '../catalog-core/colour-words';
import { round3 } from '../catalog-core/cost-engine';
import { PricingService } from '../catalog-core/pricing.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { assessCalibration } from '../products/plate-layout-backfill.service';

/**
 * WP11 price-impact report (spec §6 WP11, §7.3 "Before merge" step 3).
 *
 * READ-ONLY: every query here is a find/count. Run it against a restored copy
 * of production after `prisma db push` and BEFORE the new API has booted (so
 * the boot backfills haven't run). The CLI (`price-impact-report.main.ts`)
 * additionally puts the one database connection in read-only mode.
 *
 * Five CSV sections: prices, existing variants (+ per-product summary),
 * suspect lines, BF-1 layout dry run, stock to confirm.
 */

export type Cell = string | number | boolean | null | undefined;
export interface Section {
  name: string;
  header: string[];
  rows: Cell[][];
}

export interface ReportOptions {
  /** |deltaPct| above this is flagged DROP / RISE (default 10) */
  thresholdPct?: number;
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const same = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) < 0.0005;
const money = (x: number | null | undefined) => (x === null || x === undefined ? '' : x.toFixed(3));

@Injectable()
export class PriceImpactReport {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: BomResolverService,
    private readonly pricing: PricingService,
  ) {}

  async build(opts: ReportOptions = {}): Promise<Section[]> {
    const threshold = opts.thresholdPct ?? 10;
    const ctx = new CatalogRequestContext();
    const db = this.prisma as any;
    const products: Array<{ id: string; name: string; isActive: boolean }> = await db.product.findMany({
      select: { id: true, name: true, isActive: true },
      orderBy: { name: 'asc' },
    });
    const configs = new Map<string, ProductConfig>();
    for (const p of products) {
      const c = await this.resolver.loadConfig(p.id, ctx);
      if (c) configs.set(p.id, c);
    }
    const settings = await this.pricing.settings(ctx);
    const materials: Array<{ name: string; color: string | null }> = await db.material.findMany({ select: { name: true, color: true } });

    const orderItems: any[] = await db.orderItem.findMany({ select: { id: true, productId: true, variantId: true, sizeOptionId: true, colourOptionId: true } });
    const quoteItems: any[] = await db.quoteItem.findMany({ select: { id: true, productId: true, sizeOptionId: true, colourOptionId: true } });
    const jobs: any[] = await db.productionJob.findMany({ select: { id: true, variantId: true, sizeOptionId: true, colourOptionId: true } });

    const prices = await this.prices(products, configs, ctx, settings, threshold);
    const variants = this.variants(configs, materials, orderItems, quoteItems, jobs);
    const suspect = await this.suspectLines(configs, orderItems, quoteItems);
    const layouts = await this.layoutDryRun();
    const stock = this.stockToConfirm(configs, materials, jobs);
    return [prices, ...variants, suspect, layouts, stock];
  }

  // ---- 1. prices ---------------------------------------------------------

  private async prices(
    products: Array<{ id: string; name: string }>,
    configs: Map<string, ProductConfig>,
    ctx: CatalogRequestContext,
    settings: { purgeWasteGrams: number; overheadPercent: number },
    threshold: number,
  ): Promise<Section> {
    const rows: Cell[][] = [];
    for (const p of products) {
      const config = configs.get(p.id);
      if (!config) continue;
      const costs = await this.pricing.optionCosts(p.id, ctx);
      const sizes: Array<OptionRow | null> = [null, ...optionsOfKind(config, 'SIZE')];
      costs.forEach((oc, i) => {
        const size = sizes[i] ?? null;
        const stored = oc.storedPrice;
        const next = oc.computedPrice;
        const delta = stored !== null && stored > 0 && next !== null ? round1(((next - stored) / stored) * 100) : null;
        const flag = delta === null ? '' : delta < -threshold ? 'DROP' : delta > threshold ? 'RISE' : '';
        rows.push([
          p.id,
          p.name,
          size ? size.name : config.product.baseOptionLabel ?? 'Standard',
          money(stored),
          money(oc.perUnit?.total),
          money(next),
          delta,
          oc.complete,
          oc.problems.map((x) => x.code).join('|'),
          flag,
          likelyCauses(config, oc, settings, delta, threshold).join(' + '),
        ]);
      });
    }
    return {
      name: 'prices',
      header: ['productId', 'product', 'size', 'storedPrice', 'newCost', 'newPrice', 'deltaPct', 'complete', 'problems', 'flag', 'likelyCause'],
      rows,
    };
  }

  // ---- 2. existing variants + per-product summary ------------------------

  private variants(
    configs: Map<string, ProductConfig>,
    materials: Array<{ name: string; color: string | null }>,
    orderItems: any[],
    quoteItems: any[],
    jobs: any[],
  ): Section[] {
    const refs = (rows: any[], id: string, cols: string[]) => rows.filter((r) => cols.some((c) => r[c] === id)).length;
    const rows: Cell[][] = [];
    const summary: Cell[][] = [];
    for (const config of configs.values()) {
      const product = config.product;
      if (!config.options.length) continue;
      const hasBase = config.components.some((c) => c.variantId === null);
      let sizes = 0;
      let colours = 0;
      const changes: string[] = [];
      for (const v of config.options) {
        const colourish = likelyColour(v.name, materials);
        const suggested = colourish || (same(v.basePrice, product.basePrice) && hasBase) ? 'COLOUR' : 'SIZE';
        if (suggested === 'COLOUR') {
          colours++;
          if (v.basePrice !== null && !same(v.basePrice, product.basePrice)) {
            changes.push(`"${v.name}" ${money(v.basePrice)} → ${money(product.basePrice)} in the shop after classification`);
          }
        } else sizes++;
        rows.push([
          product.id,
          product.name,
          v.id,
          v.name,
          v.isActive,
          money(v.basePrice),
          v.basePrice === null,
          money(product.basePrice),
          refs(orderItems, v.id, ['variantId', 'sizeOptionId', 'colourOptionId']),
          refs(quoteItems, v.id, ['sizeOptionId', 'colourOptionId']),
          refs(jobs, v.id, ['variantId', 'sizeOptionId', 'colourOptionId']),
          hasBase,
          colourish,
          suggested,
          v.kind,
        ]);
      }
      summary.push([product.id, product.name, sizes, colours, changes.join('; ')]);
    }
    return [
      {
        name: 'existing variants',
        header: ['productId', 'product', 'variantId', 'variant', 'isActive', 'storedPrice', 'priceIsNull', 'standardPrice', 'orderLines', 'quoteLines', 'jobs', 'hasBaseComponents', 'likelyColour', 'suggestedKind', 'currentKind'],
        rows,
      },
      {
        name: 'existing variants: per-product summary',
        header: ['productId', 'product', 'sizesIfClassified', 'coloursIfClassified', 'shopPriceChanges'],
        rows: summary,
      },
    ];
  }

  // ---- 3. suspect lines --------------------------------------------------

  private async suspectLines(configs: Map<string, ProductConfig>, orderItems: any[], quoteItems: any[]): Promise<Section> {
    const db = this.prisma as any;
    const optionProduct = new Map<string, string>();
    for (const c of configs.values()) for (const o of c.options) optionProduct.set(o.id, o.productId);
    // Options of products that no longer exist can't be in `configs`; look them up directly.
    const ids = new Set<string>();
    for (const r of [...orderItems, ...quoteItems]) for (const k of ['variantId', 'sizeOptionId', 'colourOptionId']) if (r[k] && !optionProduct.has(r[k])) ids.add(r[k]);
    if (ids.size) {
      const extra: any[] = await db.productVariant.findMany({ where: { id: { in: [...ids] } }, select: { id: true, productId: true } });
      for (const v of extra) optionProduct.set(v.id, v.productId);
    }
    const buckets = new Map<string, string[]>();
    const add = (table: string, reason: string, id: string) => {
      const k = `${table}|${reason}`;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k)!.push(id);
    };
    const check = (table: string, r: any) => {
      if (r.productId && !configs.has(r.productId)) add(table, 'PRODUCT_MISSING', r.id);
      for (const k of ['variantId', 'sizeOptionId', 'colourOptionId']) {
        const id = r[k];
        if (!id) continue;
        const owner = optionProduct.get(id);
        if (!owner) add(table, `OPTION_MISSING (${k})`, r.id);
        else if (r.productId && owner !== r.productId) add(table, `OPTION_OF_ANOTHER_PRODUCT (${k})`, r.id);
      }
    };
    for (const r of orderItems) check('OrderItem', r);
    for (const r of quoteItems) check('QuoteItem', r);
    const rows: Cell[][] = [...buckets.entries()].map(([k, list]) => {
      const [table, reason] = k.split('|');
      return [table, reason, list.length, list.join(' ')];
    });
    return { name: 'suspect lines (skipped with warnings, never repaired)', header: ['table', 'reason', 'count', 'ids'], rows };
  }

  // ---- 4. BF-1 dry run ---------------------------------------------------

  private async layoutDryRun(): Promise<Section> {
    const db = this.prisma as any;
    const comps: any[] = await db.productComponent.findMany({
      where: { platedMigratedAt: null, platedUnits: { not: null } },
      orderBy: { id: 'asc' },
      include: {
        materials: true,
        plateLayouts: { select: { unitsPerPlate: true, isActive: true } },
        product: { select: { name: true } },
        variant: { select: { name: true } },
      },
    });
    const rows: Cell[][] = comps.map((c) => {
      const a = assessCalibration(c);
      const base = [c.productId, c.product?.name ?? '', c.variant?.name ?? 'Standard', c.id, c.description, c.platedUnits, c.platedMinutes, c.platedGrams];
      if (a.outcome === 'OUT_OF_RANGE') return [...base, 'SKIP', 'out of range or incomplete — no layout'];
      if ((c.plateLayouts ?? []).some((l: any) => l.isActive && l.unitsPerPlate === a.units)) return [...base, 'SKIP', 'layout exists'];
      return a.isActive ? [...base, 'ACTIVE', `×${a.units} layout, ${a.minutes} min, ${a.grams} g`] : [...base, 'INACTIVE_REVIEW', a.note];
    });
    rows.sort((x, y) => rank(x[8]) - rank(y[8]));
    return {
      name: 'BF-1 plate layouts (dry run; INACTIVE_REVIEW rows need the owner after deploy)',
      header: ['productId', 'product', 'size', 'componentId', 'component', 'platedUnits', 'platedMinutes', 'platedGrams', 'outcome', 'note'],
      rows,
    };
  }

  // ---- 5. stock to confirm -----------------------------------------------

  private stockToConfirm(configs: Map<string, ProductConfig>, materials: Array<{ name: string; color: string | null }>, jobs: any[]): Section {
    const rows: Cell[][] = [];
    for (const config of configs.values()) {
      const legacyColourOptions = config.options.filter(
        (o) => likelyColour(o.name, materials) && jobs.some((j) => j.variantId === o.id && !j.sizeOptionId && !j.colourOptionId),
      );
      for (const c of config.components) {
        if (!(c.stockOnHand > 0)) continue;
        const size = c.variantId ? config.options.find((o) => o.id === c.variantId)?.name ?? c.variantId : config.product.baseOptionLabel ?? 'Standard';
        rows.push([
          config.product.id,
          config.product.name,
          c.id,
          c.description,
          size,
          c.stockOnHand,
          c.stockConfirmedAt !== null,
          legacyColourOptions.length > 0,
          legacyColourOptions.map((o) => o.name).join('; '),
        ]);
      }
    }
    return {
      name: 'stock to confirm (every column is unconfirmed at deploy)',
      header: ['productId', 'product', 'componentId', 'component', 'size', 'stockOnHand', 'confirmed', 'mayMixColours', 'colourLikeOptionsOnOldJobs'],
      rows,
    };
  }
}

const rank = (outcome: Cell) => ({ INACTIVE_REVIEW: 0, SKIP: 1, ACTIVE: 2 } as Record<string, number>)[String(outcome)] ?? 3;

/**
 * Known reasons a size's price moves under the new cost engine (spec §0.1, §3.8, R1).
 * Heuristic, for the owner's review only.
 */
export function likelyCauses(
  config: ProductConfig,
  oc: OptionCost,
  settings: { purgeWasteGrams: number; overheadPercent: number },
  delta: number | null,
  threshold: number,
): string[] {
  const out: string[] = [];
  if (oc.fallbackToBase) out.push('legacy size without its own components: price not recomputed (kept as stored)');
  if (!oc.complete) out.push(`incomplete cost inputs (${oc.problems.map((p) => p.code).join(', ')}): stored price kept`);
  const changes = config.product.colorChanges;
  if (oc.purge.basis === 'SLICER_INCLUDED' && changes > 0 && oc.perUnit) {
    const grams = oc.materials.reduce((s, m) => s + m.grams, 0);
    const perGram = grams > 0 ? oc.perUnit.material / grams : 0;
    const removedGrams = changes * settings.purgeWasteGrams;
    const removedPrice = round3(removedGrams * perGram * (1 + settings.overheadPercent / 100) * oc.markup.multiplier);
    out.push(`purge no longer double-counted: slicer grams already include flush/prime tower; the old formula added ${removedGrams} g/unit (≈${removedPrice.toFixed(3)} of price)`);
  }
  if (oc.materials.length > 1) out.push('multicolour: material cost now weighted per filament (was an average)');
  if (!out.length && delta !== null && Math.abs(delta) > threshold) {
    out.push('stored price was stale or set by hand (filament cost, settings or printer changed since the last calculation, or Excel BOM upload)');
  }
  return out;
}

// ---- CSV -----------------------------------------------------------------

/** One CSV value. Text that a spreadsheet would run as a formula is prefixed with '. */
export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  let s = v;
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(sections: Section[]): string {
  const out: string[] = [];
  for (const s of sections) {
    out.push(`# section: ${s.name} (${s.rows.length} rows)`);
    out.push(s.header.map(csvCell).join(','));
    for (const r of s.rows) out.push(r.map(csvCell).join(','));
    out.push('');
  }
  return out.join('\n');
}
