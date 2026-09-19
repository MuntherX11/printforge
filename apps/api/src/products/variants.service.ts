import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Problem, ProductDetail } from '@printforge/types';
import { BomResolverService } from '../catalog-core/bom-resolver.service';
import { optionsOfKind } from '../catalog-core/catalog-config';
import { OpenLinesImpactService } from '../catalog-core/open-lines-impact.service';
import { STANDARD_KEY } from '../catalog-core/option-pair';
import { PricingService } from '../catalog-core/pricing.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { isMultiColourComponent } from '../stock-ledger/colour-key';
import { parseAssignments, parseKindChanges, parseOptionCreate, parseOptionPatch } from './product-input';
import {
  assertSkuFree, impactWarnings, lockOptions, lockProduct, mergeImpact, optionHistory, requireConfirm, TX_OPTS,
  unlinkAfterCommit, unreferencedAttachments,
} from './product-locks';
import { ProductsService } from './products.service';

/**
 * Sizes and colours: two separate axes on one product (spec §3.1, §4.2 O1–O7).
 * Replaces the five pre-release variant routes on the same paths. Options never
 * carry a manual price: a size's price is automatic, a colour has none.
 */

const MAX_PER_KIND = 30;
const ONLY_COLOURS = 'Only colours assign filaments — sizes have their own components';
const NEEDS_COMPONENTS = "Add the product's components before adding colours";
const kindWord = (k: string, plural = false) => (k === 'SIZE' ? (plural ? 'sizes' : 'size') : plural ? 'colours' : 'colour');
const money = (n: number) => n.toFixed(3);

