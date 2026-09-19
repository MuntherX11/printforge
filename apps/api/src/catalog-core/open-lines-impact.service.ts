import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { BomResolverService, type ResolvedBom } from './bom-resolver.service';
import { cloneConfig, type ProductConfig } from './catalog-config';
import { CatalogRequestContext } from './catalog-context';
import { computeLineProgress } from './line-progress';
import { sizeKey } from './option-pair';
import { ProductionPlannerService } from './production-planner.service';

/**
 * "Changes that affect sold lines" (spec §3.3). Lines store only their pair and
 * the filament is resolved when the line is planned, so O5, C3, C4, P10/P11 and
 * O5 exclusions change what open, not-yet-planned work prints in. This resolves
 * every distinct pair of the product's open lines with the current configuration
 * and with the change applied in memory, and lists the lines that differ.
 */

export type ConfigChange =
  /** O5: replaces all assignments of a colour (materialId null = no row) */
  | { kind: 'ASSIGNMENTS'; colourOptionId: string; assignments: Array<{ colourSlotId: string; materialId: string | null }> }
  /** O5 excludedSizeKeys */
  | { kind: 'EXCLUSIONS'; colourOptionId: string; excludedSizeKeys: string[] }
  /** C3: slot deleted; its links become Fixed, its assignments go */
  | { kind: 'SLOT_DELETE'; colourSlotId: string }
  /** C4: links (colourSlotId null + fixed false/absent = unlinked) */
  | { kind: 'LINKS'; links: Array<{ componentId: string; colorIndex: number; colourSlotId: string | null; fixed?: boolean }> }
  /** P10/P11: a component's own filament(s) */
  | { kind: 'COMPONENT_MATERIAL'; componentId: string; materialId?: string | null; slots?: Array<{ colorIndex: number; materialId: string }> };

export interface OpenLineImpact {
  kind: 'ORDER' | 'QUOTE';
  lineId: string;
  number: string;
  description: string;
  quantity: number;
  changes: string[];
  partlyPlanned: boolean;
}

/** Apply a change to a cloned config (never the caller's). */
export function applyChange(config: ProductConfig, change: ConfigChange, extraMaterials: ProductConfig['materials'] = new Map()): ProductConfig {
  const next = cloneConfig(config);
  for (const [id, m] of extraMaterials) if (!next.materials.has(id)) next.materials.set(id, m);
  switch (change.kind) {
    case 'ASSIGNMENTS': {
      const o = next.options.find((x) => x.id === change.colourOptionId);
      if (o) o.assignments = change.assignments.filter((a): a is { colourSlotId: string; materialId: string } => !!a.materialId);
      break;
    }
    case 'EXCLUSIONS': {
      const o = next.options.find((x) => x.id === change.colourOptionId);
      if (o) o.excludedSizeKeys = [...change.excludedSizeKeys];
      break;
    }
    case 'SLOT_DELETE': {
      for (const c of next.components) {
        if (c.colourSlotId === change.colourSlotId) { c.colourSlotId = null; c.colourFixed = true; }
        for (const m of c.materials) if (m.colourSlotId === change.colourSlotId) { m.colourSlotId = null; m.colourFixed = true; }
      }
      for (const o of next.options) o.assignments = o.assignments.filter((a) => a.colourSlotId !== change.colourSlotId);
      next.colourSlots = next.colourSlots.filter((s) => s.id !== change.colourSlotId);
      break;
    }
    case 'LINKS': {
      for (const l of change.links) {
        const c = next.components.find((x) => x.id === l.componentId);
        if (!c) continue;
        const target = c.materials.length && (c.isMultiColor || !c.materialId) ? c.materials.find((m) => m.colorIndex === l.colorIndex) : l.colorIndex === 0 ? c : null;
        if (!target) continue;
        target.colourSlotId = l.colourSlotId;
        target.colourFixed = l.colourSlotId ? null : l.fixed ? true : null;
      }
      break;
    }
    case 'COMPONENT_MATERIAL': {
      const c = next.components.find((x) => x.id === change.componentId);
      if (!c) break;
      if (change.materialId !== undefined) c.materialId = change.materialId;
      for (const s of change.slots ?? []) {
        const m = c.materials.find((x) => x.colorIndex === s.colorIndex);
        if (m) m.materialId = s.materialId;
      }
      break;
    }
  }
  return next;
}

function materialsOfChange(change: ConfigChange): string[] {
  if (change.kind === 'ASSIGNMENTS') return change.assignments.map((a) => a.materialId).filter((x): x is string => !!x);
  if (change.kind === 'COMPONENT_MATERIAL') return [change.materialId ?? '', ...(change.slots ?? []).map((s) => s.materialId)].filter(Boolean);
  return [];
}

