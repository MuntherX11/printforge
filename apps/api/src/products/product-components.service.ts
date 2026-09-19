import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { ComponentDetail, Problem } from '@printforge/types';
import { OpenLinesImpactService, type OpenLineImpact } from '../catalog-core/open-lines-impact.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { baseColourKeyOf, isMultiColourComponent, ownSlotsOf, parseColourKey } from '../stock-ledger/colour-key';
import { ProductStockService } from '../stock-ledger/product-stock.service';
import {
  parseComponentCreate, parseComponentMaterials, parseComponentOrder, parseComponentPatch, parseStockSet,
} from './product-input';
import {
  ACTIVE_JOBS, impactWarnings, lockOptions, mergeImpact, requireConfirm, TX_OPTS, unlinkAfterCommit, unreferencedAttachments,
} from './product-locks';
import { ProductsService } from './products.service';

/**
 * Printed components of a product or size (spec §4.1 P9–P14): allowlisted
 * input, ownership checks, colour links, the open-line impact of filament and
 * link changes (§3.3), stock re-keying and the component-removal guards (§3.10).
 */

type Link = { colourSlotId: string | null; colourFixed: boolean | null };

/** The link a slot ends up with (§3.3: a link clears Fixed; Fixed clears the link; null + no fixed = unlinked). */
export function linkAfter(current: { colourSlotId: string | null; colourFixed: boolean | null }, input: { colourSlotId?: string | null; colourFixed?: boolean }): Link | null {
  if (input.colourSlotId === undefined && input.colourFixed === undefined) return null;
  if (input.colourFixed === true) return { colourSlotId: null, colourFixed: true };
  if (input.colourSlotId !== undefined) return { colourSlotId: input.colourSlotId, colourFixed: null };
  return { colourSlotId: current.colourSlotId, colourFixed: null };
}

const linkChanged = (cur: { colourSlotId: string | null; colourFixed: boolean | null }, next: Link | null) =>
  !!next && (next.colourSlotId !== (cur.colourSlotId ?? null) || (next.colourFixed === true) !== (cur.colourFixed === true));

type ComponentResponse = ComponentDetail & { warnings: Problem[]; impact: OpenLineImpact[] };

