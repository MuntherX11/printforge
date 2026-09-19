import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { BulkFloor, CellCost, OptionCost, PriceSource, Problem } from '@printforge/types';
import { PrismaService } from '../common/prisma/prisma.service';
import { CostingService, type CostSettings } from '../costing/costing.service';
import { BomResolverService } from './bom-resolver.service';
import { optionsOfKind, type OptionRow, type ProductConfig } from './catalog-config';
import { CatalogRequestContext } from './catalog-context';
import { costEngine, round3 } from './cost-engine';
import { lineDescription, mapLegacyVariantId, pairLabel, stripHtml, validatePair, withLineNote, type Audience } from './option-pair';
import {
  bulkFloorOf, cellCostsOf, colourCostWarnings, computeCostVersion, optionCostOf, printerOf, storedPriceOf,
} from './pricing-core';

/**
 * Prices, tiers, line pricing and cost views (spec §3.8, §3.9, §4.1.2).
 * Colour never changes a price: every size has one price, computed on its
 * standard colour; colours only change cost and margin.
 */

export interface LineInput {
  productId?: string | null;
  sizeOptionId?: string | null;
  colourOptionId?: string | null;
  /** legacy request only (§3.1 rule 13) */
  variantId?: string | null;
  quantity: unknown;
  unitPrice?: unknown;
  priceOverride?: boolean;
  overrideReason?: string | null;
  description?: string | null;
}

export interface ResolvedLine {
  index: number;
  productId: string | null;
  sizeOptionId: string | null;
  colourOptionId: string | null;
  /** OrderItem mirror: sizeOptionId ?? colourOptionId */
  variantId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  listUnitPrice: number | null;
  priceSource: PriceSource;
  tierMinQty: number | null;
  priceOverrideReason: string | null;
  tierQuantity: number | null;
  tierLineCount: number | null;
  tierSizeLabel: string | null;
  floor: number | null;
  warnings: Problem[];
}

type Tier = { minQty: number; unitPrice: number };
type Db = Pick<PrismaService, 'product' | 'productVariant' | 'orderItem' | 'priceTier' | 'variantPriceTier'>;

const QTY_MAX = 100_000;
const PRICE_MAX = 1_000_000;

function lineQuantity(raw: unknown, prefix: string): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (typeof raw === 'boolean' || raw === null || raw === '' || !Number.isInteger(n) || n < 1 || n > QTY_MAX) {
    throw new BadRequestException(`${prefix}quantity must be a whole number from 1 to 100000`);
  }
  return n;
}

function linePrice(raw: unknown, prefix: string): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > PRICE_MAX) {
    throw new BadRequestException(`${prefix}price must be a number from 0 to 1000000`);
  }
  return round3(n);
}

