import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Problem } from '@printforge/types';
import { PrismaService } from '../common/prisma/prisma.service';
import { requiredNumber } from '../common/utils/validate-number';
import { baseColourKeyOf, colourKeyOf, colourLabel, parseColourKey } from './colour-key';
import * as sql from './stock-sql';

/**
 * Printed-unit stock of components, per physical colour key (spec §3.6).
 *
 *   bucket(componentId, key) = ProductComponent.stockOnHand      when key is the component's base key
 *                              ComponentColourStock(component, key) otherwise (missing row = 0)
 *
 * Every change writes a ComponentStockMovement with the PHYSICAL colour key of the
 * units moved (never null) and `baseColumn` saying which balance was touched, and
 * its balanceAfter comes from the same statement's RETURNING. Every method takes
 * the caller's transaction: allocation, release and credit are always part of a
 * bigger write (plan, cancel, completion).
 *
 * Imports only Prisma, so the standalone printer bridge can use it.
 */

export type LedgerTx = Prisma.TransactionClient;

type Reason = 'MANUAL_ADJUST' | 'PLAN_ALLOCATE' | 'PLAN_RELEASE' | 'JOB_COMPLETE_STOCK' | 'JOB_COMPLETE_SURPLUS' | 'FILAMENT_REKEY';

export interface StockCredit {
  componentId: string;
  colourKey: string;
  baseColumn: boolean;
  quantity: number;
  balanceAfter: number;
  reason: Reason;
}

/** What creditOnComplete needs of a job (read inside the completion transaction). */
export interface JobForCredit {
  id: string;
  purpose: string;
  orderId: string | null;
  componentId: string | null;
  quantityToProduce: number;
  stockMode: string | null;
  surplusPolicy: string | null;
  variantId: string | null;
  sizeOptionId: string | null;
  colourOptionId: string | null;
  materials: Array<{ materialId: string; plannedMaterialId: string | null; plannedSlicedMaterialId: string | null }>;
  plates: Array<{
    componentId: string | null;
    label?: string | null;
    unitsPerPlate: number;
    plateCount: number;
    unitsRequired: number;
    slots: unknown;
  }>;
}

interface PlannedSlot {
  colorIndex: number;
  materialId: string;
  slicedMaterialId: string | null;
}

const STOCK_MAX = 1_000_000;

/**
 * J4's suggestion for units taken from printed stock (§3.6 "Unconfirmed legacy
 * stock", §4.4.1): min(onHand, remaining), except 0 with STOCK_UNCONFIRMED when the
 * bucket is a pre-release base column that nobody has confirmed yet.
 */
export function suggestFromStock(args: {
  onHand: number;
  remaining: number;
  isBaseColumn: boolean;
  stockConfirmedAt: Date | string | null;
  description: string;
}): { fromStock: number; warning: Problem | null } {
  const suggested = Math.max(0, Math.min(args.onHand, args.remaining));
  if (args.isBaseColumn && args.stockConfirmedAt == null && args.onHand > 0) {
    return {
      fromStock: 0,
      warning: {
        code: 'STOCK_UNCONFIRMED',
        message: `"${args.description}": printed stock predates the update and may include other colours — confirm it on the product page first`,
      },
    };
  }
  return { fromStock: suggested, warning: null };
}

@Injectable()
export class ProductStockService {
  constructor(private readonly prisma: PrismaService) {}

  /** Own slots + description of a component, read inside the transaction. */
  private async component(tx: LedgerTx, componentId: string) {
    const c = await tx.productComponent.findUnique({
      where: { id: componentId },
      select: {
        id: true,
        description: true,
        materialId: true,
        isMultiColor: true,
        stockConfirmedAt: true,
        materials: { select: { colorIndex: true, materialId: true } },
      },
    });
    if (!c) throw new NotFoundException('Component not found');
    return { ...c, baseKey: baseColourKeyOf(c) };
  }

