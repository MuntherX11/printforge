import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { ComponentDetail, Problem } from '@printforge/types';
import { BomResolverService } from '../catalog-core/bom-resolver.service';
import type { ProductConfig } from '../catalog-core/catalog-config';
import { MAX_COLOUR_SLOTS, proposeLinks, type LinkComponent } from '../catalog-core/colour-link-proposal';
import { OpenLinesImpactService } from '../catalog-core/open-lines-impact.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { isMultiColourComponent } from '../stock-ledger/colour-key';
import { parseColourLinks, parseSlotName, parseSlotPatch, type LinkInput } from './product-input';
import { impactWarnings, lockProduct, mergeImpact, requireConfirm, TX_OPTS } from './product-locks';
import { ProductsService } from './products.service';

/**
 * Product colour slots and component colour links (spec §3.3, §4.1 C1–C5).
 * None of these routes reprices: colour never sets a price (§3.8).
 */

const TOO_MANY = `A product can have at most ${MAX_COLOUR_SLOTS} colour slots`;
const dup = (name: string) => new ConflictException(`A colour slot named "${name}" already exists`);

function ownSlots(c: ProductConfig['components'][number]) {
  return isMultiColourComponent(c)
    ? c.materials.map((m) => ({ colorIndex: m.colorIndex, materialId: m.materialId, colourSlotId: m.colourSlotId, colourFixed: m.colourFixed }))
    : c.materialId ? [{ colorIndex: 0, materialId: c.materialId, colourSlotId: c.colourSlotId, colourFixed: c.colourFixed }] : [];
}

/** Final slot names after renames and creations: 409 on a case-insensitive clash, 400 over the cap. */
function checkNames(existing: Array<{ id: string; name: string }>, renames: Array<{ id: string; name: string }>, created: string[]) {
  const names = existing.map((s) => renames.find((r) => r.id === s.id)?.name ?? s.name).concat(created);
  const seen = new Set<string>();
  for (const n of names) {
    const k = n.toLowerCase();
    if (seen.has(k)) throw dup(n);
    seen.add(k);
  }
  if (names.length > MAX_COLOUR_SLOTS) throw new BadRequestException(TOO_MANY);
}

