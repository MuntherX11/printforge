import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { MaterialLite, OptionCost, ProductDetail } from '@printforge/types';
import * as ExcelJS from 'exceljs';
import { BomResolverService } from '../catalog-core/bom-resolver.service';
import { PRODUCT_CONFIG_INCLUDE, toProductConfig } from '../catalog-core/catalog-config';
import { CatalogRequestContext } from '../catalog-core/catalog-context';
import { validatePair } from '../catalog-core/option-pair';
import { PricingService } from '../catalog-core/pricing.service';
import { ProductionPlannerService } from '../catalog-core/production-planner.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { paginatedResponse } from '../common/dto/pagination.dto';
import { PartsService } from '../parts/parts.service';
import { parseColourKey } from '../stock-ledger/colour-key';
import { activeProductView, catalogDetailView, catalogProductView } from './product-catalog-views';
import { buildProductDetail, coverUrl, DETAIL_INCLUDE, type AttachmentLite } from './product-detail';
import { containedUploadPath } from './product-images.service';
import {
  parseMinQtys, parsePage, pairParam, parseProductCreate, parseProductPatch, parseReadinessQty, parseTiers, rejectStaleQuery,
} from './product-input';
import { assertSkuFree, lockOptions, lockProduct, photoPaths, productHistory, TX_OPTS, unlinkAfterCommit } from './product-locks';

/**
 * Products API, product level (spec §4.1 P1–P8, P16–P21). Components live in
 * ProductComponentsService, options in VariantsService, colour slots in
 * ColourSlotsService. Prices are always automatic (cost × markup): nothing here
 * accepts a price, and PricingService never writes one from an incomplete BOM.
 */