/** Human list of what resolves differently, e.g. `Tin: PLA Red → PLA Crimson on Large Box, Large Lid`. */
export function describeDifferences(before: ResolvedBom, after: ResolvedBom): string[] {
  const groups = new Map<string, string[]>();
  for (const c of before.components) {
    const a = after.components.find((x) => x.componentId === c.componentId);
    if (!a) continue;
    for (const s of c.slots) {
      const t = a.slots.find((x) => x.colorIndex === s.colorIndex);
      if (!t || t.materialId === s.materialId) continue;
      const name = s.colourSlotName ?? t.colourSlotName;
      const head = name ? `${name}: ${s.material.name} → ${t.material.name}` : `"${c.description}" colour ${s.colorIndex + 1}: ${s.material.name} → ${t.material.name}`;
      const list = groups.get(head) ?? [];
      if (!list.includes(c.description)) list.push(c.description);
      groups.set(head, list);
    }
  }
  return [...groups.entries()].map(([head, comps]) => (head.startsWith('"') ? head : `${head} on ${comps.join(', ')}`));
}

@Injectable()
export class OpenLinesImpactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: BomResolverService,
    private readonly planner: ProductionPlannerService,
  ) {}

  async compute(productId: string, change: ConfigChange, ctx = new CatalogRequestContext()): Promise<OpenLineImpact[]> {
    const config = await this.resolver.requireConfig(productId, ctx);
    const newIds = materialsOfChange(change).filter((id) => !config.materials.has(id));
    const extra = new Map<string, any>();
    if (newIds.length) {
      const rows = await this.prisma.material.findMany({ where: { id: { in: newIds } } });
      for (const m of rows as any[]) {
        extra.set(m.id, { id: m.id, name: m.name, type: m.type, color: m.color ?? null, colorHex: m.colorHex ?? null, brand: m.brand ?? null, costPerGram: Number(m.costPerGram ?? 0) });
      }
    }
    const changed = applyChange(config, change, extra);

    const orderItems = await this.prisma.orderItem.findMany({
      where: { productId, order: { status: { in: ['CONFIRMED', 'IN_PRODUCTION'] as any } } },
      select: { id: true, productId: true, variantId: true, sizeOptionId: true, colourOptionId: true, quantity: true, description: true, order: { select: { orderNumber: true } } },
    });
    const quoteItems = await this.prisma.quoteItem.findMany({
      where: { productId, quote: { status: { in: ['DRAFT', 'SENT'] as any } } },
      select: { id: true, productId: true, sizeOptionId: true, colourOptionId: true, quantity: true, description: true, quote: { select: { quoteNumber: true } } },
    });
    const { jobsByItem, movesByItem } = await this.planner.loadLineActivity(orderItems.map((i) => i.id));

    const memo = new Map<string, string[] | null>();
    const diff = (pair: { sizeOptionId: string | null; colourOptionId: string | null }, before: ResolvedBom): string[] => {
      const k = `${pair.sizeOptionId ?? ''}|${pair.colourOptionId ?? ''}`;
      if (!memo.has(k)) {
        let out: string[] = [];
        try {
          const after = this.resolver.resolveWithConfig(changed, pair);
          out = describeDifferences(before, after);
        } catch {
          out = [];
        }
        if (change.kind === 'EXCLUSIONS' && pair.colourOptionId === change.colourOptionId) {
          const was = config.options.find((o) => o.id === pair.colourOptionId)?.excludedSizeKeys.includes(sizeKey(pair.sizeOptionId));
          if (!was && change.excludedSizeKeys.includes(sizeKey(pair.sizeOptionId))) out.push(`${before.colourLabel} won't be made in ${before.sizeLabel} any more`);
        }
        memo.set(k, out);
      }
      return memo.get(k) ?? [];
    };

    const impact: OpenLineImpact[] = [];
    for (const item of orderItems) {
      const res = await this.resolver.resolveForLine(item, `Order ${item.order.orderNumber}`, ctx);
      if (res.skip) continue;
      const progress = computeLineProgress(item, res.bom, jobsByItem.get(item.id) ?? [], movesByItem.get(item.id) ?? []);
      if (![...progress.components.values()].some((p) => p.remaining > 0)) continue;
      const changes = diff(res.pair, res.bom);
      if (!changes.length) continue;
      impact.push({ kind: 'ORDER', lineId: item.id, number: item.order.orderNumber, description: item.description, quantity: item.quantity, changes, partlyPlanned: progress.partlyPlanned });
    }
    for (const item of quoteItems) {
      const res = await this.resolver.resolveForLine(item, `Quote ${item.quote.quoteNumber}`, ctx);
      if (res.skip) continue;
      const changes = diff(res.pair, res.bom);
      if (!changes.length) continue;
      impact.push({ kind: 'QUOTE', lineId: item.id, number: item.quote.quoteNumber, description: item.description, quantity: item.quantity, changes, partlyPlanned: false });
    }
    return impact;
  }
}
