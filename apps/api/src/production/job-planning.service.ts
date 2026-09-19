import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PlanRow, Problem, SurplusPolicy } from '@printforge/types';
import { createHash } from 'crypto';
import { BomResolverService, type ResolvedBom, type ResolvedComponent } from '../catalog-core/bom-resolver.service';
import { CatalogRequestContext } from '../catalog-core/catalog-context';
import { computeLineProgress } from '../catalog-core/line-progress';
import { mapLegacyVariantId, validatePair } from '../catalog-core/option-pair';
import { PlanError, suggestPlan, validatePlan, type PlannedPlate } from '../catalog-core/plate-planner';
import { planFromBom, ProductionPlannerService, type OptionPlan } from '../catalog-core/production-planner.service';
import { pickSpools, type SpoolRow } from '../catalog-core/spool-picker';
import { PrismaService } from '../common/prisma/prisma.service';
import { lockOptions, TX_OPTS } from '../products/product-locks';
import { colourLabel } from '../stock-ledger/colour-key';
import { ProductStockService, suggestFromStock } from '../stock-ledger/product-stock.service';
import { creditUnits, materialLines, plateRows, singlePlateFilename } from './job-builder';
import { parsePlanSubmit, parsePreview, type PlanRowInput } from './job-input';

/**
 * Order production planning (spec §4.4 J4/J5, §4.4.1 PlanRow) and the job
 * preview (J2). Rows are per (order line, component of the line's resolved BOM);
 * "remaining" comes from catalog-core's computeLineProgress, so it means the same
 * thing here, in reservations (freeFilament) and in open-line impact.
 */

/** A J4 row plus what J5 needs to create its job (never sent to the client). */
interface RowPlan {
  row: PlanRow;
  bom: ResolvedBom;
  component: ResolvedComponent;
  sizeName: string | null;
  colourName: string | null;
  /** planning problem of the suggestion (NO_USABLE_LAYOUT) */
  problem: Problem | null;
}

interface ComputedPlan {
  order: any;
  planVersion: string;
  rows: RowPlan[];
  warnings: Problem[];
}

export interface PlanResult {
  jobsCreated: number;
  jobs: any[];
  allocations: Array<{ rowKey: string; fromStock: number }>;
  warnings: Problem[];
}

const NO_SLICED_DATA = (desc: string) => `"${desc}" has no sliced data — add its grams and minutes or a plate layout`;

function planComponent(component: ResolvedComponent, R: number, cacheBom: ResolvedBom, config: any, ctx: CatalogRequestContext, policy: SurplusPolicy, plates?: Array<{ layoutId: string | null; plateCount: number }>): OptionPlan {
  const bom = { ...cacheBom, components: [component] };
  return planFromBom(
    bom,
    {
      quantity: 1,
      unitsRequired: { [component.componentId]: R },
      surplusPolicy: policy,
      plates: plates?.map((p) => ({ componentId: component.componentId, layoutId: p.layoutId, plateCount: p.plateCount })),
    },
    config.materials,
    ctx.planCache,
  );
}