  private movement(
    tx: LedgerTx,
    data: {
      componentId: string;
      colourKey: string;
      baseColumn: boolean;
      delta: number;
      balanceAfter: number;
      reason: Reason;
      orderItemId?: string | null;
      jobId?: string | null;
      userId?: string | null;
      note?: string | null;
    },
  ) {
    return tx.componentStockMovement.create({ data: { ...data } as any });
  }

  /**
   * Take k units of a planned row from its bucket (J5). Guarded decrement: if the
   * bucket no longer holds k, 409 and the caller's transaction rolls back.
   */
  async allocate(
    tx: LedgerTx,
    args: { componentId: string; colourKey: string; quantity: number; orderItemId: string; description?: string; userId?: string | null },
  ): Promise<StockCredit> {
    const k = requiredNumber(args.quantity, 'fromStock', { min: 1, max: STOCK_MAX, integer: true });
    parseColourKey(args.colourKey);
    const comp = await this.component(tx, args.componentId);
    const baseColumn = args.colourKey === comp.baseKey;
    const after = baseColumn
      ? await sql.takeColumn(tx, args.componentId, k)
      : await sql.takeRow(tx, args.componentId, args.colourKey, k);
    if (after === null) {
      throw new ConflictException(`Printed stock of "${args.description ?? comp.description}" changed — reload the plan`);
    }
    await this.movement(tx, {
      componentId: args.componentId,
      colourKey: args.colourKey,
      baseColumn,
      delta: -k,
      balanceAfter: after,
      reason: 'PLAN_ALLOCATE',
      orderItemId: args.orderItemId,
      userId: args.userId ?? null,
    });
    return { componentId: args.componentId, colourKey: args.colourKey, baseColumn, quantity: -k, balanceAfter: after, reason: 'PLAN_ALLOCATE' };
  }

  /** S9: the order's lines, before its jobs (the S11 / O7 order). FOR UPDATE, in id order. */
  async lockOrderLines(tx: LedgerTx, orderId: string): Promise<void> {
    const items = await tx.orderItem.findMany({ where: { orderId }, select: { id: true }, orderBy: { id: 'asc' } });
    for (const i of items) await sql.lockLine(tx, i.id);
  }

  /** Order cancelled (S9): return every line's net allocation. */
  async releaseForOrder(tx: LedgerTx, orderId: string, userId?: string | null): Promise<StockCredit[]> {
    const items = await tx.orderItem.findMany({ where: { orderId }, select: { id: true }, orderBy: { id: 'asc' } });
    const out: StockCredit[] = [];
    for (const item of items) out.push(...(await this.releaseForItem(tx, item.id, userId)));
    return out;
  }

  /**
   * Return one line's net allocations (S11, and each line of a cancelled order)
   * to their PHYSICAL colour: the column when the key is the component's current
   * base key, else its colour row. A second call finds a net of 0, also a
   * concurrent one (S9 and S11 on one line, or a double submit): the line is
   * locked before its movements are read, so the second waits for the first to
   * commit and then reads its PLAN_RELEASE (never read-then-write, §0.2).
   */
  async releaseForItem(tx: LedgerTx, orderItemId: string, userId?: string | null): Promise<StockCredit[]> {
    await sql.lockLine(tx, orderItemId);
    const moves = await tx.componentStockMovement.findMany({
      where: { orderItemId, reason: { in: ['PLAN_ALLOCATE', 'PLAN_RELEASE'] } },
      select: { componentId: true, colourKey: true, delta: true },
    });
    const net = new Map<string, { componentId: string; colourKey: string; units: number }>();
    for (const m of moves) {
      const key = `${m.componentId}\u0000${m.colourKey}`;
      const e = net.get(key) ?? { componentId: m.componentId, colourKey: m.colourKey, units: 0 };
      e.units -= m.delta; // allocations are negative, releases positive
      net.set(key, e);
    }
    const out: StockCredit[] = [];
    for (const e of net.values()) {
      if (e.units <= 0) continue;
      const comp = await this.component(tx, e.componentId);
      const baseColumn = e.colourKey === comp.baseKey;
      const after = baseColumn
        ? await sql.addColumn(tx, e.componentId, e.units)
        : await sql.addRow(tx, e.componentId, e.colourKey, e.units);
      await this.movement(tx, {
        componentId: e.componentId,
        colourKey: e.colourKey,
        baseColumn,
        delta: e.units,
        balanceAfter: after ?? 0,
        reason: 'PLAN_RELEASE',
        orderItemId,
        userId: userId ?? null,
      });
      out.push({ componentId: e.componentId, colourKey: e.colourKey, baseColumn, quantity: e.units, balanceAfter: after ?? 0, reason: 'PLAN_RELEASE' });
    }
    return out;
  }