@Injectable()
export class ColourSlotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
    private readonly resolver: BomResolverService,
    private readonly impact: OpenLinesImpactService,
  ) {}

  private async slot(productId: string, slotId: string) {
    const s = await this.prisma.productColourSlot.findFirst({ where: { id: slotId, productId } });
    if (!s) throw new NotFoundException('Colour slot not found');
    return s;
  }

  /** C1. */
  async create(productId: string, body: unknown) {
    const name = parseSlotName(body);
    return this.prisma.$transaction(async (tx: any) => {
      if (!(await lockProduct(tx, productId, 'UPDATE'))) throw new NotFoundException('Product not found');
      const existing = await tx.productColourSlot.findMany({ where: { productId }, select: { id: true, name: true, sortOrder: true } });
      if (existing.some((s: any) => s.name.toLowerCase() === name.toLowerCase())) throw dup(name);
      if (existing.length >= MAX_COLOUR_SLOTS) throw new BadRequestException(TOO_MANY);
      const sortOrder = existing.length ? Math.max(...existing.map((s: any) => s.sortOrder)) + 1 : 0;
      return tx.productColourSlot.create({ data: { productId, name, sortOrder }, select: { id: true, name: true, sortOrder: true } });
    }, TX_OPTS);
  }

  /** C2. */
  async update(productId: string, slotId: string, body: unknown) {
    const input = parseSlotPatch(body);
    await this.slot(productId, slotId);
    return this.prisma.$transaction(async (tx: any) => {
      await lockProduct(tx, productId, 'UPDATE');
      if (input.name !== undefined) {
        const clash = await tx.productColourSlot.findFirst({ where: { productId, name: { equals: input.name, mode: 'insensitive' }, NOT: { id: slotId } } });
        if (clash) throw dup(input.name);
      }
      return tx.productColourSlot.update({ where: { id: slotId }, data: input, select: { id: true, name: true, sortOrder: true } });
    }, TX_OPTS);
  }

  /** C3: its links become Fixed and its assignments go, in one transaction. */
  async remove(productId: string, slotId: string, dryRun: boolean, confirm: boolean) {
    const slot = await this.slot(productId, slotId);
    const config = await this.resolver.requireConfig(productId);
    const impact = await this.impact.compute(productId, { kind: 'SLOT_DELETE', colourSlotId: slotId });
    if (dryRun) {
      const links = config.components.flatMap((c) =>
        ownSlots(c).filter((s) => s.colourSlotId === slotId).map((s) => ({ componentId: c.id, description: c.description, sizeOptionId: c.variantId, colorIndex: s.colorIndex })));
      const assignments = config.options.flatMap((o) =>
        o.assignments.filter((a) => a.colourSlotId === slotId).map((a) => ({ colourOptionId: o.id, name: o.name, materialId: a.materialId, materialName: config.materials.get(a.materialId)?.name ?? null })));
      return { links, assignments, impact };
    }
    requireConfirm(impact, confirm);
    const out = await this.prisma.$transaction(async (tx: any) => {
      const fixedComponents = (await tx.productComponent.updateMany({ where: { colourSlotId: slot.id }, data: { colourSlotId: null, colourFixed: true } })).count;
      const fixedSlots = (await tx.componentMaterial.updateMany({ where: { colourSlotId: slot.id }, data: { colourSlotId: null, colourFixed: true } })).count;
      const assignmentsRemoved = (await tx.colourOptionSlot.deleteMany({ where: { colourSlotId: slot.id } })).count;
      await tx.productColourSlot.delete({ where: { id: slot.id } });
      return { fixed: fixedComponents + fixedSlots, assignmentsRemoved };
    }, TX_OPTS);
    return { deleted: true, ...out, impact, warnings: impactWarnings(impact) };
  }

  /** C4: the single save of ColourLinksDialog — slots created/renamed and links, in one transaction. */
  async saveLinks(productId: string, body: unknown, dryRun: boolean) {
    const input = parseColourLinks(body);
    const config = await this.resolver.requireConfig(productId);
    for (const s of input.slots) if (s.id && !config.colourSlots.some((x) => x.id === s.id)) throw new BadRequestException('Unknown colour slot');
    const renames = input.slots.filter((s) => s.id).map((s) => ({ id: s.id!, name: s.name }));
    const created = input.slots.filter((s) => s.ref);
    checkNames(config.colourSlots, renames, created.map((s) => s.name));
    const refs = new Set(created.map((s) => s.ref));

    const seen = new Set<string>();
    for (const l of input.links) {
      const comp = config.components.find((c) => c.id === l.componentId);
      if (!comp) throw new NotFoundException('Component not found');
      if (!ownSlots(comp).some((s) => s.colorIndex === l.colorIndex)) throw new BadRequestException(`"${comp.description}" has no colour ${l.colorIndex + 1}`);
      if (l.colourSlotId && !config.colourSlots.some((s) => s.id === l.colourSlotId)) throw new BadRequestException('Unknown colour slot');
      if (l.slotRef && !refs.has(l.slotRef)) throw new BadRequestException('Unknown colour slot');
      const k = `${l.componentId}:${l.colorIndex}`;
      if (seen.has(k)) throw new BadRequestException(`"${comp.description}" colour ${l.colorIndex + 1} is listed twice`);
      seen.add(k);
    }

    const impact = input.links.length
      ? mergeImpact(await this.impact.compute(productId, {
          kind: 'LINKS',
          links: input.links.map((l) => ({ componentId: l.componentId, colorIndex: l.colorIndex, colourSlotId: l.colourSlotId ?? (l.slotRef ? `ref:${l.slotRef}` : null), fixed: l.fixed })),
        }))
      : [];
    if (dryRun) return { impact };
    requireConfirm(impact, input.confirm);

    await this.prisma.$transaction(async (tx: any) => {
      await lockProduct(tx, productId, 'UPDATE');
      const existing = await tx.productColourSlot.findMany({ where: { productId }, select: { id: true, name: true, sortOrder: true } });
      checkNames(existing, renames, created.map((s) => s.name));
      const refIds = new Map<string, string>();
      let next = existing.length ? Math.max(...existing.map((s: any) => s.sortOrder)) + 1 : 0;
      for (const r of renames) await tx.productColourSlot.update({ where: { id: r.id }, data: { name: r.name } });
      for (const s of created) {
        const row = await tx.productColourSlot.create({ data: { productId, name: s.name, sortOrder: next++ }, select: { id: true } });
        refIds.set(s.ref!, row.id);
      }
      for (const l of input.links) await this.writeLink(tx, config, l, refIds);
    }, TX_OPTS);

    const detail = await this.products.findOne(productId);
    const ids = new Set(input.links.map((l) => l.componentId));
    const components: ComponentDetail[] = [...detail.components, ...detail.sizes.flatMap((s) => s.components)].filter((c) => ids.has(c.id));
    const warnings: Problem[] = [...detail.warnings.filter((w) => w.code === 'SLOT_STANDARD_MIXED'), ...impactWarnings(impact)];
    return { slots: detail.colourSlots.map((s) => ({ id: s.id, name: s.name, sortOrder: s.sortOrder })), components, warnings, impact };
  }

  private async writeLink(tx: any, config: ProductConfig, l: LinkInput, refIds: Map<string, string>) {
    const colourSlotId = l.colourSlotId ?? (l.slotRef ? refIds.get(l.slotRef)! : null);
    const data = colourSlotId ? { colourSlotId, colourFixed: null } : l.fixed ? { colourSlotId: null, colourFixed: true } : { colourSlotId: null, colourFixed: null };
    const comp = config.components.find((c) => c.id === l.componentId)!;
    if (isMultiColourComponent(comp)) await tx.componentMaterial.updateMany({ where: { componentId: comp.id, colorIndex: l.colorIndex }, data });
    else await tx.productComponent.update({ where: { id: comp.id }, data });
  }

  /** C5: read-only "Link by filament" proposal. */
  async proposal(productId: string) {
    const config = await this.resolver.requireConfig(productId);
    const components: LinkComponent[] = config.components.map((c) => ({
      id: c.id, description: c.description, variantId: c.variantId, sortOrder: c.sortOrder, createdAt: c.createdAt,
      isMultiColor: isMultiColourComponent(c), slots: ownSlots(c),
    }));
    const p = proposeLinks({ components, colourSlots: config.colourSlots, materials: config.materials });
    return {
      newSlots: p.newSlots,
      links: p.links.map((l) => ({ componentId: l.componentId, colorIndex: l.colorIndex, colourSlotId: l.colourSlotId ?? null, slotRef: l.ref ?? null, fixed: !!l.fixed })),
    };
  }
}
