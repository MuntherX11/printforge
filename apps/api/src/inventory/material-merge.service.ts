import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  MATERIAL_MERGE_KEYS, filamentLabel,
  type MaterialMergeCounts, type MaterialMergeResult, type MaterialMergeSide, type MaterialMergeWarning,
} from '@printforge/types';
import { PricingService } from '../catalog-core/pricing.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisCacheService } from '../common/redis/redis-cache.service';
import { allowedBody } from '../common/utils/validate-number';
import { colourKeyHasMaterial } from '../stock-ledger/colour-key';
import * as sql from '../stock-ledger/stock-sql';
import { MATERIAL_TX, lockMaterialIdentity } from './material-identity';
import {
  jobsWithDoubledLines, partsWithRepeatedFilament, planMergeStock, renameColourKey, renameJobLine, renameJobPlate,
  type MergeJobLine, type MergeStockPlan,
} from './material-merge-plan';

/** Job statuses whose lines can still change (the planner's "open" jobs). */
const OPEN_JOBS = ['QUEUED', 'IN_PROGRESS', 'PAUSED'];

const MATERIAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

type Db = any;

interface LockedMaterial extends MaterialMergeSide {
  costPerGram: number;
}

/** Allowlist parser for POST /materials/:id/merge: `targetMaterialId` (required) and `confirm`. Any other key → 400. */
export function parseMaterialMerge(raw: unknown): { targetMaterialId: string; confirm: boolean } {
  const b = allowedBody(raw, MATERIAL_MERGE_KEYS);
  const t = typeof b.targetMaterialId === 'string' ? b.targetMaterialId.trim() : '';
  if (!MATERIAL_ID.test(t)) throw new BadRequestException('Pick the filament to merge into');
  if (b.confirm !== undefined && typeof b.confirm !== 'boolean') throw new BadRequestException('"confirm" must be true or false');
  return { targetMaterialId: t, confirm: b.confirm === true };
}

/** Everything a merge reads, the same for the dry run and inside the transaction. */
interface Gathered {
  components: Array<{ id: string; productId: string; materialId: string | null; isMultiColor: boolean; materials: Array<{ colorIndex: number; materialId: string }> }>;
  productIds: string[];
  componentFilaments: number;
  componentColourSlots: number;
  colourAssignments: number;
  lines: Array<MergeJobLine & { open: boolean }>;
  doubledJobs: string[];
  plates: Array<{ id: string; next: { colourKey: string; slots: unknown } }>;
  stock: MergeStockPlan;
  movementKeys: Map<string, number>;
  retiredSpools: number;
  activeSpools: number;
}

/**
 * Merge a filament into another of the same type (owner request: blanks the
 * slicer import created — "PLA Beige", no brand, cost 0, no spools — must go,
 * but they are referenced and so can't be deleted). Every place a material id
 * is stored moves to the target, then the source row is deleted:
 *
 *   ProductComponent.materialId, ComponentMaterial.materialId, ColourOptionSlot.materialId,
 *   JobMaterial.materialId / slicedMaterialId / plannedMaterialId / plannedSlicedMaterialId,
 *   JobPlate.colourKey and JobPlate.slots[].materialId / slicedMaterialId (JSON),
 *   ComponentColourStock.colourKey (buckets of the same colour added together),
 *   ComponentStockMovement.colourKey (history relabelled, never deleted),
 *   Spool.materialId of retired spools (an active spool refuses the merge).
 *
 * Lock order (the one MaterialsService already uses): the filament identity
 * advisory lock, then both Material rows FOR UPDATE in id order, then each
 * affected component's stock column FOR UPDATE in id order, then its rows.
 */
