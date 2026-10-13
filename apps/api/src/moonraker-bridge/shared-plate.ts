import { plateShares } from '@printforge/types';
import type { PrismaService } from '../common/prisma/prisma.service';

/**
 * Jobs made from one plate of an order's print plan share `orderPlateId`: they
 * are ONE physical print (v2.19.0). A printer reports that print once, so the
 * bridges pass the event on to the other jobs of the plate, and what the
 * printer measured (time, filament length) is shared out by each job's planned
 * minutes instead of being counted once per job.
 */

type Db = Pick<PrismaService, 'productionJob' | 'jobPlate'>;

export interface SharedPlateJob {
  id: string;
  /** This job's part of what the printer measured for the whole plate, 0..1. */
  share: number;
}

/**
 * The job and the open jobs (QUEUED / IN_PROGRESS) that share its plate, the
 * job itself first. A job that shares no plate comes back alone with share 1.
 */
export async function sharedPlateJobs(prisma: Db, jobId: string): Promise<SharedPlateJob[]> {
  const job = await prisma.productionJob.findUnique({ where: { id: jobId }, select: { orderPlateId: true } }).catch(() => null);
  if (!job?.orderPlateId) return [{ id: jobId, share: 1 }];
  const siblings = await prisma.productionJob.findMany({
    where: { orderPlateId: job.orderPlateId, id: { not: jobId }, status: { in: ['QUEUED', 'IN_PROGRESS'] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  }).catch(() => [] as Array<{ id: string }>);
  if (!siblings.length) return [{ id: jobId, share: 1 }];
  const ids = [jobId, ...siblings.map((s) => s.id)];
  const plates = await prisma.jobPlate.findMany({ where: { jobId: { in: ids } }, select: { jobId: true, plateMinutes: true, plateCount: true } }).catch(() => []);
  const minutes = ids.map((id) => plates.filter((p) => p.jobId === id).reduce((s, p) => s + p.plateMinutes * p.plateCount, 0));
  return plateShares(1, minutes).map((share, i) => ({ id: ids[i], share }));
}

/** The other QUEUED jobs of the plate start with the one the printer started. Returns how many. */
export async function startSharedPlateJobs(prisma: Db, jobId: string): Promise<number> {
  const job = await prisma.productionJob.findUnique({ where: { id: jobId }, select: { orderPlateId: true, printerId: true } }).catch(() => null);
  if (!job?.orderPlateId) return 0;
  const started = await prisma.productionJob.updateMany({
    where: { orderPlateId: job.orderPlateId, id: { not: jobId }, status: 'QUEUED' },
    data: { status: 'IN_PROGRESS', startedAt: new Date() },
  }).catch(() => ({ count: 0 }));
  return started.count;
}