@Injectable()
export class ProductComponentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
    private readonly impact: OpenLinesImpactService,
    private readonly stock: ProductStockService,
  ) {}

  /** The ComponentDetail of one component, from the product page's assembly. */
  async detail(productId: string, componentId: string): Promise<ComponentDetail> {
    const d = await this.products.findOne(productId);
    const all = [...d.components, ...d.sizes.flatMap((s) => s.components)];
    const c = all.find((x) => x.id === componentId);
    if (!c) throw new NotFoundException('Component not found');
    return c;
  }

  /** Loads a component and checks it belongs to `productId` (404 otherwise; null = alias route). */
  private async owned(productId: string | null, componentId: string) {
    const comp: any = await this.prisma.productComponent.findUnique({ where: { id: componentId }, include: { materials: true } });
    if (!comp || (productId !== null && comp.productId !== productId)) throw new NotFoundException('Component not found');
    return comp;
  }

  private async assertSlot(db: any, productId: string, slotId: string | null | undefined) {
    if (!slotId) return;
    const slot = await db.productColourSlot.findFirst({ where: { id: slotId, productId }, select: { id: true } });
    if (!slot) throw new BadRequestException('Unknown colour slot');
  }

  private async assertMaterials(ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return;
    const found = await this.prisma.material.findMany({ where: { id: { in: unique } }, select: { id: true } });
    if (found.length !== unique.length) throw new NotFoundException('Material not found');
  }

  private async materialNames(db: any, ids: string[]) {
    const rows = await db.material.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } });
    return new Map<string, { name: string }>(rows.map((m: any) => [m.id, { name: m.name }]));
  }

  /** P9. */
  async add(productId: string, body: unknown): Promise<ComponentDetail> {
    const input = parseComponentCreate(body);
    const created = await this.prisma.$transaction(async (tx: any) => {
      const product = await tx.product.findUnique({ where: { id: productId }, select: { id: true } });
      if (!product) throw new NotFoundException('Product not found');
      const material = await tx.material.findUnique({ where: { id: input.materialId }, select: { id: true } });
      if (!material) throw new NotFoundException('Material not found');
      let variantId: string | null = null;
      if (input.sizeOptionId) {
        const [row] = await lockOptions(tx, [input.sizeOptionId], 'SHARE');
        if (!row || row.productId !== productId) throw new NotFoundException('Size not found');
        if (row.kind === 'COLOUR') throw new BadRequestException("Colours use each size's components — add the component to a size");
        variantId = row.id;
      }
      await this.assertSlot(tx, productId, input.colourSlotId);
      const last = await tx.productComponent.findFirst({ where: { productId, variantId }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
      return tx.productComponent.create({
        data: {
          productId, variantId, materialId: input.materialId, description: input.description, gramsUsed: input.gramsUsed,
          printMinutes: input.printMinutes, quantity: input.quantity, sortOrder: (last?.sortOrder ?? -1) + 1, stockConfirmedAt: new Date(),
          colourSlotId: input.colourFixed === true ? null : input.colourSlotId ?? null,
          colourFixed: input.colourFixed === true ? true : null,
        },
        select: { id: true },
      });
    }, TX_OPTS);
    await this.products.reprice(productId);
    return this.detail(productId, created.id);
  }

  /** P10 (and its alias, productId null). */
  async update(productId: string | null, componentId: string, body: unknown, dryRun = false, userId: string | null = null): Promise<ComponentResponse | { impact: OpenLineImpact[] }> {
    const input = parseComponentPatch(body);
    const comp = await this.owned(productId, componentId);
    const pid: string = comp.productId;
    const multi = isMultiColourComponent(comp);
    if (input.materialId !== undefined && multi) throw new BadRequestException('Use the colour slots editor for multicolour components');
    if ((input.colourSlotId !== undefined || input.colourFixed !== undefined) && multi) throw new BadRequestException('Link multicolour parts per colour');
    if (input.materialId !== undefined && input.materialId !== comp.materialId) await this.assertMaterials([input.materialId]);
    await this.assertSlot(this.prisma, pid, input.colourSlotId);

    const materialChanged = input.materialId !== undefined && input.materialId !== comp.materialId;
    const link = linkAfter(comp, input);
    const relink = linkChanged(comp, link);
    const impact = mergeImpact(
      materialChanged ? await this.impact.compute(pid, { kind: 'COMPONENT_MATERIAL', componentId, materialId: input.materialId }) : [],
      relink ? await this.impact.compute(pid, { kind: 'LINKS', links: [{ componentId, colorIndex: 0, colourSlotId: link!.colourSlotId, fixed: link!.colourFixed === true }] }) : [],
    );
    if (dryRun) return { impact };
    requireConfirm(impact, input.confirm);

    const warnings: Problem[] = [];
    await this.prisma.$transaction(async (tx: any) => {
      const data: Record<string, unknown> = {};
      for (const k of ['description', 'gramsUsed', 'printMinutes', 'quantity', 'materialId'] as const) if (input[k] !== undefined) data[k] = input[k];
      if (input.gramsUsed !== undefined || input.printMinutes !== undefined) data.perUnitEstimatedFromLayoutId = null;
      if (link) Object.assign(data, link);
      if (Object.keys(data).length) await tx.productComponent.update({ where: { id: componentId }, data });
      if (materialChanged) {
        const oldKey = baseColourKeyOf(comp);
        const newKey = baseColourKeyOf({ ...comp, materialId: input.materialId! });
        const r = await this.stock.rekeyBase(tx, componentId, oldKey, newKey, { userId, materials: await this.materialNames(tx, [comp.materialId, input.materialId].filter(Boolean)) });
        warnings.push(...r.warnings);
      }
    }, TX_OPTS);

    const priced = ['gramsUsed', 'printMinutes', 'quantity', 'materialId'].some((k) => (input as any)[k] !== undefined);
    if (priced) await this.products.reprice(pid);
    return { ...(await this.detail(pid, componentId)), warnings: [...warnings, ...impactWarnings(impact)], impact };
  }

  /** P11: per-colour filaments and links of a component. */
  async setMaterials(productId: string, componentId: string, body: unknown, dryRun = false, userId: string | null = null): Promise<ComponentResponse | { impact: OpenLineImpact[] }> {
    const { slots, confirm } = parseComponentMaterials(body);
    const comp = await this.owned(productId, componentId);
    const multi = isMultiColourComponent(comp);
    const current = multi
      ? new Map<number, any>(comp.materials.map((m: any) => [m.colorIndex, m]))
      : new Map<number, any>(comp.materialId ? [[0, { materialId: comp.materialId, colourSlotId: comp.colourSlotId, colourFixed: comp.colourFixed }]] : []);
    for (const s of slots) {
      if (!current.has(s.colorIndex)) throw new BadRequestException(`"${comp.description}" has no colour ${s.colorIndex + 1}`);
      await this.assertSlot(this.prisma, productId, s.colourSlotId);
    }
    await this.assertMaterials(slots.map((s) => s.materialId));

    const matChanges = slots.filter((s) => s.materialId !== current.get(s.colorIndex).materialId);
    const links = slots
      .map((s) => ({ s, link: linkAfter(current.get(s.colorIndex), s) }))
      .filter(({ s, link }) => linkChanged(current.get(s.colorIndex), link));
    const impact = mergeImpact(
      matChanges.length
        ? await this.impact.compute(productId, multi
          ? { kind: 'COMPONENT_MATERIAL', componentId, slots: matChanges.map((s) => ({ colorIndex: s.colorIndex, materialId: s.materialId })) }
          : { kind: 'COMPONENT_MATERIAL', componentId, materialId: matChanges[0].materialId })
        : [],
      links.length
        ? await this.impact.compute(productId, { kind: 'LINKS', links: links.map(({ s, link }) => ({ componentId, colorIndex: s.colorIndex, colourSlotId: link!.colourSlotId, fixed: link!.colourFixed === true })) })
        : [],
    );
    if (dryRun) return { impact };
    requireConfirm(impact, confirm);

    const warnings: Problem[] = [];
    await this.prisma.$transaction(async (tx: any) => {
      for (const s of slots) {
        const link = linkAfter(current.get(s.colorIndex), s);
        const data = { materialId: s.materialId, ...(link ?? {}) };
        if (multi) await tx.componentMaterial.updateMany({ where: { componentId, colorIndex: s.colorIndex }, data });
        else await tx.productComponent.update({ where: { id: componentId }, data });
      }
      if (matChanges.length) {
        const after = multi
          ? { ...comp, materials: comp.materials.map((m: any) => ({ ...m, materialId: slots.find((s) => s.colorIndex === m.colorIndex)?.materialId ?? m.materialId })) }
          : { ...comp, materialId: slots[0].materialId };
        const oldKey = baseColourKeyOf(comp);
        const newKey = baseColourKeyOf(after);
        const ids = [...ownSlotsOf(comp), ...ownSlotsOf(after)].map((x) => x.materialId);
        const r = await this.stock.rekeyBase(tx, componentId, oldKey, newKey, { userId, materials: await this.materialNames(tx, ids) });
        warnings.push(...r.warnings);
      }
    }, TX_OPTS);
    if (matChanges.length) await this.products.reprice(productId);
    return { ...(await this.detail(productId, componentId)), warnings: [...warnings, ...impactWarnings(impact)], impact };
  }

  /** P12. */
  async reorder(productId: string, body: unknown) {
    const { sizeOptionId, componentIds } = parseComponentOrder(body);
    const product = await this.prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!product) throw new NotFoundException('Product not found');
    if (sizeOptionId) {
      const size = await this.prisma.productVariant.findFirst({ where: { id: sizeOptionId, productId }, select: { kind: true } });
      if (!size) throw new NotFoundException('Size not found');
      if (size.kind === 'COLOUR') throw new BadRequestException("Colours use each size's components — add the component to a size");
    }
    const rows = await this.prisma.productComponent.findMany({ where: { productId, variantId: sizeOptionId }, select: { id: true } });
    const ids = new Set(rows.map((r: { id: string }) => r.id));
    if (ids.size !== componentIds.length || componentIds.some((id) => !ids.has(id))) {
      throw new BadRequestException('componentIds must list exactly the components of that size');
    }
    await this.prisma.$transaction(async (tx: any) => {
      for (let i = 0; i < componentIds.length; i++) await tx.productComponent.update({ where: { id: componentIds[i] }, data: { sortOrder: i } });
    }, TX_OPTS);
    return { ok: true };
  }

  /** P13: conditional set of one bucket; the base column also confirms it. */
  async setStock(productId: string, componentId: string, body: unknown, userId: string | null = null) {
    const input = parseStockSet(body);
    const comp = await this.owned(productId, componentId);
    let key = input.colourKey;
    if (key !== null) {
      const unknown = () => new BadRequestException(`Unknown colour for "${comp.description}"`);
      let slots: Array<{ colorIndex: number; materialId: string }>;
      try { slots = parseColourKey(key); } catch { throw unknown(); }
      const own = ownSlotsOf(comp).map((s) => s.colorIndex).sort((a, b) => a - b);
      const idx = slots.map((s) => s.colorIndex);
      if (own.length !== idx.length || own.some((v, i) => v !== idx[i])) throw unknown();
      const ids = [...new Set(slots.map((s) => s.materialId))];
      const found = await this.prisma.material.count({ where: { id: { in: ids } } });
      if (found !== ids.length) throw unknown();
      if (key === baseColourKeyOf(comp)) key = null;
    }
    return this.prisma.$transaction(async (tx: any) => {
      const credit = await this.stock.manualSet(tx, { componentId, colourKey: key, stockOnHand: input.stockOnHand, expectedStockOnHand: input.expectedStockOnHand, userId });
      const movement = await tx.componentStockMovement.findFirst({
        where: { componentId, colourKey: credit.colourKey, reason: 'MANUAL_ADJUST' },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (movement && input.note) await tx.componentStockMovement.update({ where: { id: movement.id }, data: { note: input.note } });
      return { stockOnHand: credit.balanceAfter, movementId: movement?.id ?? null };
    }, TX_OPTS);
  }

  /** P14 (and its alias). */
  async remove(productId: string | null, componentId: string) {
    const comp = await this.owned(productId, componentId);
    const files: Array<string | null> = [];
    await this.prisma.$transaction(async (tx: any) => {
      const open = await tx.productionJob.count({
        where: { status: { in: ACTIVE_JOBS }, OR: [{ componentId }, { plates: { some: { componentId } } }] },
      });
      if (open > 0) throw new ConflictException(`"${comp.description}" is used by ${open} open jobs — finish or cancel them first`);
      const row = await tx.productComponent.findUnique({ where: { id: componentId }, select: { stockOnHand: true } });
      const colour = await tx.componentColourStock.findMany({ where: { componentId, stockOnHand: { gt: 0 } }, select: { stockOnHand: true } });
      const units = Math.max(0, row?.stockOnHand ?? 0) + colour.reduce((s: number, r: any) => s + r.stockOnHand, 0);
      if (units > 0) throw new ConflictException(`"${comp.description}" has ${units} printed units in stock — set its stock to 0 first`);
      const layouts = await tx.plateLayout.findMany({ where: { componentId }, select: { attachmentId: true } });
      await tx.productComponent.delete({ where: { id: componentId } });
      const gone = await unreferencedAttachments(tx, [comp.attachmentId, comp.thumbnailAttachmentId, ...layouts.map((l: any) => l.attachmentId)]);
      if (gone.length) await tx.attachment.deleteMany({ where: { id: { in: gone.map((g) => g.id) } } });
      files.push(...gone.map((g) => g.abs));
    }, TX_OPTS);
    await unlinkAfterCommit(files);
    await this.products.reprice(comp.productId);
    return { deleted: true };
  }
}