@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: BomResolverService,
    private readonly pricing: PricingService,
    private readonly planner: ProductionPlannerService,
    private readonly parts: PartsService,
  ) {}

  /** Recalculate prices after a commit; a failure is logged, never thrown at the caller. */
  async reprice(productId: string): Promise<void> {
    try {
      await this.pricing.recalcPricing(productId);
    } catch (e) {
      this.logger.warn(`Repricing ${productId} failed: ${(e as Error)?.message}`);
    }
  }

  async create(body: unknown): Promise<ProductDetail> {
    const input = parseProductCreate(body);
    await assertSkuFree(this.prisma, input.sku);
    await this.assertPrinter(input.defaultPrinterId);
    const p = await this.prisma.product.create({ data: input as any, select: { id: true } });
    return this.findOne(p.id);
  }

  private async assertPrinter(id: string | null | undefined) {
    if (!id) return;
    const printer = await this.prisma.printer.findUnique({ where: { id }, select: { id: true } });
    if (!printer) throw new BadRequestException('Unknown printer');
  }

  /** P1: flat list, or paginated when `page` is given. */
  async list(rawPage?: unknown, rawLimit?: unknown) {
    const include = { _count: { select: { components: true } }, images: true, variants: { select: { kind: true, isActive: true } } } as const;
    const shape = (rows: any[]) =>
      rows.map(({ images, variants, ...p }) => ({
        ...p,
        coverImageUrl: coverUrl(p.id, images),
        sizeCount: variants.filter((v: any) => v.kind === 'SIZE' && v.isActive).length,
        colourCount: variants.filter((v: any) => v.kind === 'COLOUR' && v.isActive).length,
      }));
    if (rawPage === undefined) {
      return shape(await this.prisma.product.findMany({ orderBy: { name: 'asc' }, include }));
    }
    const { page, limit } = parsePage(rawPage, rawLimit);
    const [data, total] = await Promise.all([
      this.prisma.product.findMany({ orderBy: { name: 'asc' }, include, take: limit, skip: (page - 1) * limit }),
      this.prisma.product.count(),
    ]);
    return paginatedResponse(shape(data), total, { page, limit } as any);
  }

  /** P2: staff pickers. */
  async active() {
    const rows = await this.prisma.product.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      include: { ...PRODUCT_CONFIG_INCLUDE, priceTiers: { orderBy: { minQty: 'asc' } } } as any,
    });
    return rows.map((raw: any) => {
      const config = toProductConfig(raw);
      return activeProductView(raw, config, this.resolver.pairContext(config));
    });
  }

  /** P3: customer grid. */
  async catalog() {
    const rows = await this.prisma.product.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      include: { ...PRODUCT_CONFIG_INCLUDE, images: true } as any,
    });
    return rows.map((raw: any) => catalogProductView(raw, toProductConfig(raw))).filter((x) => x !== null);
  }

  /** P4: customer product page. */
  async catalogDetail(id: string) {
    const raw: any = await this.prisma.product.findUnique({ where: { id }, include: { ...PRODUCT_CONFIG_INCLUDE, images: true } as any });
    if (!raw) throw new NotFoundException('Product not found');
    const config = toProductConfig(raw);
    const view = catalogDetailView(raw, config, this.resolver.pairContext(config));
    if (!view) throw new NotFoundException('Product not found');
    return view;
  }

  /** P5. */
  async findOne(id: string): Promise<ProductDetail> {
    const raw: any = await this.prisma.product.findUnique({ where: { id }, include: DETAIL_INCLUDE as any });
    if (!raw) throw new NotFoundException('Product not found');
    const config = toProductConfig(raw);
    const ctx = new CatalogRequestContext();
    ctx.configs.set(id, Promise.resolve(config));

    const attIds = new Set<string>();
    for (const c of raw.components ?? []) {
      if (c.attachmentId) attIds.add(c.attachmentId);
      for (const l of c.plateLayouts ?? []) if (l.attachmentId) attIds.add(l.attachmentId);
    }
    const V = config.options.map((o) => o.id);
    const refWhere = { OR: [{ sizeOptionId: { in: V } }, { colourOptionId: { in: V } }] };
    const refSelect = { sizeOptionId: true, colourOptionId: true };
    const [atts, orderRefs, quoteRefs, jobRefs, grid] = await Promise.all([
      attIds.size ? this.prisma.attachment.findMany({ where: { id: { in: [...attIds] } }, select: { id: true, originalName: true, filename: true, sizeBytes: true } }) : [],
      V.length ? this.prisma.orderItem.findMany({ where: refWhere, select: refSelect }) : [],
      V.length ? this.prisma.quoteItem.findMany({ where: refWhere, select: refSelect }) : [],
      V.length ? this.prisma.productionJob.findMany({ where: refWhere, select: refSelect }) : [],
      this.pricing.cellCosts(id, ctx),
    ]);

    const missing = new Set<string>();
    for (const c of config.components) {
      for (const s of c.colourStock) {
        try { for (const k of parseColourKey(s.colourKey)) if (!config.materials.has(k.materialId)) missing.add(k.materialId); } catch { /* ignore bad keys */ }
      }
    }
    const extraMaterials = new Map<string, MaterialLite>();
    if (missing.size) {
      const mats = await this.prisma.material.findMany({ where: { id: { in: [...missing] } } });
      for (const m of mats as any[]) extraMaterials.set(m.id, { id: m.id, name: m.name, type: m.type, color: m.color ?? null, colorHex: m.colorHex ?? null, brand: m.brand ?? null, costPerGram: m.costPerGram });
    }
    return buildProductDetail(raw, config, this.resolver.pairContext(config), {
      attachments: new Map((atts as AttachmentLite[]).map((a) => [a.id, a])),
      optionRefs: [...orderRefs, ...quoteRefs, ...jobRefs] as any,
      cells: grid.cells,
      extraMaterials,
    });
  }

  /** P6. Reprices when the pricing printer or colour changes change. */
  async update(id: string, body: unknown): Promise<ProductDetail> {
    const input = parseProductPatch(body);
    const current = await this.prisma.product.findUnique({ where: { id }, select: { id: true, colorChanges: true, defaultPrinterId: true } });
    if (!current) throw new NotFoundException('Product not found');
    if (input.sku) await assertSkuFree(this.prisma, input.sku, { productId: id });
    if (input.defaultPrinterId) await this.assertPrinter(input.defaultPrinterId);
    if (Object.keys(input).length) await this.prisma.product.update({ where: { id }, data: input as any });
    const reprice = (input.colorChanges !== undefined && input.colorChanges !== current.colorChanges)
      || (input.defaultPrinterId !== undefined && input.defaultPrinterId !== current.defaultPrinterId);
    if (reprice) await this.reprice(id);
    return this.findOne(id);
  }

  /** P7. */
  async history(id: string) {
    const p = await this.prisma.product.findUnique({ where: { id }, select: { id: true } });
    if (!p) throw new NotFoundException('Product not found');
    const h = await productHistory(this.prisma, id);
    return { ...h, canDelete: h.orderLines + h.quoteLines + h.jobs === 0 };
  }

  /** P8: delete without history, under the product row lock (§3.10). */
  async remove(id: string) {
    const files: Array<string | null> = [];
    await this.prisma.$transaction(async (tx: any) => {
      const locked = await lockProduct(tx, id, 'UPDATE');
      if (!locked) throw new NotFoundException('Product not found');
      const h = await productHistory(tx, id);
      if (h.orderLines + h.quoteLines + h.jobs > 0) {
        throw new ConflictException(`"${locked.name}" has ${h.orderLines} order lines, ${h.quoteLines} quote lines and ${h.jobs} jobs — deactivate it instead`);
      }
      const images = await tx.productImage.findMany({ where: { productId: id }, select: { storageKey: true } });
      const atts = await tx.attachment.findMany({ where: { entityType: { equals: 'product', mode: 'insensitive' }, entityId: id }, select: { id: true, storagePath: true } });
      if (atts.length) await tx.attachment.deleteMany({ where: { id: { in: atts.map((a: any) => a.id) } } });
      await tx.product.delete({ where: { id } });
      files.push(...photoPaths(images), ...atts.map((a: any) => containedUploadPath(a.storagePath)));
    }, TX_OPTS);
    await unlinkAfterCommit(files);
    return { deleted: true };
  }

  /** P16. Without parameters: every size and every cell; with a pair: that pair's breakdown. */
  async cost(id: string, query: Record<string, unknown> = {}) {
    const ctx = new CatalogRequestContext();
    if (query.sizeOptionId === undefined && query.colourOptionId === undefined) {
      const sizes = await this.pricing.optionCosts(id, ctx);
      const grid = await this.pricing.cellCosts(id, ctx);
      return { costVersion: grid.costVersion, sizes, cells: grid.cells };
    }
    const pair: OptionCost = await this.pricing.optionCost(id, pairParam(query.sizeOptionId, 'sizeOptionId'), pairParam(query.colourOptionId, 'colourOptionId'), ctx);
    return { costVersion: await this.pricing.costVersion(id, ctx), pair };
  }

  /** P17: recalculate, then the P16 payload with what was applied per size. */
  async calculate(id: string) {
    const results = await this.pricing.recalcPricing(id);
    const payload = await this.cost(id);
    return { ...payload, applied: results.map((r) => ({ sizeOptionId: r.sizeOptionId, applied: r.written, price: r.price })) };
  }

  /** P18. */
  async bulkFloor(id: string, query: Record<string, unknown> = {}) {
    rejectStaleQuery(query);
    return this.pricing.bulkFloor(id, pairParam(query.sizeOptionId, 'sizeOptionId'), parseMinQtys(query.minQtys));
  }

  /** P19: replace a size's tiers; the size row is read under FOR SHARE (§3.1 rule 3). */
  async setPriceTiers(id: string, body: unknown) {
    const { sizeOptionId, tiers } = parseTiers(body);
    return this.prisma.$transaction(async (tx: any) => {
      const product = await tx.product.findUnique({ where: { id }, select: { id: true } });
      if (!product) throw new NotFoundException('Product not found');
      if (sizeOptionId) {
        const [row] = await lockOptions(tx, [sizeOptionId], 'SHARE');
        if (!row || row.productId !== id) throw new NotFoundException('Size not found');
        if (row.kind === 'COLOUR') throw new BadRequestException("Colours share their size's tiers — set tiers on the size");
        await tx.variantPriceTier.deleteMany({ where: { variantId: sizeOptionId } });
        if (tiers.length) await tx.variantPriceTier.createMany({ data: tiers.map((t) => ({ ...t, variantId: sizeOptionId })) });
        return tx.variantPriceTier.findMany({ where: { variantId: sizeOptionId }, orderBy: { minQty: 'asc' } });
      }
      await tx.priceTier.deleteMany({ where: { productId: id } });
      if (tiers.length) await tx.priceTier.createMany({ data: tiers.map((t) => ({ ...t, productId: id })) });
      return tx.priceTier.findMany({ where: { productId: id }, orderBy: { minQty: 'asc' } });
    }, TX_OPTS);
  }

  /** P20. */
  async readiness(id: string, query: Record<string, unknown> = {}) {
    rejectStaleQuery(query);
    const qty = parseReadinessQty(query.qty);
    const ctx = new CatalogRequestContext();
    const config = await this.resolver.requireConfig(id, ctx);
    const pair = { sizeOptionId: pairParam(query.sizeOptionId, 'sizeOptionId'), colourOptionId: pairParam(query.colourOptionId, 'colourOptionId') };
    validatePair(this.resolver.pairContext(config), pair.sizeOptionId, pair.colourOptionId, { audience: 'STAFF' });
    return this.planner.readiness(id, pair, qty, { ctx });
  }

  // ------------------------------------------------------------- P21 parts

  listParts(id: string) {
    return this.parts.listForProduct(id);
  }

  async setPart(id: string, body: unknown) {
    const line = await this.parts.setProductPart(id, body);
    await this.reprice(id);
    return line;
  }

  async removePart(id: string, partId: string) {
    const out = await this.parts.removeProductPart(id, partId);
    await this.reprice(id);
    return out;
  }

  /**
   * Excel BOM upload (unchanged). Known exception C17: SKU-matched rows still
   * write basePrice; the Pricing card shows "differs" and the next trigger
   * overwrites it.
   */
  async uploadBom(fileBuffer: Buffer): Promise<{ created: number; updated: number; errors: string[] }> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer as any);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new BadRequestException('Excel file has no worksheets');

    const headers: Record<string, number> = {};
    sheet.getRow(1).eachCell((cell, colNumber) => {
      const val = String(cell.value ?? '').trim().toLowerCase();
      if (val) headers[val] = colNumber;
    });
    if (!headers.name) throw new BadRequestException('Missing required column: "name"');

    const cellStr = (row: ExcelJS.Row, name: string): string | null => {
      const c = headers[name];
      if (!c) return null;
      const v = row.getCell(c).value;
      return v != null ? String(v).trim() : null;
    };
    const cellNum = (row: ExcelJS.Row, name: string): number | null => {
      const c = headers[name];
      if (!c) return null;
      const v = row.getCell(c).value;
      if (v == null || v === '') return null;
      const n = Number(v);
      return isNaN(n) ? null : n;
    };

    let created = 0;
    let updated = 0;
    const errors: string[] = [];
    for (let rowNum = 2; rowNum <= sheet.rowCount; rowNum++) {
      const row = sheet.getRow(rowNum);
      let hasContent = false;
      row.eachCell(() => { hasContent = true; });
      if (!hasContent) continue;
      const name = cellStr(row, 'name');
      if (!name) {
        errors.push(`Row ${rowNum}: "name" is required`);
        continue;
      }
      const sku = cellStr(row, 'sku') || null;
      const description = cellStr(row, 'description') || null;
      const basePrice = cellNum(row, 'baseprice') ?? cellNum(row, 'base_price') ?? cellNum(row, 'price') ?? null;
      const estimatedMinutes = cellNum(row, 'estimatedminutes') ?? cellNum(row, 'estimated_minutes') ?? null;
      const estimatedGrams = cellNum(row, 'estimatedgrams') ?? cellNum(row, 'estimated_grams') ?? null;
      try {
        const existing = sku ? await this.prisma.product.findFirst({ where: { sku } }) : null;
        if (existing) {
          const data: any = { name };
          if (description !== null) data.description = description;
          if (basePrice !== null) data.basePrice = basePrice;
          if (estimatedMinutes !== null) data.estimatedMinutes = estimatedMinutes;
          if (estimatedGrams !== null) data.estimatedGrams = estimatedGrams;
          await this.prisma.product.update({ where: { id: existing.id }, data });
          updated++;
        } else {
          await this.prisma.product.create({
            data: { name, sku, description, basePrice: basePrice ?? 0, estimatedMinutes: estimatedMinutes ?? 0, estimatedGrams: estimatedGrams ?? 0 },
          });
          created++;
        }
      } catch (err: any) {
        errors.push(`Row ${rowNum} ("${name}"): ${err?.message ?? 'Unknown error'}`);
      }
    }
    return { created, updated, errors };
  }
}