  /** Units credited per component group, per the §3.6 credit table. */
  private creditFor(job: JobForCredit, R: number, S: number): { n: number; reason: Reason } {
    if (job.purpose !== 'CUSTOMER') return { n: 0, reason: 'JOB_COMPLETE_SURPLUS' };
    // Jobs with plates always store a policy; a missing one credits no extras.
    const keep = job.surplusPolicy === 'KEEP_FOR_STOCK';
    if (job.orderId) return { n: keep ? S : 0, reason: 'JOB_COMPLETE_SURPLUS' };
    if (job.stockMode === 'BUILD_STOCK') return { n: keep ? R + S : R, reason: 'JOB_COMPLETE_STOCK' };
    return { n: keep ? S : 0, reason: 'JOB_COMPLETE_SURPLUS' }; // DIRECT_SALE or null
  }

  /**
   * Credit printed stock when a job completes (§3.6 "Stock credit on job
   * completion"). The bucket comes from the filament actually on the job's lines,
   * matched to each planned slot by planned identity, so a swap after planning
   * credits the colour really printed.
   */
  async creditOnComplete(tx: LedgerTx, job: JobForCredit, userId?: string | null): Promise<{ credits: StockCredit[]; warnings: Problem[] }> {
    const credits: StockCredit[] = [];
    const warnings: Problem[] = [];

    if (!job.plates.length) return this.creditLegacy(tx, job, userId);
    if (job.purpose !== 'CUSTOMER') return { credits, warnings };

    const groups = new Map<string | null, JobForCredit['plates']>();
    for (const p of job.plates) {
      const g = groups.get(p.componentId) ?? [];
      g.push(p);
      groups.set(p.componentId, g);
    }

    for (const [componentId, rows] of groups) {
      if (!componentId) {
        warnings.push({ code: 'COMPONENT_REMOVED', message: `"${rows[0].label ?? 'A component'}" was removed from the product — its printed units were not added to stock` });
        continue;
      }
      const R = rows[0].unitsRequired;
      const U = rows.reduce((s, r) => s + r.unitsPerPlate * r.plateCount, 0);
      const S = Math.max(0, U - R);
      const { n, reason } = this.creditFor(job, R, S);
      if (n <= 0) continue;

      const comp = await tx.productComponent.findUnique({
        where: { id: componentId },
        select: { id: true, description: true, materialId: true, isMultiColor: true, materials: { select: { colorIndex: true, materialId: true } } },
      });
      if (!comp) {
        warnings.push({ code: 'COMPONENT_REMOVED', message: `"${rows[0].label ?? 'A component'}" was removed from the product — its printed units were not added to stock` });
        continue;
      }

      const planned = (Array.isArray(rows[0].slots) ? rows[0].slots : []) as PlannedSlot[];
      const actual: Array<{ colorIndex: number; materialId: string }> = [];
      let needsReview = planned.length === 0;
      for (const p of planned) {
        const lines = job.materials.filter(
          (m) => m.plannedMaterialId === p.materialId && (m.plannedSlicedMaterialId ?? null) === (p.slicedMaterialId ?? null),
        );
        if (lines.length !== 1) { needsReview = true; break; }
        actual.push({ colorIndex: p.colorIndex, materialId: lines[0].materialId });
      }
      if (needsReview) {
        warnings.push({
          code: 'STOCK_CREDIT_NEEDS_REVIEW',
          componentId,
          message: `"${comp.description}": filament lines were changed on this job — add the ${n} printed units to stock by hand`,
        });
        continue;
      }

      const key = colourKeyOf(actual);
      const baseColumn = key === baseColourKeyOf(comp);
      const after = baseColumn ? await sql.addColumn(tx, componentId, n) : await sql.addRow(tx, componentId, key, n);
      await this.movement(tx, { componentId, colourKey: key, baseColumn, delta: n, balanceAfter: after ?? 0, reason, jobId: job.id, userId: userId ?? null });
      credits.push({ componentId, colourKey: key, baseColumn, quantity: n, balanceAfter: after ?? 0, reason });
    }
    return { credits, warnings };
  }

