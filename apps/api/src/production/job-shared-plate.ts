import type { PrismaService } from '../common/prisma/prisma.service';

/**
 * Which jobs print together (v2.19.0): jobs made from one plate of an order's
 * print plan carry its id in `orderPlateId` and are one physical print. The
 * read side of production/job-siblings.ts, for the job page and the job list.
 */

type Db = Pick<PrismaService, 'productionJob'>;

export interface SharedJob {
  id: string;
  name: string;
}

/** For each job that came from an order plate: the other jobs of that plate that are not cancelled. */
export async function sharedWithOf(db: Db, jobs: ReadonlyArray<{ id: string; orderPlateId?: string | null }>): Promise<Map<string, SharedJob[]>> {
  const out = new Map<string, SharedJob[]>();
  const plateIds = [...new Set(jobs.map((j) => j.orderPlateId).filter((x): x is string => !!x))];
  if (!plateIds.length) return out;
  const all: Array<{ id: string; name: string; orderPlateId: string | null }> = await db.productionJob.findMany({
    where: { orderPlateId: { in: plateIds }, status: { not: 'CANCELLED' } },
    select: { id: true, name: true, orderPlateId: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const j of jobs) {
    if (!j.orderPlateId) continue;
    out.set(j.id, all.filter((x) => x.orderPlateId === j.orderPlateId && x.id !== j.id).map((x) => ({ id: x.id, name: x.name })));
  }
  return out;
}

/** The J3 / list additions of one job (JobSharedPlate). */
export async function sharedPlateOf(db: Db, job: { id: string; orderPlateId?: string | null }) {
  return { orderPlateId: job.orderPlateId ?? null, sharedWith: (await sharedWithOf(db, [job])).get(job.id) ?? [] };
}
