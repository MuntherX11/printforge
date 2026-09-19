import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

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