@Injectable()
export class MaterialMergeService {
  private readonly logger = new Logger(MaterialMergeService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly pricing?: PricingService,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  async merge(sourceId: string, body: unknown, userId: string | null): Promise<MaterialMergeResult> {
    const { targetMaterialId, confirm } = parseMaterialMerge(body);
    if (targetMaterialId === sourceId) throw new BadRequestException('Pick a different filament to merge into');

    if (!confirm) {
      const [source, target] = await this.sides(this.prisma, sourceId, targetMaterialId);
      const g = await this.gather(this.prisma, source.id, target.id);
      this.refuse(source, target, g);
      return stripProducts(this.result(false, source, target, g));
    }

    const out = await this.prisma.$transaction(async (tx: Db) => {
      await lockMaterialIdentity(tx);
      const ids = [sourceId, targetMaterialId].sort();
      const rows = (await tx.$queryRaw(
        Prisma.sql`/* lock:Material:UPDATE */ SELECT "id", "name", "type", "color", "colorHex", "brand", "costPerGram" FROM "Material" WHERE "id" = ANY(${ids}::text[]) ORDER BY "id" FOR UPDATE`,
      )) as LockedMaterial[];
      const [source, target] = this.pick(rows, sourceId, targetMaterialId);
      const g = await this.gather(tx, source.id, target.id);
      this.refuse(source, target, g);
      await this.apply(tx, source, target, g, userId);
      return this.result(true, source, target, g);
    }, MATERIAL_TX);

    // After commit, as every filament write: the dashboard KPI cache, then prices (a failure is logged, never thrown).
    this.cache?.invalidate('dashboard:kpis').catch(() => {});
    for (const productId of out.productIds) {
      try {
        await this.pricing?.recalcPricing(productId);
      } catch (e) {
        this.logger.warn(`Repricing ${productId} after a filament merge failed: ${(e as Error)?.message}`);
      }
    }
    return stripProducts(out);
  }

  // ------------------------------------------------------------------ reads

  private async sides(db: Db, sourceId: string, targetId: string): Promise<[LockedMaterial, LockedMaterial]> {
    const rows = await db.material.findMany({
      where: { id: { in: [sourceId, targetId] } },
      select: { id: true, name: true, type: true, color: true, colorHex: true, brand: true, costPerGram: true },
    });
    return this.pick(rows, sourceId, targetId);
  }

  private pick(rows: LockedMaterial[], sourceId: string, targetId: string): [LockedMaterial, LockedMaterial] {
    const source = rows.find((r) => r.id === sourceId);
    if (!source) throw new NotFoundException('Material not found');
    const target = rows.find((r) => r.id === targetId);
    if (!target) throw new NotFoundException('The filament to merge into no longer exists');
    return [source, target];
  }

  private async gather(db: Db, S: string, T: string): Promise<Gathered> {
    const keyHas = { contains: `:${S}` };
    const [own, slots, assignments, rawLines, stockHits, moveRows, retiredSpools, activeSpools, plateIds] = await Promise.all([
      db.productComponent.findMany({ where: { materialId: S }, select: { id: true } }),
      db.componentMaterial.findMany({ where: { materialId: S }, select: { componentId: true } }),
      db.colourOptionSlot.findMany({ where: { materialId: S }, select: { variant: { select: { productId: true } } } }),
      db.jobMaterial.findMany({
        where: { OR: [{ materialId: S }, { slicedMaterialId: S }, { plannedMaterialId: S }, { plannedSlicedMaterialId: S }] },
        select: { id: true, jobId: true, materialId: true, slicedMaterialId: true, plannedMaterialId: true, plannedSlicedMaterialId: true, job: { select: { status: true } } },
        orderBy: { id: 'asc' },
      }),
      db.componentColourStock.findMany({ where: { colourKey: keyHas }, select: { componentId: true, colourKey: true } }),
      db.componentStockMovement.findMany({ where: { colourKey: keyHas }, select: { colourKey: true } }),
      db.spool.count({ where: { materialId: S, isActive: false } }),
      db.spool.count({ where: { materialId: S, isActive: true } }),
      db.$queryRaw(Prisma.sql`/* merge:jobPlates */ SELECT "id" FROM "JobPlate" WHERE "colourKey" LIKE ${`%:${S}%`} OR "slots"::text LIKE ${`%${S}%`}`),
    ]);

    // Components: own filament, a multicolour slot, or printed stock in a colour naming the source.
    const stockComponentIds = (stockHits as Array<{ componentId: string; colourKey: string }>)
      .filter((r) => colourKeyHasMaterial(r.colourKey, S)).map((r) => r.componentId);
    const ownIds = new Set<string>([...own.map((c: { id: string }) => c.id), ...slots.map((s: { componentId: string }) => s.componentId)]);
    const componentIds = [...new Set([...ownIds, ...stockComponentIds])].sort();
    const [components, stockRows] = componentIds.length
      ? await Promise.all([
        db.productComponent.findMany({
          where: { id: { in: componentIds } },
          select: { id: true, productId: true, materialId: true, isMultiColor: true, materials: { select: { colorIndex: true, materialId: true } } },
          orderBy: { id: 'asc' },
        }),
        db.componentColourStock.findMany({ where: { componentId: { in: componentIds } }, select: { id: true, componentId: true, colourKey: true, stockOnHand: true } }),
      ])
      : [[], []];

    const productIds = new Set<string>();
    for (const c of components) if (ownIds.has(c.id)) productIds.add(c.productId);
    for (const a of assignments) if (a.variant?.productId) productIds.add(a.variant.productId);

    // Job lines, and the open jobs that would hold two lines of one planned identity.
    const lines = (rawLines as Array<MergeJobLine & { job?: { status: string } | null }>).map(({ job, ...l }) => ({ ...l, open: OPEN_JOBS.includes(job?.status ?? '') }));
    const openJobIds = [...new Set(lines.filter((l) => l.open).map((l) => l.jobId))];
    let doubledJobs: string[] = [];
    if (openJobIds.length) {
      const all: MergeJobLine[] = await db.jobMaterial.findMany({
        where: { jobId: { in: openJobIds } },
        select: { id: true, jobId: true, materialId: true, slicedMaterialId: true, plannedMaterialId: true, plannedSlicedMaterialId: true },
      });
      doubledJobs = jobsWithDoubledLines(all.map((l) => renameJobLine(l, S, T)?.next ?? l));
    }

    // Job plates: the SQL LIKE narrows, the parsed snapshot decides.
    const ids = (plateIds as Array<{ id: string }>).map((p) => p.id);
    const plateRows: Array<{ id: string; colourKey: string; slots: unknown }> = ids.length
      ? await db.jobPlate.findMany({ where: { id: { in: ids } }, select: { id: true, colourKey: true, slots: true }, orderBy: { id: 'asc' } })
      : [];
    const plates = plateRows.flatMap((p) => {
      const next = renameJobPlate(p, S, T);
      return next ? [{ id: p.id, next }] : [];
    });

    const movementKeys = new Map<string, number>();
    for (const m of moveRows as Array<{ colourKey: string }>) {
      if (colourKeyHasMaterial(m.colourKey, S)) movementKeys.set(m.colourKey, (movementKeys.get(m.colourKey) ?? 0) + 1);
    }

    return {
      components,
      productIds: [...productIds].sort(),
      componentFilaments: own.length,
      componentColourSlots: slots.length,
      colourAssignments: assignments.length,
      lines,
      doubledJobs,
      plates,
      stock: planMergeStock(components, stockRows, S, T),
      movementKeys,
      retiredSpools,
      activeSpools,
    };
  }

  /** The refusals that need the data (same id and the body are checked before). */
  private refuse(source: LockedMaterial, target: LockedMaterial, g: Gathered) {
    if (source.type !== target.type) {
      throw new ConflictException(
        `"${source.name}" is ${source.type} and "${target.name}" is ${target.type} — merge only into a filament of the same type`,
      );
    }
    if (g.activeSpools > 0) {
      const n = g.activeSpools === 1 ? '1 active spool' : `${g.activeSpools} active spools`;
      throw new ConflictException(`"${source.name}" has ${n} — retire them first (merging doesn't move spool stock)`);
    }
  }

  // ----------------------------------------------------------------- writes

  private async apply(tx: Db, source: LockedMaterial, target: LockedMaterial, g: Gathered, userId: string | null) {
    const S = source.id;
    const T = target.id;
    const note = `filaments merged: "${source.name}" into "${target.name}"`;

    // FK columns.
    await tx.productComponent.updateMany({ where: { materialId: S }, data: { materialId: T } });
    await tx.componentMaterial.updateMany({ where: { materialId: S }, data: { materialId: T } });
    await tx.colourOptionSlot.updateMany({ where: { materialId: S }, data: { materialId: T } });
    await tx.spool.updateMany({ where: { materialId: S, isActive: false }, data: { materialId: T } });

    // Job lines, grouped by the identical patch they get.
    const groups = new Map<string, { patch: Record<string, unknown>; ids: string[] }>();
    for (const l of g.lines) {
      const r = renameJobLine(l, S, T);
      if (!r) continue;
      const key = JSON.stringify(r.patch);
      const e = groups.get(key) ?? { patch: r.patch, ids: [] as string[] };
      e.ids.push(l.id);
      groups.set(key, e);
    }
    for (const { patch, ids } of groups.values()) await tx.jobMaterial.updateMany({ where: { id: { in: ids } }, data: patch });

    // Job plate snapshots.
    for (const p of g.plates) await tx.jobPlate.update({ where: { id: p.id }, data: { colourKey: p.next.colourKey, slots: p.next.slots } });

    // Printed-stock history: relabelled first, so the moves below are written in the merged colour.
    for (const key of [...g.movementKeys.keys()].sort()) {
      await tx.componentStockMovement.updateMany({ where: { colourKey: key }, data: { colourKey: renameColourKey(key, S, T) } });
    }

    // Printed-stock balances: columns locked in id order, then their rows.
    const affected = [...new Set(g.stock.steps.map((s) => s.componentId))].sort();
    for (const id of affected) await sql.lockColumn(tx, id);
    for (const step of g.stock.steps) {
      const componentId = step.componentId;
      const move = (colourKey: string, baseColumn: boolean, delta: number, balanceAfter: number | null) =>
        tx.componentStockMovement.create({
          data: { componentId, colourKey, baseColumn, delta, balanceAfter: balanceAfter ?? 0, reason: 'FILAMENT_REKEY', userId, note },
        });
      if (step.kind === 'rename') {
        await tx.componentColourStock.update({ where: { id: step.rowId }, data: { colourKey: step.to } });
        continue;
      }
      if (step.kind === 'foldBase') {
        const r = (await sql.lockRow(tx, componentId, step.key)) ?? 0;
        if (r > 0) {
          await move(step.key, false, -r, await sql.addRow(tx, componentId, step.key, -r));
          await move(step.key, true, r, await sql.addColumn(tx, componentId, r));
        }
        continue;
      }
      const units = (await sql.lockRow(tx, componentId, step.from)) ?? 0;
      await tx.componentColourStock.delete({ where: { id: step.rowId } });
      if (units > 0) {
        await move(step.to, false, -units, 0);
        const after = step.into === 'column'
          ? await sql.addColumn(tx, componentId, units)
          : await sql.addRow(tx, componentId, step.to, units);
        await move(step.to, step.into === 'column', units, after);
      }
    }

    await tx.material.delete({ where: { id: S } });
    if (userId) {
      await tx.auditLog.create({
        data: {
          userId, action: 'Material.merged', entityType: 'Material', entityId: S,
          details: { source: { id: S, name: source.name }, target: { id: T, name: target.name }, counts: this.counts(g) },
        },
      });
    }
  }

  // ----------------------------------------------------------------- result

  private counts(g: Gathered): MaterialMergeCounts {
    return {
      componentFilaments: g.componentFilaments,
      componentColourSlots: g.componentColourSlots,
      colourAssignments: g.colourAssignments,
      jobLines: g.lines.length,
      openJobLines: g.lines.filter((l) => l.open).length,
      jobPlates: g.plates.length,
      printedStockRows: g.stock.rows,
      printedStockUnits: g.stock.units,
      printedStockCombined: g.stock.combined,
      stockMovements: [...g.movementKeys.values()].reduce((s, n) => s + n, 0),
      retiredSpools: g.retiredSpools,
      products: g.productIds.length,
    };
  }

  private result(merged: boolean, source: LockedMaterial, target: LockedMaterial, g: Gathered): MaterialMergeResult & { productIds: string[] } {
    const counts = this.counts(g);
    const to = filamentLabel(target).text;
    const warnings: MaterialMergeWarning[] = [];
    if (counts.printedStockCombined > 0) {
      warnings.push({ code: 'STOCK_COMBINED', message: `${counts.printedStockCombined} printed stock ${counts.printedStockCombined === 1 ? 'bucket joins' : 'buckets join'} the matching ${to} stock — the units are added together` });
    }
    const repeated = partsWithRepeatedFilament(g.components, source.id, target.id);
    if (repeated > 0) {
      warnings.push({ code: 'SAME_FILAMENT_TWICE', message: `${repeated} multicolour ${repeated === 1 ? 'part prints' : 'parts print'} two colours in ${to}` });
    }
    if (g.doubledJobs.length > 0) {
      const n = g.doubledJobs.length;
      warnings.push({ code: 'JOB_LINES_DOUBLED', message: `${n} open ${n === 1 ? 'job ends' : 'jobs end'} up with two ${to} lines — when ${n === 1 ? 'it completes' : 'they complete'}, add the printed units to stock by hand` });
    }
    if (counts.products > 0 && source.costPerGram !== target.costPerGram) {
      warnings.push({ code: 'PRICES_CHANGE', message: `${counts.products} ${counts.products === 1 ? 'product is' : 'products are'} repriced with ${to}'s cost per gram` });
    }
    const side = ({ costPerGram: _c, ...s }: LockedMaterial): MaterialMergeSide => ({
      id: s.id, name: s.name, type: s.type, color: s.color ?? null, colorHex: s.colorHex ?? null, brand: s.brand ?? null,
    });
    return { merged, source: side(source), target: side(target), counts, warnings, productIds: g.productIds };
  }
}

/** The response without the products to reprice (an internal list). */
function stripProducts({ productIds: _p, ...rest }: MaterialMergeResult & { productIds: string[] }): MaterialMergeResult {
  return rest;
}
