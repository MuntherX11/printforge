import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Problem } from '@printforge/types';
import { PrismaService } from '../common/prisma/prisma.service';
import { ProductStockService, type JobForCredit, type LedgerTx } from './product-stock.service';

/**
 * Job completion, every path (spec §3.6): the manual J6 route and both printer
 * bridges call this one service, so a double click or a duplicate bridge event
 * can never deduct twice. One transaction, in this order:
 *
 *   1. guarded status flip (QUEUED/IN_PROGRESS/PAUSED → COMPLETED) — first statement;
 *   2. read the job with its lines and plates (after the row lock);
 *   3. spool deduction, atomic GREATEST(0, currentWeight − g);
 *   4. parts (product jobs without componentId) with a JobPart snapshot;
 *   5. printer hours;
 *   6. printed-stock credit per the §3.6 table.
 *
 * Lives in StockLedgerModule and needs only Prisma, because the standalone
 * printer bridge (Prisma + Notifications only) uses it too. After-commit work
 * (cost, broadcasts, notifications) stays with the caller.
 */

export type CompletionSource = 'MANUAL' | 'MOONRAKER' | 'CREALITY';

export interface CompleteOptions {
  source: CompletionSource;
  /** seconds, from the printer */
  printDurationSec?: number | null;
  filamentUsedMm?: number | null;
  userId?: string | null;
}

export interface JobStockCredit {
  componentId: string;
  colourKey: string | null;
  delta: number;
  balanceAfter: number;
}

export interface CompletionResult {
  job: any;
  stockCredits: JobStockCredit[];
  warnings: Problem[];
}

const ACTIVE = ['QUEUED', 'IN_PROGRESS', 'PAUSED'];

@Injectable()
export class JobCompletionService {
  private readonly logger = new Logger(JobCompletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: ProductStockService,
  ) {}

  /**
   * Complete a job. MANUAL: 404 when missing, 409 when no longer active.
   * Bridges: `null` (logged) when the guarded flip matched nothing.
   */
  async complete(jobId: string, opts: CompleteOptions): Promise<CompletionResult | null> {
    const res = await this.prisma.$transaction(
      (tx) => this.completeInTx(tx, jobId, opts),
      { timeout: 30_000, maxWait: 10_000 },
    );
    if (res) return res;

    if (opts.source !== 'MANUAL') {
      this.logger.log(`Job ${jobId} is no longer active — ${opts.source} completion skipped`);
      return null;
    }
    const exists = await this.prisma.productionJob.findUnique({ where: { id: jobId }, select: { id: true } });
    if (!exists) throw new NotFoundException('Production job not found');
    throw new ConflictException('This job was already completed, failed or cancelled');
  }

  /** The transaction body; null when the guarded flip matched nothing (nothing else ran). */
  async completeInTx(tx: LedgerTx, jobId: string, opts: CompleteOptions): Promise<CompletionResult | null> {
    const data: Record<string, unknown> = { status: 'COMPLETED', completedAt: new Date() };
    if (opts.printDurationSec != null && Number.isFinite(opts.printDurationSec)) data.printDuration = opts.printDurationSec;
    if (opts.filamentUsedMm != null && Number.isFinite(opts.filamentUsedMm)) data.filamentUsedMm = opts.filamentUsedMm;

    // 1. The guarded transition is the first statement (§0.2).
    const flipped = await tx.productionJob.updateMany({
      where: { id: jobId, status: { in: ACTIVE as any } },
      data: data as any,
    });
    if (flipped.count === 0) return null;

    // 2. Read inside the transaction, after the row lock.
    const job: any = await tx.productionJob.findUnique({
      where: { id: jobId },
      include: {
        printer: true,
        materials: { include: { material: true } },
        plates: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!job) return null;

    // 3. Spools, atomically.
    for (const m of job.materials ?? []) {
      if (!m.spoolId || !(m.gramsUsed > 0)) continue;
      await tx.$executeRaw(Prisma.sql`/* completion:spool */ UPDATE "Spool"
        SET "currentWeight" = GREATEST(0, "currentWeight" - ${m.gramsUsed}), "updatedAt" = NOW()
        WHERE "id" = ${m.spoolId}`);
    }

    // 4. Parts of the assembled product: whole-product jobs only (not component or
    //    order-planned jobs, whose parts belong to the assembled product).
    if (job.productId && !job.componentId && job.quantityToProduce > 0) {
      const bom = await tx.productPart.findMany({
        where: { productId: job.productId },
        include: { part: { select: { unitCost: true } } },
      });
      for (const line of bom) {
        const needed = line.quantity * job.quantityToProduce;
        if (needed <= 0) continue;
        await tx.$executeRaw(Prisma.sql`/* completion:part */ UPDATE "Part"
          SET "stockQty" = GREATEST(0, "stockQty" - ${needed}), "updatedAt" = NOW()
          WHERE "id" = ${line.partId}`);
        await tx.jobPart.create({
          data: { jobId, partId: line.partId, quantity: needed, unitCost: line.part?.unitCost ?? 0 },
        });
      }
    }

    // 5. Printer hours.
    if (job.printerId && job.printDuration) {
      await tx.printer.update({
        where: { id: job.printerId },
        data: { totalPrintHours: { increment: job.printDuration / 3600 } },
      });
    }

    // 6. Printed stock, from the filament actually on the job.
    const { credits, warnings } = await this.stock.creditOnComplete(tx, job as JobForCredit, opts.userId ?? null);
    const stockCredits = credits.map((c) => ({
      componentId: c.componentId,
      colourKey: c.colourKey || null,
      delta: c.quantity,
      balanceAfter: c.balanceAfter,
    }));
    return { job, stockCredits, warnings };
  }
}
