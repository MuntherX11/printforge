import type { OrderCancelledJob, OrderRunningJob } from '@printforge/types';
import { cancelQueuedJobsForOrder, lockOrderPlan } from '../production/job-transitions';
import type { LedgerTx, ProductStockService } from '../stock-ledger/product-stock.service';

/** What S9's cancel did; all three lists are empty when it changed nothing. */
export interface OrderCancelOutcome {
  released: Array<{ componentId: string; colourKey: string; units: number }>;
  jobsCancelled: OrderCancelledJob[];
  jobsStillRunning: OrderRunningJob[];
}

/** Fresh empty lists on every call. */
export const noCancel = (): OrderCancelOutcome => ({ released: [], jobsCancelled: [], jobsStillRunning: [] });

/**
 * S9's cancel, the whole transaction body. Every request for CANCELLED runs it,
 * so the decision is made under the plan lock. Lock order, the one S11, O7 and
 * JobCompletionService already follow (no deadlock):
 *
 *   1. the order's plan lock (always first);
 *   2. the guarded order flip — matching nothing means the order is already
 *      cancelled: only notes / dueDate are saved (when given), nothing else runs;
 *   3. the order's lines, FOR UPDATE in id order;
 *   4. its QUEUED jobs → CANCELLED (started jobs are left alone and listed);
 *   5. printed stock released per line (component rows), attributed to the user;
 *   6. one audit row per cancelled job, atomic with the change it records.
 */
export async function cancelOrderInTx(
  tx: LedgerTx,
  stock: ProductStockService,
  orderId: string,
  fields: { notes?: string | null; dueDate?: Date },
  userId: string | null,
): Promise<OrderCancelOutcome> {
  await lockOrderPlan(tx, orderId);
  const flipped = await tx.order.updateMany({
    where: { id: orderId, status: { not: 'CANCELLED' } },
    data: { status: 'CANCELLED', notes: fields.notes, dueDate: fields.dueDate },
  });
  if (flipped.count === 0) {
    if (fields.notes !== undefined || fields.dueDate !== undefined) {
      await tx.order.updateMany({ where: { id: orderId }, data: { notes: fields.notes, dueDate: fields.dueDate } });
    }
    return noCancel();
  }

  await stock.lockOrderLines(tx, orderId);
  const jobs = await cancelQueuedJobsForOrder(tx, orderId);
  const credits = await stock.releaseForOrder(tx, orderId, userId);
  if (userId && jobs.cancelled.length) {
    await tx.auditLog.createMany({
      data: jobs.cancelled.map((j) => ({
        userId, action: 'Job.cancelled', entityType: 'Job', entityId: j.id, details: { via: 'ORDER_CANCELLED', orderId },
      })),
    });
  }
  return {
    released: credits.map((c) => ({ componentId: c.componentId, colourKey: c.colourKey, units: c.quantity })),
    jobsCancelled: jobs.cancelled,
    jobsStillRunning: jobs.stillRunning,
  };
}