@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: BomResolverService,
    private readonly costing: CostingService,
  ) {}

  /** Settings once per request (§0.2). */
  settings(ctx: CatalogRequestContext): Promise<CostSettings> {
    if (!ctx.settings) ctx.settings = this.costing.loadSettings();
    return ctx.settings;
  }

  /** Tiers of a size (§3.9): PriceTier for the standard size, VariantPriceTier for a size. Colours have none. */
  async tiersFor(productId: string, sizeOptionId: string | null, db: Db = this.prisma): Promise<Tier[]> {
    if (sizeOptionId) {
      const v = await db.productVariant.findUnique({ where: { id: sizeOptionId }, select: { id: true, productId: true, kind: true } });
      if (!v || v.productId !== productId) throw new NotFoundException('Option not found');
      if (v.kind === 'COLOUR') throw new BadRequestException("Colours share their size's tiers — set tiers on the size");
      const rows = await db.variantPriceTier.findMany({ where: { variantId: sizeOptionId }, orderBy: { minQty: 'asc' } });
      return rows.map((r) => ({ minQty: r.minQty, unitPrice: r.unitPrice }));
    }
    const rows = await db.priceTier.findMany({ where: { productId }, orderBy: { minQty: 'asc' } });
    return rows.map((r) => ({ minQty: r.minQty, unitPrice: r.unitPrice }));
  }

  /**
   * Price a whole order or quote at once (§3.9 "Line resolution"), because tiers
   * count across lines of the same product and size. Runs inside the caller's
   * transaction (after its FOR SHARE locks) when `db` is a transaction client.
   */
  async resolveLines(
    lines: LineInput[],
    opts: { audience: Audience; allowInactive?: boolean; db?: Db; ctx?: CatalogRequestContext },
  ): Promise<ResolvedLine[]> {
    const db = opts.db ?? this.prisma;
    const ctx = opts.ctx ?? new CatalogRequestContext();
    const settings = await this.settings(ctx);
    await this.resolver.preloadVariants(lines.map((l) => l.variantId).filter((v): v is string => !!v), ctx, db as any);

    type Pending = { idx: number; prefix: string; line: LineInput; quantity: number; config: ProductConfig | null; size: OptionRow | null; colour: OptionRow | null; tierKey: string | null };
    const pending: Pending[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const prefix = `Line ${i + 1}: `;
      const quantity = lineQuantity(line.quantity, prefix);
      const hasOption = !!(line.sizeOptionId || line.colourOptionId || line.variantId);
      if (!line.productId && hasOption) {
        const customerLegacy = opts.audience === 'CUSTOMER' && line.variantId && !line.sizeOptionId && !line.colourOptionId;
        if (!customerLegacy) throw new BadRequestException(`${prefix}choose the product for this size or colour`);
      }
      if (!line.productId && !line.variantId) {
        pending.push({ idx: i, prefix, line, quantity, config: null, size: null, colour: null, tierKey: null });
        continue;
      }
      const mapped = mapLegacyVariantId(line, (id) => ctx.variants.get(id) ?? null, prefix);
      const config = mapped.productId ? await this.resolver.loadConfig(mapped.productId, ctx, db as any) : null;
      if (!config) throw new BadRequestException(`${prefix}product not found`);
      const pc = this.resolver.pairContext(config);
      const { size, colour } = validatePair(pc, mapped.sizeOptionId, mapped.colourOptionId, { audience: opts.audience, allowInactive: opts.allowInactive, prefix });
      pending.push({ idx: i, prefix, line, quantity, config, size, colour, tierKey: `tier:${config.product.id}:${size?.id ?? 'standard'}` });
    }

    const tierQty = new Map<string, { qty: number; lines: number }>();
    for (const p of pending) {
      if (!p.tierKey) continue;
      const t = tierQty.get(p.tierKey) ?? { qty: 0, lines: 0 };
      t.qty += p.quantity;
      t.lines += 1;
      tierQty.set(p.tierKey, t);
    }
    const tierCache = new Map<string, Tier[]>();

    const out: ResolvedLine[] = [];
    for (const p of pending) {
      const { line, prefix, quantity } = p;
      const warnings: Problem[] = [];
      if (!p.config) {
        // Custom line (§3.9 step 2)
        const unitPrice = linePrice(line.unitPrice, prefix);
        const description = stripHtml(String(line.description ?? '')).trim().slice(0, 200);
        if (!description) throw new BadRequestException(`${prefix}description is required`);
        out.push({
          index: p.idx, productId: null, sizeOptionId: null, colourOptionId: null, variantId: null, description, quantity,
          unitPrice, totalPrice: round3(quantity * unitPrice), listUnitPrice: null, priceSource: 'MANUAL', tierMinQty: null,
          priceOverrideReason: null, tierQuantity: null, tierLineCount: null, tierSizeLabel: null, floor: null, warnings,
        });
        continue;
      }
      const config = p.config;
      const { size, colour } = p;
      const label = pairLabel(config, size, colour);

      // List price (colour never enters it)
      let listUnitPrice = storedPriceOf(config, size);
      if (size && (listUnitPrice === null || listUnitPrice === undefined) && opts.audience === 'STAFF') {
        listUnitPrice = config.product.basePrice;
        warnings.push({ code: 'OPTION_NOT_SET_UP', message: `"${size.name}" has no price of its own — using the standard price` });
      }

      // Tier (staff only)
      let tier: Tier | null = null;
      const tq = tierQty.get(p.tierKey!)!;
      if (opts.audience === 'STAFF') {
        let tiers = tierCache.get(p.tierKey!);
        if (!tiers) {
          tiers = await this.tiersFor(config.product.id, size?.id ?? null, db);
          tierCache.set(p.tierKey!, tiers);
        }
        for (const t of tiers) if (t.minQty <= tq.qty && (!tier || t.minQty > tier.minQty)) tier = t;
      }
      const autoUnitPrice = tier?.unitPrice ?? listUnitPrice;
      let unitPrice: number;
      let priceSource: PriceSource = tier ? 'TIER' : size ? 'SIZE' : 'BASE';
      let priceOverrideReason: string | null = null;
      if (line.priceOverride === true && opts.audience === 'STAFF') {
        unitPrice = linePrice(line.unitPrice, prefix);
        priceSource = 'MANUAL';
        const reason = String(line.overrideReason ?? '').trim().slice(0, 200);
        priceOverrideReason = reason || null;
      } else {
        if (autoUnitPrice === null || autoUnitPrice === undefined || !(autoUnitPrice > 0)) {
          throw new BadRequestException(opts.audience === 'CUSTOMER' ? `${prefix}"${label}" can't be ordered yet` : `${prefix}"${label}" has no price — enter a price to override`);
        }
        unitPrice = round3(autoUnitPrice);
      }

      // Floor: the pair's own cost at the line's quantity
      const bom = await this.resolver.resolve(config.product.id, { sizeOptionId: size?.id ?? null, colourOptionId: colour?.id ?? null }, ctx, db as any);
      let floor: number | null = null;
      if (bom.complete) {
        const r = costEngine.costForQuantity(bom, quantity, settings, printerOf(config), ctx.planCache);
        if (r.complete) floor = r.unit;
      }
      if (opts.audience === 'STAFF') {
        if (floor === null) warnings.push({ code: 'BOM_INCOMPLETE', message: `${prefix}the cost of "${label}" can't be computed — check its components` });
        else if (unitPrice < floor) warnings.push({ code: 'BELOW_COST', message: `${prefix}${unitPrice.toFixed(3)} is below the cost of ${floor.toFixed(3)}` });
        else if (unitPrice > 0 && ((unitPrice - floor) / unitPrice) * 100 < settings.thinMarginPercent) {
          warnings.push({ code: 'THIN_MARGIN', message: `${prefix}margin under ${settings.thinMarginPercent} % (cost ${floor.toFixed(3)})` });
        }
        if (listUnitPrice !== null && unitPrice > listUnitPrice) warnings.push({ code: 'ABOVE_LIST', message: `${prefix}${unitPrice.toFixed(3)} is above the list price ${listUnitPrice.toFixed(3)}` });
        for (const w of bom.warnings) if (w.code === 'COLOUR_OPTION_NOT_SET_UP') warnings.push(w);
      }

      const descLabel = lineDescription(config.product, size, colour);
      out.push({
        index: p.idx,
        productId: config.product.id,
        sizeOptionId: size?.id ?? null,
        colourOptionId: colour?.id ?? null,
        variantId: size?.id ?? colour?.id ?? null,
        description: opts.audience === 'CUSTOMER' ? descLabel : withLineNote(descLabel, line.description),
        quantity,
        unitPrice,
        totalPrice: round3(quantity * unitPrice),
        listUnitPrice: listUnitPrice ?? null,
        priceSource,
        tierMinQty: tier?.minQty ?? null,
        priceOverrideReason,
        tierQuantity: opts.audience === 'STAFF' ? tq.qty : null,
        tierLineCount: opts.audience === 'STAFF' ? tq.lines : null,
        tierSizeLabel: size ? size.name : config.product.baseOptionLabel || 'Standard',
        floor,
        warnings,
      });
    }
    return out;
  }

  /** OptionCost per size on its standard colour (the Pricing card). */
  async optionCosts(productId: string, ctx = new CatalogRequestContext()): Promise<OptionCost[]> {
    const config = await this.resolver.requireConfig(productId, ctx);
    const settings = await this.settings(ctx);
    const sizes: Array<OptionRow | null> = [null, ...optionsOfKind(config, 'SIZE')];
    return sizes.map((s) => this.optionCostIn(config, s?.id ?? null, null, settings));
  }

  /** OptionCost of any pair. */
  async optionCost(productId: string, sizeOptionId: string | null, colourOptionId: string | null, ctx = new CatalogRequestContext()): Promise<OptionCost> {
    const config = await this.resolver.requireConfig(productId, ctx);
    return this.optionCostIn(config, sizeOptionId, colourOptionId, await this.settings(ctx));
  }

  private optionCostIn(config: ProductConfig, sizeOptionId: string | null, colourOptionId: string | null, settings: CostSettings): OptionCost {
    const bom = this.resolver.resolveWithConfig(config, { sizeOptionId, colourOptionId });
    return optionCostOf(config, bom, costEngine.unitCostAtOne(bom, settings, printerOf(config)), settings);
  }

  /** Every size × colour cell (display and floors only; nothing stored). */
  async cellCosts(productId: string, ctx = new CatalogRequestContext()): Promise<{ cells: CellCost[]; warnings: Problem[]; costVersion: string }> {
    const config = await this.resolver.requireConfig(productId, ctx);
    const settings = await this.settings(ctx);
    const grid = cellCostsOf(config, this.resolver.pairContext(config), settings);
    return { cells: grid.cells, warnings: colourCostWarnings(grid.cells), costVersion: computeCostVersion(config, settings) };
  }

  async costVersion(productId: string, ctx = new CatalogRequestContext()): Promise<string> {
    const config = await this.resolver.requireConfig(productId, ctx);
    return computeCostVersion(config, await this.settings(ctx));
  }

  /** Cost floor per tier band of a size (P18). Defaults to the size's own tier minimums. */
  async bulkFloor(productId: string, sizeOptionId: string | null, minQtys?: number[], ctx = new CatalogRequestContext()): Promise<BulkFloor> {
    const config = await this.resolver.requireConfig(productId, ctx);
    const qtys = minQtys ?? (await this.tiersFor(productId, sizeOptionId)).map((t) => t.minQty);
    if (sizeOptionId) {
      const s = config.options.find((o) => o.id === sizeOptionId);
      if (!s) throw new NotFoundException('Size not found');
      if (s.kind !== 'SIZE') throw new BadRequestException("Colours share their size's tiers — set tiers on the size");
    }
    return bulkFloorOf(config, sizeOptionId, qtys, await this.settings(ctx), ctx.planCache);
  }

  /**
   * Write prices (§3.8 "Price application"): the standard size and every SIZE,
   * each from its standard colour. Never from an incomplete BOM (the stored price
   * stays), never for a colour, and a size without components of its own keeps
   * its legacy values.
   */
  async recalcPricing(productId: string, db: Pick<PrismaService, 'product' | 'productVariant'> = this.prisma, ctx = new CatalogRequestContext()) {
    const config = await this.resolver.requireConfig(productId, ctx, db as any);
    const settings = await this.settings(ctx);
    const printer = printerOf(config);
    const results: Array<{ sizeOptionId: string | null; written: boolean; price: number | null; problems: Problem[] }> = [];
    for (const size of [null, ...optionsOfKind(config, 'SIZE')]) {
      const bom = this.resolver.resolveWithConfig(config, { sizeOptionId: size?.id ?? null, colourOptionId: null });
      if (size && bom.fallbackToBase) {
        results.push({ sizeOptionId: size.id, written: false, price: null, problems: bom.problems });
        continue;
      }
      const cost = costEngine.unitCostAtOne(bom, settings, printer);
      const estimatedGrams = round3(bom.components.reduce((s, c) => s + c.quantity * c.gramsPerUnit, 0));
      const estimatedMinutes = round3(bom.components.reduce((s, c) => s + c.quantity * c.minutesPerUnit, 0));
      const price = cost.complete ? round3(cost.unit * cost.markup.multiplier) : null;
      const data: Record<string, number> = { estimatedGrams, estimatedMinutes };
      if (price !== null) data.basePrice = price;
      if (size) await db.productVariant.update({ where: { id: size.id }, data });
      else await db.product.update({ where: { id: productId }, data });
      results.push({ sizeOptionId: size?.id ?? null, written: price !== null, price, problems: cost.problems });
    }
    return results;
  }
}
