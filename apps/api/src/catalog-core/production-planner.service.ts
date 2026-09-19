import { Injectable } from '@nestjs/common';
import type { MaterialLite, OptionPair, Problem, Readiness, SurplusPolicy } from '@printforge/types';
import { PrismaService } from '../common/prisma/prisma.service';
import { colourLabel } from '../stock-ledger/colour-key';
import { BomResolverService, type ResolvedBom, type ResolvedComponent } from './bom-resolver.service';
import { CatalogRequestContext } from './catalog-context';
import { computeLineProgress, type ProgressJob, type ProgressMovement } from './line-progress';
import { gramsForPlan, PlanCache, PlanError, suggestPlan, unitsOf, validatePlan, type PlanEdit, type PlannedPlate } from './plate-planner';
import { pickSpools, type SpoolRow } from './spool-picker';

/**
 * Stock check and job filament plans (spec §3.7), shared by readiness, job
 * preview/create, order planning and order availability.
 */

export interface PlanOptionInput extends OptionPair {
  productId: string;
  quantity: number;
  surplusPolicy?: SurplusPolicy;
  /** user-edited plates; components not listed get the suggestion */
  plates?: PlanEdit[];
  /** units per component taken from printed stock */
  fromStock?: Record<string, number>;
  /** per-component units required, overriding component.quantity × quantity (remaining units) */
  unitsRequired?: Record<string, number>;
}

export interface PlannedSlot {
  colorIndex: number;
  materialId: string;
  /** own material the file was sliced with, when it differs */
  slicedMaterialId: string | null;
  colourSlotId: string | null;
  grams: number;
}

export interface PlannedComponent {
  componentId: string;
  description: string;
  isMultiColor: boolean;
  colourKey: string;
  baseColourKey: string;
  colourLabel: string;
  unitsRequired: number;
  fromStock: number;
  stockOnHand: number;
  plates: PlannedPlate[];
  unitsPrinted: number;
  surplus: number;
  printMinutes: number;
  slots: PlannedSlot[];
}

export interface FilamentNeed {
  materialId: string;
  slicedMaterialId: string | null;
  material: MaterialLite;
  grams: number;
}

export interface OptionPlan {
  bom: ResolvedBom;
  quantity: number;
  surplusPolicy: SurplusPolicy;
  components: PlannedComponent[];
  filamentNeeds: FilamentNeed[];
  totalMinutes: number;
  problems: Problem[];
  warnings: Problem[];
}

export interface FreeFilament {
  materials: Map<string, { totalStock: number; reserved: number; free: number }>;
  warnings: Problem[];
}

const ACTIVE = ['QUEUED', 'IN_PROGRESS', 'PAUSED'];
const RESERVING_ORDERS = ['CONFIRMED', 'IN_PRODUCTION'];

