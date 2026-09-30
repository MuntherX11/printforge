import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { OrderCancelledJob, OrderRunningJob } from '@printforge/types';

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
 * The two job cancellations outside JobsService / JobCompletionService, the
 * only other places that change a job's status:
 *
 * - cancelQueuedJobsForItem, S11's (spec §3.9 "Changing a sold line's colour",
 *   WP6 for WP7): one line's QUEUED jobs, 409 when any job of it has started.
 * - cancelQueuedJobsForOrder, S9's (v2.17.2): every QUEUED job of a cancelled
 *   order; started jobs are left alone and listed, never a 409.
 *
 * Both run inside the caller's transaction, after its other locks (S11's FOR
 * SHARE locks; S9's order flip and line locks), so neither is the first
 * statement (§0.2). They are still race-safe: a printer bridge's guarded
 * QUEUED → IN_PROGRESS flip and their updateMany lock the same row, so
 * whichever commits first wins — the cancel then either doesn't match the
 * started job and sees it on the re-read (S11: 409, the whole transaction rolls
 * back; S9: listed as still running), or has cancelled it (the bridge's flip
 * then matches nothing).
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

/**
 * S9: cancel every QUEUED job of the order (matched by orderId, the jobs S4
 * shows). Returns the jobs this call cancelled and the started ones
 * (IN_PROGRESS / PAUSED) it left alone, both in createdAt order. Jobs cancelled
 * earlier (J8, S11) are not reported; COMPLETED and FAILED jobs are untouched.
 */
export async function cancelQueuedJobsForOrder(tx: Tx, orderId: string): Promise<{ cancelled: OrderCancelledJob[]; stillRunning: OrderRunningJob[] }> {
  const queued = await tx.productionJob.findMany({ where: { orderId, status: 'QUEUED' }, select: { id: true } });
  if (queued.length) {
    await tx.productionJob.updateMany({
      where: { id: { in: queued.map((j) => j.id) }, orderId, status: 'QUEUED' },
      data: { status: 'CANCELLED' },
    });
  }
  const after = await tx.productionJob.findMany({
    where: { orderId, status: { in: ['CANCELLED', 'IN_PROGRESS', 'PAUSED'] } },
    select: { id: true, name: true, status: true, printer: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const mine = new Set(queued.map((j) => j.id));
  const cancelled: OrderCancelledJob[] = [];
  const stillRunning: OrderRunningJob[] = [];
  for (const j of after) {
    const row = { id: j.id, name: j.name, printerName: j.printer?.name ?? null };
    if (j.status !== 'CANCELLED') stillRunning.push({ ...row, status: j.status === 'PAUSED' ? 'PAUSED' : 'IN_PROGRESS' });
    else if (mine.has(j.id)) cancelled.push(row);
  }
  return { cancelled, stillRunning };
}

export const ORDER_CANCELLED_NO_NEW_JOBS = 'This order is cancelled — no new jobs can be added to it';
export const ORDER_CANCELLED_NO_REQUEUE = "This order is cancelled — its jobs can't be queued again";

type OrderTx = Parameters<typeof lockOrderPlan>[0] & Pick<Prisma.TransactionClient, 'order'>;

/**
 * Whether a QUEUED job may be written for this order: takes the order's plan
 * lock (so it must be the transaction's first statement), then reads the
 * status. A cancel (S9) either committed first and is seen here, or runs after
 * and cancels what this transaction queued. A missing order → true: the
 * caller's own 404 or foreign key handles it.
 */
export async function orderAcceptsJobs(tx: OrderTx, orderId: string): Promise<boolean> {
  await lockOrderPlan(tx, orderId);
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } });
  return order?.status !== 'CANCELLED';
}

/** orderAcceptsJobs, or 409 with `message`. */
export async function assertOrderAcceptsJobs(tx: OrderTx, orderId: string, message = ORDER_CANCELLED_NO_NEW_JOBS): Promise<void> {
  if (!(await orderAcceptsJobs(tx, orderId))) throw new ConflictException(message);
}
