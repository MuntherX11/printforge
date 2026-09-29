import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * The per-order plan lock (spec §4.4 J5 rule 1): a transaction-scoped advisory
 * lock on `plan:<orderId>`. J5 takes it first, and so do the two other writers
 * of an order's printed-stock allocations, S9's cancel and S11's line colour
 * change. Each of them therefore runs wholly before or after a J5 of the same
 * order: a cancel returns what a J5 in flight allocated, a J5 after a cancel
 * reads CANCELLED, and a J5 after an S11 split recomputes on the new lines.
 * Taken before any other lock, so it adds no lock-order cycle.
 */
export async function lockOrderPlan(tx: { $queryRaw: (q: Prisma.Sql) => Promise<unknown> }, orderId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`/* plan:advisory */ SELECT 1 AS "ok" FROM (SELECT pg_advisory_xact_lock(hashtext(${`plan:${orderId}`}))) AS "l"`);
}

/**
 * S11's job cancellation (spec §3.9 "Changing a sold line's colour", WP6 for
 * WP7). The only place outside JobsService / JobCompletionService that changes a
 * job's status.
 *
 * Runs inside the caller's transaction, after S11's FOR SHARE locks (the one
 * transition that is not the first statement, §0.2). It is still race-safe: a
 * printer bridge's guarded QUEUED → IN_PROGRESS flip and this updateMany lock the
 * same row, so whichever commits first wins — S11 then either doesn't match the
 * started job and sees it on the re-read (409, whole transaction rolls back), or
 * has cancelled it (the bridge's flip then matches nothing).
 */

type Tx = Pick<Prisma.TransactionClient, 'productionJob'>;

export const LINE_STARTED_MESSAGE = 'Jobs for this line have started — swap the filament on the job instead';

const STARTED = ['IN_PROGRESS', 'PAUSED', 'COMPLETED'];

export async function cancelQueuedJobsForItem(tx: Tx, orderItemId: string): Promise<Array<{ id: string; name: string }>> {
  const queued = await tx.productionJob.findMany({
    where: { orderItemId, status: 'QUEUED' },
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  });
  if (queued.length) {
    await tx.productionJob.updateMany({
      where: { id: { in: queued.map((j) => j.id) }, orderItemId, status: 'QUEUED' },
      data: { status: 'CANCELLED' },
    });
  }
  const after = await tx.productionJob.findMany({
    where: { orderItemId },
    select: { id: true, status: true },
  });
  if (after.some((j) => STARTED.includes(j.status))) throw new ConflictException(LINE_STARTED_MESSAGE);
  const cancelled = new Set(after.filter((j) => j.status === 'CANCELLED').map((j) => j.id));
  return queued.filter((j) => cancelled.has(j.id));
}