/** Pure: plan a resolved BOM. */
export function planFromBom(
  bom: ResolvedBom,
  input: Omit<PlanOptionInput, 'productId' | 'sizeOptionId' | 'colourOptionId'> & { surplusPolicy: SurplusPolicy },
  materials: ReadonlyMap<string, MaterialLite>,
  cache: PlanCache = new PlanCache(),
): OptionPlan {
  const problems: Problem[] = [];
  const components: PlannedComponent[] = [];
  const needs = new Map<string, FilamentNeed>();
  let totalMinutes = 0;

  for (const c of bom.components) {
    const fromStock = Math.max(0, input.fromStock?.[c.componentId] ?? 0);
    const base = input.unitsRequired?.[c.componentId] ?? c.quantity * input.quantity;
    const R = Math.max(0, base - fromStock);
    let plates: PlannedPlate[] = [];
    const edits = input.plates?.filter((p) => p.componentId === c.componentId);
    if (edits && edits.length) {
      plates = validatePlan(c, R, edits);
    } else {
      try {
        plates = suggestPlan(R, c.layouts, cache);
      } catch (e) {
        if (!(e instanceof PlanError)) throw e;
        problems.push({ code: 'NO_USABLE_LAYOUT', componentId: c.componentId, message: `"${c.description}" has no usable plate layout — slice it or enter its grams and minutes` });
      }
    }
    const unitsPrinted = unitsOf(plates);
    const printMinutes = plates.reduce((s, p) => s + p.plateCount * p.layout.plateMinutes, 0);
    totalMinutes += printMinutes;
    const slots = c.slots.map((s) => ({
      colorIndex: s.colorIndex,
      materialId: s.materialId,
      slicedMaterialId: s.baseMaterialId !== s.materialId ? s.baseMaterialId : null,
      colourSlotId: s.colourSlotId,
      grams: gramsForPlan(plates, s.colorIndex, R, input.surplusPolicy),
    }));
    for (const s of slots) {
      const key = `${s.materialId}|${s.slicedMaterialId ?? ''}`;
      const n = needs.get(key) ?? { materialId: s.materialId, slicedMaterialId: s.slicedMaterialId, material: c.slots.find((x) => x.colorIndex === s.colorIndex)!.material, grams: 0 };
      n.grams += s.grams;
      needs.set(key, n);
    }
    components.push({
      componentId: c.componentId, description: c.description, isMultiColor: c.isMultiColor,
      colourKey: c.colourKey, baseColourKey: c.baseColourKey,
      colourLabel: c.colourKey ? colourLabel(c.colourKey, materials) : '',
      unitsRequired: R, fromStock, stockOnHand: c.stockOnHand, plates, unitsPrinted,
      surplus: Math.max(0, unitsPrinted - R), printMinutes, slots,
    });
  }
  return {
    bom, quantity: input.quantity, surplusPolicy: input.surplusPolicy, components,
    filamentNeeds: [...needs.values()].filter((n) => n.grams > 0),
    totalMinutes, problems, warnings: [...bom.warnings],
  };
}