@Injectable()
export class JobPlanningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: BomResolverService,
    private readonly planner: ProductionPlannerService,
    private readonly stock: ProductStockService,
  ) {}

  // ------------------------------------------------------------------ J4

  async previewPlan(orderId: string) {
    const plan = await this.computePlan(orderId);
    return { order: plan.order, planVersion: plan.planVersion, rows: plan.rows.map((r) => r.row), warnings: plan.warnings };
  }

  /** J4's computation. Reads committed state; J5 runs it again inside its advisory lock. */
  private async computePlan(orderId: string): Promise<ComputedPlan> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, customer: { select: { id: true, name: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');

    const ctx = new CatalogRequestContext();
    const warnings: Problem[] = [];
    const items = (order.items ?? []).filter((i: any) => i.productId || i.variantId || i.sizeOptionId || i.colourOptionId);
    const { jobsByItem, movesByItem } = await this.planner.loadLineActivity(items.map((i: any) => i.id));
    const platesByItem = await this.platesOfItems(items.map((i: any) => i.id));
    const reservedBySpool = await this.planner.reservedBySpool();
    const extraMaterials = new Map<string, { name: string }>();

    const out: RowPlan[] = [];
    for (const item of items as any[]) {
      const res = await this.resolver.resolveForLine(item, `Order ${order.orderNumber}`, ctx);
      if (res.skip) {
        warnings.push(res.warning);
        continue;
      }
      const bom = res.bom;
      const config = await this.resolver.requireConfig(bom.productId, ctx);
      const jobs = jobsByItem.get(item.id) ?? [];
      const moves = movesByItem.get(item.id) ?? [];
      const progress = computeLineProgress(item, bom, jobs, moves);
      const policy = config.product.surplusPolicy;
      const sizeName = bom.sizeOptionId ? bom.sizeLabel : null;
      const colourName = bom.colourOptionId ? bom.colourLabel : null;

      const lineWarnings: Problem[] = [];
      if (progress.jobsOnOldComponents.jobCount > 0) {
        const names = progress.jobsOnOldComponents.componentIds
          .map((id) => config.components.find((c) => c.id === id)?.description ?? 'a removed component')
          .join(', ');
        lineWarnings.push({
          code: 'JOBS_ON_OLD_COMPONENTS',
          message: `${progress.jobsOnOldComponents.jobCount} jobs for this line use components no longer in its bill of materials (${names}) — check them before planning more`,
        });
      }
      if (progress.placeholderJobs > 0) {
        lineWarnings.push({
          code: 'PLACEHOLDER_JOBS',
          message: `${progress.placeholderJobs} jobs from quote conversion have no plates or filament — cancel them to plan this line with plates`,
        });
      }
      // A legacy size with no components of its own prints on the standard BOM (§3.2); say so on its rows.
      if (bom.fallbackToBase) lineWarnings.push(...bom.problems.filter((w) => w.code === 'SIZE_OPTION_NO_COMPONENTS'));
      const colourWarnings = bom.warnings.filter((w) => w.code.startsWith('COLOUR_'));

      for (const c of bom.components) {
        const p = progress.components.get(c.componentId)!;
        const isBase = c.colourKey === c.baseColourKey;
        const suggestion = suggestFromStock({
          onHand: c.stockOnHand, remaining: p.remaining, isBaseColumn: isBase, stockConfirmedAt: c.stockConfirmedAt, description: c.description,
        });
        const oldComponents = progress.jobsOnOldComponents.jobCount > 0;
        const fromStock = oldComponents ? 0 : suggestion.fromStock;
        const toProduce = oldComponents ? 0 : p.remaining - fromStock;

        const rowWarnings: Problem[] = [...lineWarnings];
        if (suggestion.warning) rowWarnings.push(suggestion.warning);
        rowWarnings.push(...colourWarnings.filter((w) => !w.componentId || w.componentId === c.componentId));
        const changed = await this.colourChangedWarning(c, platesByItem.get(item.id) ?? [], moves, config.materials, extraMaterials);
        if (changed) rowWarnings.push(changed);

        let plan: OptionPlan | null = null;
        let problem: Problem | null = null;
        plan = planComponent(c, toProduce, bom, config, ctx, policy);
        if (plan.problems.length) {
          problem = { code: 'NO_USABLE_LAYOUT', componentId: c.componentId, message: NO_SLICED_DATA(c.description) };
          if (toProduce > 0) rowWarnings.push(problem);
        }
        const pc = plan.components[0];
        const needs = plan.filamentNeeds;
        const picks = pickSpools(needs, await this.planner.spoolsFor(needs), { reservedBySpool });

        const row: PlanRow = {
          rowKey: `${item.id}:${c.componentId}`,
          orderItemId: item.id,
          productId: bom.productId,
          productName: config.product.name,
          sizeOptionId: bom.sizeOptionId,
          colourOptionId: bom.colourOptionId,
          optionLabel: bom.label,
          fallbackToBase: bom.fallbackToBase,
          componentId: c.componentId,
          componentDescription: c.description,
          isMultiColor: c.isMultiColor,
          colourKey: c.colourKey,
          colourLabel: c.colourKey ? colourLabel(c.colourKey, config.materials) : '',
          needed: p.needed,
          alreadyPlanned: p.alreadyPlanned,
          allocatedFromStock: p.allocatedFromStock || 0, // never -0
          remaining: p.remaining,
          onHand: c.stockOnHand,
          fromStock,
          toProduce,
          surplusPolicy: policy,
          layouts: c.layouts.map((l) => ({
            layoutId: l.layoutId, label: l.label, unitsPerPlate: l.unitsPerPlate, plateMinutes: l.plateMinutes, plateGrams: l.plateGrams,
            minutesPerUnit: l.plateMinutes / l.unitsPerPlate, gramsPerUnit: l.plateGrams / l.unitsPerPlate, hasFile: !!(l.attachmentId || l.gcodeFilename),
          })),
          suggestedPlates: (pc?.plates ?? []).map((pl) => ({ layoutId: pl.layout.layoutId, label: pl.layout.label, unitsPerPlate: pl.layout.unitsPerPlate, plateCount: pl.plateCount })),
          unitsPrinted: pc?.unitsPrinted ?? 0,
          surplus: pc?.surplus ?? 0,
          printMinutes: pc?.printMinutes ?? 0,
          filament: needs.map((n, i) => ({
            materialId: n.materialId,
            label: n.material.name,
            colorHex: n.material.colorHex,
            slicedMaterialId: n.slicedMaterialId,
            grams: Math.round(n.grams * 10) / 10,
            suggestedSpool: picks[i].spool
              ? {
                  id: picks[i].spool!.id,
                  pfid: picks[i].spool!.printforgeId ?? null,
                  currentWeight: picks[i].spool!.currentWeight,
                  effectiveRemaining: Math.round(picks[i].effectiveRemaining),
                  hasEnough: picks[i].hasEnough,
                }
              : null,
          })),
          printerId: config.printer?.id ?? config.product.defaultPrinterId ?? null,
          printerName: config.printer?.name ?? null,
          warnings: rowWarnings,
        };
        out.push({ row, bom, component: c, sizeName, colourName, problem });
      }
    }
    return { order, planVersion: planVersionOf(out), rows: out, warnings };
  }

  /** Non-cancelled JobPlate colour keys per line and component (LINE_COLOUR_CHANGED). */
  private async platesOfItems(orderItemIds: string[]) {
    const out = new Map<string, Array<{ componentId: string | null; colourKey: string; unitsRequired: number; jobId: string }>>();
    if (!orderItemIds.length) return out;
    const jobs = await this.prisma.productionJob.findMany({
      where: { orderItemId: { in: orderItemIds }, status: { not: 'CANCELLED' } },
      select: { id: true, orderItemId: true, plates: { select: { componentId: true, colourKey: true, unitsRequired: true } } },
    });
    for (const j of jobs as any[]) {
      const list = out.get(j.orderItemId) ?? [];
      const seen = new Set<string>();
      for (const p of j.plates ?? []) {
        const k = `${p.componentId}|${p.colourKey}`;
        if (seen.has(k)) continue; // one group per component per job
        seen.add(k);
        list.push({ ...p, jobId: j.id });
      }
      out.set(j.orderItemId, list);
    }
    return out;
  }

  /** §4.4.1 "Line colour changed": planned plates or net allocations in another colour key. */
  private async colourChangedWarning(
    c: ResolvedComponent,
    plates: Array<{ componentId: string | null; colourKey: string; unitsRequired: number }>,
    moves: Array<{ componentId: string; colourKey: string; delta: number; reason: string }>,
    materials: ReadonlyMap<string, { name: string }>,
    extra: Map<string, { name: string }>,
  ): Promise<Problem | null> {
    const byKey = new Map<string, number>();
    for (const p of plates) if (p.componentId === c.componentId && p.colourKey !== c.colourKey) byKey.set(p.colourKey, (byKey.get(p.colourKey) ?? 0) + p.unitsRequired);
    const net = new Map<string, number>();
    for (const m of moves) if (m.componentId === c.componentId) net.set(m.colourKey, (net.get(m.colourKey) ?? 0) - m.delta);
    for (const [k, n] of net) if (n > 0 && k !== c.colourKey) byKey.set(k, (byKey.get(k) ?? 0) + n);
    if (!byKey.size) return null;
    const [oldKey] = [...byKey.entries()].sort((a, b) => b[1] - a[1])[0];
    const missing = oldKey.split('|').map((s) => s.slice(s.indexOf(':') + 1)).filter((id) => !materials.has(id) && !extra.has(id));
    if (missing.length) {
      const rows = await this.prisma.material.findMany({ where: { id: { in: missing } }, select: { id: true, name: true } });
      for (const r of rows) extra.set(r.id, { name: r.name });
    }
    const lookup = (id: string) => materials.get(id) ?? extra.get(id);
    let oldLabel = oldKey;
    try { oldLabel = colourLabel(oldKey, lookup); } catch { /* keep the key */ }
    const newLabel = c.colourKey ? colourLabel(c.colourKey, materials) : 'no filament';
    const total = [...byKey.values()].reduce((s, n) => s + n, 0);
    return {
      code: 'LINE_COLOUR_CHANGED',
      componentId: c.componentId,
      message: `${total} units of "${c.description}" were planned in ${oldLabel} — the rest would print in ${newLabel}`,
    };
  }

  // ------------------------------------------------------------------ J5

  /**
   * J5 (§4.4 J5 rules). Serialised per order by a transaction-scoped advisory
   * lock; the plan is recomputed inside it and must still have the client's
   * planVersion, so a double click or a concurrent change gets a 409.
   */
  async createFromPlan(orderId: string, body: unknown, userId?: string | null): Promise<PlanResult> {
    const input = parsePlanSubmit(body); // bounds before any lock (rule 7)
    return this.prisma.$transaction(async (tx: any) => {
      await tx.$queryRaw(Prisma.sql`/* plan:advisory */ SELECT 1 AS "ok" FROM (SELECT pg_advisory_xact_lock(hashtext(${`plan:${orderId}`}))) AS "l"`);
      // The option rows the lines resolve through, FOR SHARE (§3.1 rule 3): a
      // concurrent reclassification (O7) waits for this plan or finishes first.
      const lineOptions = await tx.orderItem.findMany({ where: { orderId }, select: { variantId: true, sizeOptionId: true, colourOptionId: true } });
      const optionIds = [...new Set(lineOptions.flatMap((i: any) => [i.variantId, i.sizeOptionId, i.colourOptionId]).filter(Boolean))] as string[];
      if (optionIds.length) await lockOptions(tx, optionIds, 'SHARE');
      const plan = await this.computePlan(orderId);
      if (plan.planVersion !== input.planVersion) {
        throw new ConflictException('The plan changed (another plan was created or stock moved) — reload');
      }
      return this.applyPlan(tx, plan, input.rows, userId ?? null);
    }, TX_OPTS);
  }

  private async applyPlan(tx: any, plan: ComputedPlan, sent: PlanRowInput[], userId: string | null): Promise<PlanResult> {
    if (sent.length > plan.rows.length) throw new BadRequestException('More plan rows were sent than the plan has — reload');
    const byKey = new Map(plan.rows.map((r) => [r.row.rowKey, r]));
    const inputs = new Map<string, PlanRowInput>();
    for (const r of sent) {
      if (!byKey.has(r.rowKey)) throw new BadRequestException(`Unknown plan row "${r.rowKey}" — reload the production plan`);
      inputs.set(r.rowKey, r);
    }

    // Validate every row before writing anything (rule 2, 3).
    const ctx = new CatalogRequestContext();
    const reservedBySpool = await this.planner.reservedBySpool();
    const work: Array<{ rp: RowPlan; fromStock: number; toProduce: number; plates: PlannedPlate[]; policy: SurplusPolicy; printerId: string | null; spools: Map<string, SpoolRow> }> = [];
    for (const rp of plan.rows) {
      const { row, component } = rp;
      const inp = inputs.get(row.rowKey);
      const fromStock = inp?.fromStock ?? row.fromStock;
      const toProduce = inp?.toProduce ?? (inp?.fromStock !== undefined ? Math.max(0, row.remaining - fromStock) : row.toProduce);
      const desc = row.componentDescription;
      if (fromStock > row.onHand) throw new BadRequestException(`"${desc}": only ${row.onHand} in printed stock`);
      if (fromStock > row.remaining || fromStock + toProduce > row.remaining) {
        throw new BadRequestException(`"${desc}": only ${row.remaining} units remain to plan`);
      }
      const policy = inp?.surplusPolicy ?? row.surplusPolicy;
      let plates: PlannedPlate[] = [];
      if (toProduce > 0) {
        if (inp?.plates) {
          plates = validatePlan(component, toProduce, inp.plates.map((p) => ({ componentId: component.componentId, layoutId: p.layoutId, plateCount: p.plateCount })));
        } else {
          try {
            plates = suggestPlan(toProduce, component.layouts, ctx.planCache);
          } catch (e) {
            if (e instanceof PlanError) throw new BadRequestException(NO_SLICED_DATA(desc));
            throw e;
          }
        }
      }
      let printerId = inp?.printerId !== undefined ? inp.printerId : row.printerId;
      if (inp?.printerId) {
        const p = await tx.printer.findUnique({ where: { id: inp.printerId }, select: { id: true } });
        if (!p) throw new BadRequestException('Printer not found');
        printerId = p.id;
      }
      const spools = new Map<string, SpoolRow>();
      const lineMaterials = new Set(component.slots.map((s) => s.materialId));
      for (const s of inp?.spools ?? []) {
        if (!lineMaterials.has(s.materialId)) throw new BadRequestException(`Unknown filament for "${desc}"`);
        const spool = await tx.spool.findUnique({ where: { id: s.spoolId }, include: { material: true, location: { select: { id: true, name: true } } } });
        if (!spool) throw new NotFoundException('Spool not found');
        if (!spool.isActive) throw new BadRequestException('Spool is inactive and cannot be assigned');
        if (spool.materialId !== s.materialId) throw new BadRequestException('Spool does not belong to the selected material');
        spools.set(s.materialId, spool);
      }
      work.push({ rp, fromStock, toProduce, plates, policy, printerId: printerId ?? null, spools });
    }

    // Writes.
    const jobs: any[] = [];
    const allocations: Array<{ rowKey: string; fromStock: number }> = [];
    for (const w of work) {
      const { row, bom, component, sizeName, colourName } = w.rp;
      if (w.fromStock > 0) {
        await this.stock.allocate(tx, {
          componentId: component.componentId, colourKey: row.colourKey, quantity: w.fromStock, orderItemId: row.orderItemId,
          description: row.componentDescription, userId,
        });
        allocations.push({ rowKey: row.rowKey, fromStock: w.fromStock });
      }
      if (w.toProduce <= 0) continue;

      const config = await this.resolver.requireConfig(bom.productId, ctx);
      const oneBom = { ...bom, components: [component] };
      const planned = planFromBom(
        oneBom,
        {
          quantity: 1,
          unitsRequired: { [component.componentId]: w.toProduce },
          surplusPolicy: w.policy,
          plates: w.plates.map((p) => ({ componentId: component.componentId, layoutId: p.layout.layoutId, plateCount: p.plateCount })),
        },
        config.materials,
        ctx.planCache,
      );
      const needs = planned.filamentNeeds;
      const auto = pickSpools(needs, await this.planner.spoolsFor(needs), { reservedBySpool });
      const picks = needs.map((n, i) => {
        const chosen = w.spools.get(n.materialId);
        return chosen ? { ...auto[i], spool: chosen, substituted: false } : auto[i];
      });
      const plateData = plateRows(planned.components);
      const name = `${row.productName}${sizeName ? ` — ${sizeName}` : ''}${colourName ? ` — ${colourName}` : ''} — ${row.componentDescription} (×${w.toProduce})`;
      const job = await tx.productionJob.create({
        data: {
          name,
          status: 'QUEUED',
          orderId: plan.order.id,
          orderItemId: row.orderItemId,
          productId: row.productId,
          componentId: component.componentId,
          sizeOptionId: row.sizeOptionId,
          colourOptionId: row.colourOptionId,
          variantId: row.sizeOptionId ?? row.colourOptionId,
          quantityToProduce: w.toProduce,
          printerId: w.printerId,
          purpose: 'CUSTOMER',
          surplusPolicy: w.policy,
          stockMode: null,
          colorChanges: 0,
          gcodeFilename: singlePlateFilename(plateData),
        },
      });
      if (plateData.length) await tx.jobPlate.createMany({ data: plateData.map((p) => ({ ...p, jobId: job.id })) });
      const lines = materialLines(planned.components, needs, picks);
      if (lines.length) await tx.jobMaterial.createMany({ data: lines.map((l) => ({ ...l, jobId: job.id })) });
      jobs.push(job);
    }

    // Rule 4: IN_PRODUCTION only when a job was created and the order is CONFIRMED.
    if (jobs.length) {
      await tx.order.updateMany({ where: { id: plan.order.id, status: 'CONFIRMED' }, data: { status: 'IN_PRODUCTION' } });
    }
    return { jobsCreated: jobs.length, jobs, allocations, warnings: plan.warnings };
  }

  // -------------------------------------------------- planWithSuggestions

  /**
   * Plan an order with J4's suggestions (quote conversion, §3.9, §4.4). Rows
   * whose suggestion has a planning problem are sent as 0/0; every order line
   * that ends with no job and no allocation for a reason gets JOBS_NOT_PLANNED.
   */
  async planWithSuggestions(orderId: string, userId?: string | null): Promise<PlanResult> {
    const preview = await this.computePlan(orderId);
    const rows = preview.rows.map((r) => (r.problem && r.row.toProduce > 0 ? { rowKey: r.row.rowKey, fromStock: 0, toProduce: 0 } : { rowKey: r.row.rowKey }));
    const result = await this.createFromPlan(orderId, { planVersion: preview.planVersion, rows }, userId);

    const planned = new Set(result.jobs.map((j) => j.orderItemId));
    const warnings = [...result.warnings];
    const byItem = new Map<string, RowPlan[]>();
    for (const r of preview.rows) byItem.set(r.row.orderItemId, [...(byItem.get(r.row.orderItemId) ?? []), r]);
    for (const [itemId, list] of byItem) {
      if (planned.has(itemId)) continue;
      const bad = list.find((r) => r.problem && r.row.toProduce > 0);
      if (!bad) continue;
      const item = preview.order.items.find((i: any) => i.id === itemId);
      warnings.push({
        code: 'JOBS_NOT_PLANNED',
        message: `"${item?.description ?? bad.row.productName}": no jobs were planned — ${bad.problem!.message}`,
      });
    }
    return { ...result, warnings };
  }

  // ------------------------------------------------------------------ J2

  /** J2: readiness (P20 shape) with creditOnComplete per §3.6 (no order), the layouts and resolver warnings. */
  async previewJob(body: unknown) {
    const dto = parsePreview(body);
    const ctx = new CatalogRequestContext();
    let productId = dto.productId || null;
    let sizeOptionId = dto.sizeOptionId ?? null;
    let colourOptionId = dto.colourOptionId ?? null;
    if (dto.variantId && !sizeOptionId && !colourOptionId) {
      await this.resolver.preloadVariants([dto.variantId], ctx);
      ({ productId, sizeOptionId, colourOptionId } = mapLegacyVariantId({ productId, variantId: dto.variantId }, (id) => ctx.variants.get(id) ?? null));
    }
    if (!productId) throw new BadRequestException('productId is required');
    const config = await this.resolver.requireConfig(productId, ctx);
    validatePair(this.resolver.pairContext(config), sizeOptionId, colourOptionId, { audience: 'STAFF' });
    const bom = await this.resolver.resolve(productId, { sizeOptionId, colourOptionId }, ctx);
    for (const e of dto.plates ?? []) {
      if (!bom.components.some((c) => c.componentId === e.componentId)) throw new BadRequestException(`That component isn't part of "${bom.label}"`);
    }
    const readiness = await this.planner.readiness(productId, { sizeOptionId, colourOptionId }, dto.quantity, {
      surplusPolicy: dto.surplusPolicy, plates: dto.plates, ctx,
    });
    const credit = { purpose: 'CUSTOMER', orderId: null, stockMode: dto.stockMode ?? null, surplusPolicy: readiness.surplusPolicy };
    const layoutsByComponent: Record<string, unknown[]> = {};
    for (const c of bom.components) {
      layoutsByComponent[c.componentId] = c.layouts.map((l) => ({
        layoutId: l.layoutId, label: l.label, unitsPerPlate: l.unitsPerPlate, plateMinutes: l.plateMinutes, plateGrams: l.plateGrams,
        minutesPerUnit: l.plateMinutes / l.unitsPerPlate, gramsPerUnit: l.plateGrams / l.unitsPerPlate, hasFile: !!(l.attachmentId || l.gcodeFilename),
      }));
    }
    return {
      ...readiness,
      components: readiness.components.map((c) => ({ ...c, creditOnComplete: creditUnits(credit, c.unitsRequired, c.surplus) })),
      layoutsByComponent,
    };
  }
}

/** First 16 hex of SHA-1 over the sorted row tuples (§4.4 J4). */
export function planVersionOf(rows: ReadonlyArray<{ row: PlanRow; component: ResolvedComponent }>): string {
  const tuples = rows
    .map(({ row, component }) => JSON.stringify([
      row.rowKey, row.remaining, row.onHand, row.alreadyPlanned, row.sizeOptionId, row.colourOptionId, row.colourKey,
      component.slots.map((s) => [s.materialId, s.baseMaterialId !== s.materialId ? s.baseMaterialId : null]),
    ]))
    .sort();
  return createHash('sha1').update(tuples.join('\n')).digest('hex').slice(0, 16);
}