  /** Jobs without JobPlate rows (pre-release, placeholders): the legacy rows of §3.6. */
  private async creditLegacy(tx: LedgerTx, job: JobForCredit, userId?: string | null) {
    const credits: StockCredit[] = [];
    const warnings: Problem[] = [];
    if (job.purpose !== 'CUSTOMER' || !job.componentId || job.orderId) return { credits, warnings };

    // effectiveOptions(job).colourOptionId (§3.2), read with the option's CURRENT kind.
    let colourOptionId = job.colourOptionId;
    if (!colourOptionId && !job.sizeOptionId && job.variantId) {
      const v = await tx.productVariant.findUnique({ where: { id: job.variantId }, select: { kind: true } });
      if (v?.kind === 'COLOUR') colourOptionId = job.variantId;
    }
    const comp = await tx.productComponent.findUnique({
      where: { id: job.componentId },
      select: { id: true, description: true, materialId: true, isMultiColor: true, materials: { select: { colorIndex: true, materialId: true } } },
    });
    if (!comp) return { credits, warnings };
    const n = job.quantityToProduce;
    if (colourOptionId) {
      warnings.push({
        code: 'STOCK_CREDIT_NEEDS_REVIEW',
        componentId: comp.id,
        message: `"${comp.description}": filament lines were changed on this job — add the ${n} printed units to stock by hand`,
      });
      return { credits, warnings };
    }
    if (n <= 0) return { credits, warnings };
    const key = baseColourKeyOf(comp);
    const after = await sql.addColumn(tx, comp.id, n);
    await this.movement(tx, { componentId: comp.id, colourKey: key, baseColumn: true, delta: n, balanceAfter: after ?? 0, reason: 'JOB_COMPLETE_STOCK', jobId: job.id, userId: userId ?? null });
    credits.push({ componentId: comp.id, colourKey: key, baseColumn: true, quantity: n, balanceAfter: after ?? 0, reason: 'JOB_COMPLETE_STOCK' });
    return { credits, warnings };
  }

  /**
   * P13: set one bucket to an exact count, only if it still holds what the user
   * saw. Setting the base column (colourKey null or the base key) also confirms
   * it. A 0-delta set is written too (note "confirmed"). Never reprices.
   */
  async manualSet(
    tx: LedgerTx,
    args: { componentId: string; colourKey: string | null; stockOnHand: unknown; expectedStockOnHand: unknown; userId?: string | null },
  ): Promise<StockCredit> {
    const value = requiredNumber(args.stockOnHand, 'stockOnHand', { min: 0, max: STOCK_MAX, integer: true });
    const expected = requiredNumber(args.expectedStockOnHand, 'expectedStockOnHand', { min: 0, max: STOCK_MAX, integer: true });
    const comp = await this.component(tx, args.componentId);
    const key = args.colourKey ?? comp.baseKey;
    if (args.colourKey !== null) parseColourKey(args.colourKey);
    const baseColumn = args.colourKey === null || args.colourKey === comp.baseKey;
    if (baseColumn && !key) throw new BadRequestException(`"${comp.description}" has no filament set`);

    let after: number | null;
    if (baseColumn) {
      after = await sql.setColumnIf(tx, comp.id, expected, value);
    } else {
      if (expected === 0) await sql.ensureRow(tx, comp.id, key);
      after = await sql.setRowIf(tx, comp.id, key, expected, value);
    }
    if (after === null) {
      const current = baseColumn ? await sql.readColumn(tx, comp.id) : await sql.readRow(tx, comp.id, key);
      throw new ConflictException(`Printed stock is now ${current ?? 0} — reload`);
    }
    const delta = value - expected;
    await this.movement(tx, {
      componentId: comp.id,
      colourKey: key,
      baseColumn,
      delta,
      balanceAfter: after,
      reason: 'MANUAL_ADJUST',
      userId: args.userId ?? null,
      note: delta === 0 ? 'confirmed' : null,
    });
    return { componentId: comp.id, colourKey: key, baseColumn, quantity: delta, balanceAfter: after, reason: 'MANUAL_ADJUST' };
  }