@Injectable()
export class ProductionPlannerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: BomResolverService,
  ) {}

  /** Resolve the pair and plan it (§3.7 planOption). */
  async planOption(input: PlanOptionInput, ctx = new CatalogRequestContext()): Promise<OptionPlan> {
    const config = await this.resolver.requireConfig(input.productId, ctx);
    const bom = await this.resolver.resolve(input.productId, { sizeOptionId: input.sizeOptionId, colourOptionId: input.colourOptionId }, ctx);
    return planFromBom(bom, { ...input, surplusPolicy: input.surplusPolicy ?? config.product.surplusPolicy }, config.materials, ctx.planCache);
  }

  /** Jobs and ledger rows of a set of order lines, grouped per line (for computeLineProgress). */
  async loadLineActivity(orderItemIds: string[]) {
    const jobs = orderItemIds.length
      ? await this.prisma.productionJob.findMany({
          where: { orderItemId: { in: orderItemIds } },
          select: {
            id: true, orderItemId: true, status: true, componentId: true, productId: true,
            quantityToProduce: true, reprintOfId: true,
            plates: { select: { componentId: true, unitsRequired: true } },
          },
        })
      : [];
    const moves = orderItemIds.length
      ? await this.prisma.componentStockMovement.findMany({
          where: { orderItemId: { in: orderItemIds }, reason: { in: ['PLAN_ALLOCATE', 'PLAN_RELEASE'] } },
          select: { orderItemId: true, componentId: true, colourKey: true, delta: true, reason: true },
        })
      : [];
    const jobsByItem = new Map<string, ProgressJob[]>();
    for (const j of jobs) {
      const list = jobsByItem.get(j.orderItemId!) ?? [];
      list.push(j as ProgressJob);
      jobsByItem.set(j.orderItemId!, list);
    }
    const movesByItem = new Map<string, ProgressMovement[]>();
    for (const m of moves) {
      const list = movesByItem.get(m.orderItemId!) ?? [];
      list.push(m as ProgressMovement);
      movesByItem.set(m.orderItemId!, list);
    }
    return { jobsByItem, movesByItem };
  }

  /**
   * Free filament = active spool weight − reserved (§3.7). Reserved =
   *   planOption(remaining units) of every line of other CONFIRMED/IN_PRODUCTION
   *   orders (lines with jobs on old components excepted), plus the JobMaterial
   *   grams of every active job outside the excluded order — each job once.
   */
  async freeFilament(materialIds: string[] | null, opts: { excludeOrderId?: string | null; ctx?: CatalogRequestContext } = {}): Promise<FreeFilament> {
    const ctx = opts.ctx ?? new CatalogRequestContext();
    const warnings: Problem[] = [];
    const reserved = new Map<string, number>();
    const add = (id: string, g: number) => reserved.set(id, (reserved.get(id) ?? 0) + g);

    const orders = await this.prisma.order.findMany({
      where: { status: { in: RESERVING_ORDERS as any }, ...(opts.excludeOrderId ? { id: { not: opts.excludeOrderId } } : {}) },
      select: {
        id: true, orderNumber: true,
        items: { select: { id: true, productId: true, variantId: true, sizeOptionId: true, colourOptionId: true, quantity: true, description: true } },
      },
    });
    const items = orders.flatMap((o) => o.items.map((i) => ({ ...i, orderNumber: o.orderNumber })));
    const productItems = items.filter((i) => i.productId || i.variantId || i.sizeOptionId || i.colourOptionId);
    const { jobsByItem, movesByItem } = await this.loadLineActivity(productItems.map((i) => i.id));
    await this.resolver.preloadVariants(productItems.flatMap((i) => [i.variantId, i.sizeOptionId, i.colourOptionId]).filter((x): x is string => !!x), ctx);

    for (const item of productItems) {
      const res = await this.resolver.resolveForLine(item, `Order ${item.orderNumber}`, ctx);
      if (res.skip) {
        warnings.push(res.warning);
        continue;
      }
      const progress = computeLineProgress(item, res.bom, jobsByItem.get(item.id) ?? [], movesByItem.get(item.id) ?? []);
      if (progress.jobsOnOldComponents.jobCount > 0) {
        warnings.push({
          code: 'JOBS_ON_OLD_COMPONENTS',
          message: `Order ${item.orderNumber} line "${item.description}": ${progress.jobsOnOldComponents.jobCount} jobs for this line use components no longer in its bill of materials — only their filament is reserved`,
        });
        continue; // their active JobMaterial grams are counted with the jobs below
      }
      const unitsRequired: Record<string, number> = {};
      for (const [cid, p] of progress.components) unitsRequired[cid] = p.remaining;
      if (Object.values(unitsRequired).every((r) => r === 0)) continue;
      const config = await this.resolver.requireConfig(res.bom.productId, ctx);
      const plan = planFromBom(res.bom, { quantity: item.quantity, unitsRequired, surplusPolicy: config.product.surplusPolicy }, config.materials, ctx.planCache);
      for (const n of plan.filamentNeeds) add(n.materialId, n.grams);
    }

    const jobs = await this.prisma.productionJob.findMany({
      where: {
        status: { in: ACTIVE as any },
        ...(opts.excludeOrderId ? { OR: [{ orderId: null }, { orderId: { not: opts.excludeOrderId } }] } : {}),
      },
      select: { id: true, materials: { select: { materialId: true, gramsUsed: true } } },
    });
    for (const j of jobs) for (const m of j.materials) add(m.materialId, m.gramsUsed);

    const ids = materialIds ?? [...reserved.keys()];
    const stock = ids.length
      ? await this.prisma.spool.groupBy({ by: ['materialId'], where: { materialId: { in: ids }, isActive: true }, _sum: { currentWeight: true } })
      : [];
    const stockMap = new Map(stock.map((s: any) => [s.materialId, Number(s._sum?.currentWeight ?? 0)]));
    const materials = new Map<string, { totalStock: number; reserved: number; free: number }>();
    for (const id of ids) {
      const total = stockMap.get(id) ?? 0;
      const r = reserved.get(id) ?? 0;
      materials.set(id, { totalStock: total, reserved: r, free: Math.max(0, total - r) });
    }
    return { materials, warnings };
  }

  /** Σ JobMaterial grams of active jobs per spool (pickSpools netting). */
  async reservedBySpool(): Promise<Map<string, number>> {
    const rows = await this.prisma.jobMaterial.groupBy({
      by: ['spoolId'],
      where: { spoolId: { not: null }, job: { status: { in: ACTIVE as any } } },
      _sum: { gramsUsed: true },
    });
    return new Map(rows.filter((r: any) => r.spoolId).map((r: any) => [r.spoolId as string, Number(r._sum?.gramsUsed ?? 0)]));
  }

  /** Active spools of the needs' material types, lightest first. */
  async spoolsFor(needs: ReadonlyArray<{ material: { type: string } }>): Promise<SpoolRow[]> {
    const types = [...new Set(needs.map((n) => n.material.type).filter(Boolean))];
    if (!types.length) return [];
    return (await this.prisma.spool.findMany({
      where: { isActive: true, currentWeight: { gt: 0 }, material: { type: { in: types as any } } },
      include: { material: true, location: { select: { id: true, name: true } } },
      orderBy: { currentWeight: 'asc' },
    })) as unknown as SpoolRow[];
  }

  /**
   * P20 readiness / J2 preview (§3.7 "Two different questions, two labelled
   * answers"): per filament, "after open orders" and "spool to use", never merged.
   */
  async readiness(
    productId: string,
    pair: OptionPair,
    qty: number,
    opts: { surplusPolicy?: SurplusPolicy; plates?: PlanEdit[]; excludeOrderId?: string | null; ctx?: CatalogRequestContext } = {},
  ): Promise<Readiness> {
    const ctx = opts.ctx ?? new CatalogRequestContext();
    const plan = await this.planOption({ productId, ...pair, quantity: qty, surplusPolicy: opts.surplusPolicy, plates: opts.plates }, ctx);
    const needs = plan.filamentNeeds;
    const free = await this.freeFilament([...new Set(needs.map((n) => n.materialId))], { excludeOrderId: opts.excludeOrderId, ctx });
    const picks = pickSpools(needs, await this.spoolsFor(needs), { reservedBySpool: await this.reservedBySpool() });

    const filament = needs.map((n, i) => {
      const f = free.materials.get(n.materialId) ?? { totalStock: 0, reserved: 0, free: 0 };
      const p = picks[i];
      const gramsNeeded = Math.round(n.grams * 10) / 10;
      return {
        materialId: n.materialId,
        label: n.material.name,
        colorHex: n.material.colorHex,
        slicedMaterialId: n.slicedMaterialId,
        gramsNeeded,
        totalStock: Math.round(f.totalStock),
        reserved: Math.round(f.reserved),
        free: Math.round(f.free),
        hasEnough: f.free >= n.grams,
        suggestedSpool: p.spool
          ? { id: p.spool.id, pfid: p.spool.printforgeId ?? null, location: p.spool.location?.name ?? null, effectiveRemaining: Math.round(p.effectiveRemaining) }
          : null,
        spoolHasEnough: p.hasEnough,
      };
    });

    const config = await this.resolver.requireConfig(productId, ctx);
    const parts = config.parts.map((p) => {
      const needed = p.quantity * qty;
      return { partId: p.partId, name: p.name, needed, stockQty: p.stockQty, reserved: 0, free: p.stockQty, hasEnough: p.stockQty >= needed };
    });
    const problems = [...plan.bom.problems.filter((p) => p.code !== 'MATERIAL_ZERO_COST'), ...plan.problems];
    return {
      option: { sizeOptionId: plan.bom.sizeOptionId, colourOptionId: plan.bom.colourOptionId, label: plan.bom.label, fallbackToBase: plan.bom.fallbackToBase },
      qty,
      surplusPolicy: plan.surplusPolicy,
      productionReady: plan.bom.productionReady,
      components: plan.components.map((c) => ({
        componentId: c.componentId, description: c.description, colourKey: c.colourKey, colourLabel: c.colourLabel,
        unitsRequired: c.unitsRequired, stockOnHand: c.stockOnHand,
        plates: c.plates.map((p) => ({ layoutId: p.layout.layoutId, label: p.layout.label, unitsPerPlate: p.layout.unitsPerPlate, plateCount: p.plateCount })),
        unitsPrinted: c.unitsPrinted, surplus: c.surplus, printMinutes: c.printMinutes, creditOnComplete: null,
      })),
      filament,
      parts,
      ready: plan.bom.productionReady && plan.problems.length === 0 && filament.every((f) => f.hasEnough) && parts.every((p) => p.hasEnough),
      problems,
      warnings: [...plan.warnings, ...free.warnings],
    };
  }
}

export type { ResolvedComponent };