@Injectable()
export class VariantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
    private readonly pricing: PricingService,
    private readonly resolver: BomResolverService,
    private readonly impact: OpenLinesImpactService,
  ) {}

  private async owned(productId: string, variantId: string) {
    const v = await this.prisma.productVariant.findFirst({ where: { id: variantId, productId } });
    if (!v) throw new NotFoundException('Option not found');
    return v as any;
  }

  /** O1. */
  async create(productId: string, body: unknown) {
    const input = parseOptionCreate(body);
    await assertSkuFree(this.prisma, input.sku);
    const option = await this.prisma.$transaction(async (tx: any) => {
      if (!(await lockProduct(tx, productId, 'UPDATE'))) throw new NotFoundException('Product not found');
      const product = await tx.product.findUnique({ where: { id: productId }, select: { baseOptionSellable: true, standardColourSellable: true } });
      const sameKind = await tx.productVariant.findMany({ where: { productId, kind: input.kind }, select: { sortOrder: true } });
      if (sameKind.length >= MAX_PER_KIND) throw new BadRequestException(`A product can have at most ${MAX_PER_KIND} ${kindWord(input.kind, true)}`);
      if (input.kind === 'COLOUR' && (await tx.productComponent.count({ where: { productId } })) === 0) throw new BadRequestException(NEEDS_COMPONENTS);
      if (input.keepStandard) {
        const axisOpen = input.kind === 'COLOUR' ? product.standardColourSellable === null : product.baseOptionSellable === null;
        if (sameKind.length > 0 || !axisOpen) throw new BadRequestException(`keepStandard isn't needed for ${kindWord(input.kind, true)}`);
        await tx.product.update({
          where: { id: productId },
          data: input.kind === 'COLOUR'
            ? { standardColourLabel: input.keepStandard.label, standardColourSellable: input.keepStandard.sellInShop }
            : { baseOptionLabel: input.keepStandard.label, baseOptionSellable: input.keepStandard.sellInShop },
        });
      }
      const sortOrder = input.sortOrder ?? (sameKind.length ? Math.max(...sameKind.map((s: any) => s.sortOrder)) + 1 : 0);
      return tx.productVariant.create({ data: { productId, name: input.name, sku: input.sku, kind: input.kind, isActive: input.isActive, sortOrder } });
    }, TX_OPTS);
    const warnings: Problem[] = input.kind === 'COLOUR'
      ? [{ code: 'COLOUR_OPTION_NOT_SET_UP', message: `"${option.name}" has no filaments assigned — it prints in the standard colours` }]
      : [];
    return { ...option, warnings };
  }

  /** O2. */
  async update(productId: string, variantId: string, body: unknown) {
    const input = parseOptionPatch(body);
    await this.owned(productId, variantId);
    if (input.sku) await assertSkuFree(this.prisma, input.sku, { variantId });
    if (!Object.keys(input).length) return this.owned(productId, variantId);
    return this.prisma.productVariant.update({ where: { id: variantId }, data: input });
  }

  /** O3. */
  async history(productId: string, variantId: string) {
    await this.owned(productId, variantId);
    const h = await optionHistory(this.prisma, variantId);
    return { ...h, canDelete: h.orderLines + h.quoteLines + h.jobs + h.stockRecords === 0 };
  }

  /** O4: delete without history or printed-stock records, under the option row lock. */
  async remove(productId: string, variantId: string) {
    const files: Array<string | null> = [];
    await this.prisma.$transaction(async (tx: any) => {
      const [row] = await lockOptions(tx, [variantId], 'UPDATE');
      if (!row || row.productId !== productId) throw new NotFoundException('Option not found');
      const h = await optionHistory(tx, variantId);
      if (h.orderLines + h.quoteLines + h.jobs > 0) throw new ConflictException(`"${row.name}" has been ordered, quoted or produced — deactivate it instead`);
      if (h.stockRecords > 0) throw new ConflictException(`"${row.name}" has printed stock records — deactivate it instead`);
      const comps = await tx.productComponent.findMany({ where: { variantId }, select: { id: true, attachmentId: true, thumbnailAttachmentId: true } });
      const layouts = comps.length
        ? await tx.plateLayout.findMany({ where: { componentId: { in: comps.map((c: any) => c.id) } }, select: { attachmentId: true } })
        : [];
      await tx.colourSizeExclusion.deleteMany({ where: { sizeKey: variantId } });
      await tx.productVariant.delete({ where: { id: variantId } });
      const gone = await unreferencedAttachments(tx, [...comps.flatMap((c: any) => [c.attachmentId, c.thumbnailAttachmentId]), ...layouts.map((l: any) => l.attachmentId)]);
      if (gone.length) await tx.attachment.deleteMany({ where: { id: { in: gone.map((g) => g.id) } } });
      files.push(...gone.map((g) => g.abs));
    }, TX_OPTS);
    await unlinkAfterCommit(files);
    return { deleted: true };
  }

  /** O5: a colour's filament per colour slot, and the sizes it isn't made in. */
  async setAssignments(productId: string, variantId: string, body: unknown, dryRun = false) {
    const input = parseAssignments(body);
    const option = await this.owned(productId, variantId);
    if (option.kind !== 'COLOUR') throw new BadRequestException(ONLY_COLOURS);
    const config = await this.resolver.requireConfig(productId);
    for (const s of input.slots) if (!config.colourSlots.some((x) => x.id === s.colourSlotId)) throw new BadRequestException('Unknown colour slot');
    const matIds = [...new Set(input.slots.map((s) => s.materialId).filter((m): m is string => !!m))];
    const mats = matIds.length ? await this.prisma.material.findMany({ where: { id: { in: matIds } } }) : [];
    if (mats.length !== matIds.length) throw new NotFoundException('Material not found');
    if (input.excludedSizeKeys) {
      const sizes = optionsOfKind(config, 'SIZE');
      for (const k of input.excludedSizeKeys) if (k !== STANDARD_KEY && !sizes.some((s) => s.id === k)) throw new BadRequestException('Unknown size');
      const activeKeys = [STANDARD_KEY, ...sizes.filter((s) => s.isActive).map((s) => s.id)];
      if (activeKeys.every((k) => input.excludedSizeKeys!.includes(k))) throw new BadRequestException(`"${option.name}" must be made in at least one size`);
    }

    const impact = mergeImpact(
      await this.impact.compute(productId, { kind: 'ASSIGNMENTS', colourOptionId: variantId, assignments: input.slots }),
      input.excludedSizeKeys ? await this.impact.compute(productId, { kind: 'EXCLUSIONS', colourOptionId: variantId, excludedSizeKeys: input.excludedSizeKeys }) : [],
    );
    if (dryRun) return { impact };
    requireConfirm(impact, input.confirm);

    await this.prisma.$transaction(async (tx: any) => {
      const [row] = await lockOptions(tx, [variantId], 'SHARE');
      if (!row || row.productId !== productId) throw new NotFoundException('Option not found');
      if (row.kind !== 'COLOUR') throw new BadRequestException(ONLY_COLOURS);
      await tx.colourOptionSlot.deleteMany({ where: { variantId } });
      const rows = input.slots.filter((s) => s.materialId).map((s) => ({ variantId, colourSlotId: s.colourSlotId, materialId: s.materialId }));
      if (rows.length) await tx.colourOptionSlot.createMany({ data: rows });
      if (input.excludedSizeKeys) {
        await tx.colourSizeExclusion.deleteMany({ where: { variantId } });
        if (input.excludedSizeKeys.length) await tx.colourSizeExclusion.createMany({ data: input.excludedSizeKeys.map((sizeKey) => ({ variantId, sizeKey })) });
      }
    }, TX_OPTS);

    const warnings: Problem[] = [];
    for (const s of input.slots) {
      if (!s.materialId) continue;
      const newType = (mats as any[]).find((m) => m.id === s.materialId)?.type;
      const fileTypes = new Set<string>();
      for (const c of config.components) {
        const own = isMultiColourComponent(c) ? c.materials.map((m) => ({ materialId: m.materialId, link: m.colourSlotId })) : c.materialId ? [{ materialId: c.materialId, link: c.colourSlotId }] : [];
        for (const o of own) if (o.link === s.colourSlotId) { const t = config.materials.get(o.materialId)?.type; if (t) fileTypes.add(String(t)); }
      }
      for (const t of fileTypes) if (newType && t !== newType) warnings.push({ code: 'MATERIAL_TYPE_DIFFERS', colourSlotId: s.colourSlotId, message: `Different plastic from the file (${t} → ${newType})` });
    }
    const after = await this.resolver.requireConfig(productId);
    for (const sid of [null, ...optionsOfKind(after, 'SIZE').filter((s) => s.isActive).map((s) => s.id)]) {
      try {
        for (const w of this.resolver.resolveWithConfig(after, { sizeOptionId: sid, colourOptionId: variantId }).warnings) {
          if (w.code === 'COLOUR_SLOT_UNUSED') warnings.push(w);
        }
      } catch { /* a size without components resolves on the standard BOM */ }
    }
    warnings.push(...impactWarnings(impact));
    const colour = after.options.find((o) => o.id === variantId)!;
    return {
      assignments: colour.assignments.map((a) => ({ colourSlotId: a.colourSlotId, materialId: a.materialId, material: after.materials.get(a.materialId) })),
      excludedSizeKeys: colour.excludedSizeKeys,
      warnings,
      impact,
    };
  }

  /** O6: size → reprice and its cost; colour → its cells (nothing applied). */
  async calculate(productId: string, variantId: string) {
    const option = await this.owned(productId, variantId);
    if (option.kind === 'COLOUR') {
      const grid = await this.pricing.cellCosts(productId);
      return grid.cells.filter((c) => c.colourOptionId === variantId);
    }
    const results = await this.pricing.recalcPricing(productId);
    const cost = await this.pricing.optionCost(productId, variantId, null);
    return {
      ...cost,
      applied: results.filter((r) => r.sizeOptionId === variantId).map((r) => ({ sizeOptionId: r.sizeOptionId, applied: r.written, price: r.price })),
    };
  }

  /** O7: batch kind changes (§3.1 rules 2, 3, 7), all under FOR UPDATE, all or nothing. */
  async setKinds(productId: string, body: unknown): Promise<ProductDetail & { rewritten: { orderLines: number; quoteLines: number; jobs: number } }> {
    const input = parseKindChanges(body);
    const ids = input.changes.map((c) => c.variantId);
    const notes: Problem[] = [];
    const rewritten = { orderLines: 0, quoteLines: 0, jobs: 0 };

    await this.prisma.$transaction(async (tx: any) => {
      const locked = await lockOptions(tx, ids, 'UPDATE');
      if (locked.length !== ids.length || locked.some((r) => r.productId !== productId)) throw new NotFoundException('Option not found');
      if (!(await lockProduct(tx, productId, 'UPDATE'))) throw new NotFoundException('Product not found');
      const product = await tx.product.findUnique({ where: { id: productId }, select: { name: true, basePrice: true, baseOptionSellable: true, standardColourSellable: true } });
      const byId = new Map(locked.map((r) => [r.id, r]));
      const target = new Map(input.changes.map((c) => [c.variantId, c.kind]));
      for (const c of input.changes) {
        const row = byId.get(c.variantId)!;
        if (row.kind === c.kind) throw new BadRequestException(`"${row.name}" is already a ${kindWord(c.kind)}`);
      }
      if (input.changes.some((c) => c.kind === 'COLOUR') && (await tx.productComponent.count({ where: { productId } })) === 0) {
        throw new BadRequestException(NEEDS_COMPONENTS);
      }

      const blocked: string[] = [];
      for (const c of input.changes) {
        const row = byId.get(c.variantId)!;
        const V = row.id;
        if (c.kind === 'COLOUR') {
          if (await tx.productComponent.count({ where: { variantId: V } })) blocked.push(`"${row.name}" can't become a colour: it has its own components.`);
          if (await tx.variantPriceTier.count({ where: { variantId: V } })) blocked.push(`"${row.name}" can't become a colour: it has its own bulk tiers.`);
          const w = { sizeOptionId: V, colourOptionId: { not: null } };
          const n = (await tx.orderItem.count({ where: w })) + (await tx.quoteItem.count({ where: w })) + (await tx.productionJob.count({ where: w }));
          if (n) blocked.push(`"${row.name}" can't become a colour: it is used as a size with a colour on ${n} orders, quotes or jobs.`);
        } else {
          if (await tx.colourOptionSlot.count({ where: { variantId: V } })) blocked.push(`"${row.name}" can't become a size: it has filament assignments — clear them first.`);
          const w = { colourOptionId: V };
          const n = (await tx.orderItem.count({ where: w })) + (await tx.quoteItem.count({ where: w })) + (await tx.productionJob.count({ where: w }));
          if (n) blocked.push(`"${row.name}" can't become a size: it is used as a colour on ${n} orders, quotes or jobs made since the update.`);
        }
      }
      if (blocked.length) throw new ConflictException(blocked.join(' '));

      const all = await tx.productVariant.findMany({ where: { productId }, select: { id: true, kind: true, isActive: true } });
      const kindAfter = (o: any) => target.get(o.id) ?? o.kind;
      for (const k of ['SIZE', 'COLOUR'] as const) {
        if (all.filter((o: any) => kindAfter(o) === k).length > MAX_PER_KIND) throw new BadRequestException(`A product can have at most ${MAX_PER_KIND} ${kindWord(k, true)}`);
      }
      const activeBefore = (k: string) => all.filter((o: any) => o.isActive && o.kind === k).length;
      const activeAfter = (k: string) => all.filter((o: any) => o.isActive && kindAfter(o) === k).length;
      const needColour = activeAfter('COLOUR') > 0 && activeBefore('COLOUR') === 0 && product.standardColourSellable === null;
      const needSize = activeAfter('SIZE') > 0 && activeBefore('SIZE') === 0 && product.baseOptionSellable === null;
      if (needColour && !input.keepStandard.colour) throw new BadRequestException(`Choose whether customers keep buying "${product.name}" as sliced`);
      if (!needColour && input.keepStandard.colour) throw new BadRequestException("keepStandard isn't needed for colours");
      if (needSize && !input.keepStandard.size) throw new BadRequestException(`Choose whether customers keep buying "${product.name}" in its standard size`);
      if (!needSize && input.keepStandard.size) throw new BadRequestException("keepStandard isn't needed for sizes");

      for (const c of input.changes) {
        const row = byId.get(c.variantId)!;
        await tx.productVariant.update({ where: { id: row.id }, data: { kind: c.kind } });
        if (c.kind !== 'COLOUR') continue;
        const where = { sizeOptionId: row.id, colourOptionId: null };
        const data = { colourOptionId: row.id, sizeOptionId: null };
        const o = (await tx.orderItem.updateMany({ where, data })).count;
        const q = (await tx.quoteItem.updateMany({ where, data })).count;
        const j = (await tx.productionJob.updateMany({ where, data })).count;
        rewritten.orderLines += o;
        rewritten.quoteLines += q;
        rewritten.jobs += j;
        if (o + q + j) notes.push({ code: 'LINES_RECLASSIFIED', message: `"${row.name}" was on ${o + q + j} orders, quotes or jobs as a size — they now read as colour "${row.name}"` });
        if (row.basePrice !== null && row.basePrice !== undefined && Math.abs(row.basePrice - product.basePrice) >= 0.0005) {
          notes.push({ code: 'LEGACY_PRICE_IGNORED', message: `"${row.name}" had its own price ${money(row.basePrice)} — colours use their size's price (${money(product.basePrice)})` });
        }
        notes.push({ code: 'COLOUR_HIDDEN_UNTIL_SET_UP', message: `"${row.name}" won't be offered in the shop until its filaments are set` });
      }
      await tx.colourSizeExclusion.deleteMany({ where: { OR: [{ variantId: { in: ids } }, { sizeKey: { in: ids } }] } });
      if (input.keepStandard.colour) {
        await tx.product.update({ where: { id: productId }, data: { standardColourLabel: input.keepStandard.colour.label, standardColourSellable: input.keepStandard.colour.sellInShop } });
      }
      if (input.keepStandard.size) {
        await tx.product.update({ where: { id: productId }, data: { baseOptionLabel: input.keepStandard.size.label, baseOptionSellable: input.keepStandard.size.sellInShop } });
      }
    }, TX_OPTS);

    const detail = await this.products.findOne(productId);
    return { ...detail, rewritten, warnings: [...notes, ...detail.warnings] };
  }
}