  /**
   * A component's own filament changed (P10/P11), in the same transaction as the
   * change. Keeps the invariant "no row duplicates the base key":
   *   - the column balance k (old base colour) moves to row(oldBaseKey);
   *   - a balance r already held in row(newBaseKey) moves into the column.
   * An unconfirmed column stays unconfirmed; the row it lands in gets a note.
   */
  async rekeyBase(
    tx: LedgerTx,
    componentId: string,
    oldBaseKey: string,
    newBaseKey: string,
    opts: { userId?: string | null; materials?: ReadonlyMap<string, { name: string }> } = {},
  ): Promise<{ moved: number; movedIn: number; warnings: Problem[] }> {
    const warnings: Problem[] = [];
    if (oldBaseKey === newBaseKey) return { moved: 0, movedIn: 0, warnings };
    const comp = await tx.productComponent.findUnique({ where: { id: componentId }, select: { stockConfirmedAt: true } });
    if (!comp) throw new NotFoundException('Component not found');
    const userId = opts.userId ?? null;
    const unconfirmed = comp.stockConfirmedAt == null;

    const k = (await sql.lockColumn(tx, componentId)) ?? 0;
    if (k !== 0 && oldBaseKey) {
      const colAfter = await sql.addColumn(tx, componentId, -k);
      await this.movement(tx, { componentId, colourKey: oldBaseKey, baseColumn: true, delta: -k, balanceAfter: colAfter ?? 0, reason: 'FILAMENT_REKEY', userId, note: 'filament changed' });
      const rowAfter = await sql.addRow(tx, componentId, oldBaseKey, k);
      await this.movement(tx, {
        componentId, colourKey: oldBaseKey, baseColumn: false, delta: k, balanceAfter: rowAfter ?? 0, reason: 'FILAMENT_REKEY', userId,
        note: unconfirmed ? 'filament changed; unconfirmed — may include other colours' : 'filament changed',
      });
      let label = oldBaseKey;
      try { if (opts.materials) label = colourLabel(oldBaseKey, opts.materials); } catch { /* keep the key */ }
      warnings.push({ code: 'STOCK_REKEYED', componentId, message: `${k} printed units in the old colour kept as ${label}` });
    }

    let r = 0;
    if (newBaseKey) {
      r = (await sql.lockRow(tx, componentId, newBaseKey)) ?? 0;
      if (r !== 0) {
        const rowAfter = await sql.addRow(tx, componentId, newBaseKey, -r);
        await this.movement(tx, { componentId, colourKey: newBaseKey, baseColumn: false, delta: -r, balanceAfter: rowAfter ?? 0, reason: 'FILAMENT_REKEY', userId, note: 'filament changed' });
        const colAfter = await sql.addColumn(tx, componentId, r);
        await this.movement(tx, { componentId, colourKey: newBaseKey, baseColumn: true, delta: r, balanceAfter: colAfter ?? 0, reason: 'FILAMENT_REKEY', userId, note: 'filament changed' });
      }
    }
    return { moved: oldBaseKey ? k : 0, movedIn: r, warnings };
  }
}
