import { sharedPlateJobs, startSharedPlateJobs } from './shared-plate';

const db = (jobs: Array<{ id: string; orderPlateId: string | null; status: string }>, plates: Array<{ jobId: string; plateMinutes: number; plateCount: number }> = []) => {
  const updateMany = jest.fn(async ({ where }: any) => ({
    count: jobs.filter((j) => j.orderPlateId === where.orderPlateId && j.id !== where.id.not && j.status === where.status).length,
  }));
  return {
    updateMany,
    prisma: {
      productionJob: {
        findUnique: jest.fn(async ({ where }: any) => jobs.find((j) => j.id === where.id) ?? null),
        findMany: jest.fn(async ({ where }: any) => jobs.filter((j) => j.orderPlateId === where.orderPlateId && j.id !== where.id.not && where.status.in.includes(j.status))),
        updateMany,
      },
      jobPlate: { findMany: jest.fn(async ({ where }: any) => plates.filter((p) => where.jobId.in.includes(p.jobId))) },
    } as any,
  };
};

describe('sharedPlateJobs', () => {
  it('a job that shares no plate comes back alone with the whole share', async () => {
    const { prisma } = db([{ id: 'a', orderPlateId: null, status: 'IN_PROGRESS' }]);
    expect(await sharedPlateJobs(prisma, 'a')).toEqual([{ id: 'a', share: 1 }]);
  });

  it('shares what the printer measured by planned minutes, the job itself first', async () => {
    const { prisma } = db(
      [
        { id: 'a', orderPlateId: 'p1', status: 'IN_PROGRESS' },
        { id: 'b', orderPlateId: 'p1', status: 'IN_PROGRESS' },
        { id: 'c', orderPlateId: 'p1', status: 'COMPLETED' },
        { id: 'd', orderPlateId: 'p2', status: 'QUEUED' },
      ],
      [{ jobId: 'a', plateMinutes: 30, plateCount: 1 }, { jobId: 'b', plateMinutes: 90, plateCount: 1 }],
    );
    const group = await sharedPlateJobs(prisma, 'a');
    expect(group.map((g) => g.id)).toEqual(['a', 'b']);
    expect(group[0].share).toBeCloseTo(0.25);
    expect(group[1].share).toBeCloseTo(0.75);
  });

  it('equal shares when no job has planned minutes', async () => {
    const { prisma } = db([{ id: 'a', orderPlateId: 'p1', status: 'QUEUED' }, { id: 'b', orderPlateId: 'p1', status: 'QUEUED' }]);
    expect((await sharedPlateJobs(prisma, 'a')).map((g) => g.share)).toEqual([0.5, 0.5]);
  });

  it('a missing job is treated as a job on its own', async () => {
    const { prisma } = db([]);
    expect(await sharedPlateJobs(prisma, 'gone')).toEqual([{ id: 'gone', share: 1 }]);
  });
});

describe('startSharedPlateJobs', () => {
  it('starts the queued jobs of the same plate only', async () => {
    const { prisma, updateMany } = db([
      { id: 'a', orderPlateId: 'p1', status: 'IN_PROGRESS' },
      { id: 'b', orderPlateId: 'p1', status: 'QUEUED' },
      { id: 'c', orderPlateId: 'p1', status: 'PAUSED' },
    ]);
    expect(await startSharedPlateJobs(prisma, 'a')).toBe(1);
    expect(updateMany.mock.calls[0][0].where).toEqual({ orderPlateId: 'p1', id: { not: 'a' }, status: 'QUEUED' });
  });

  it('does nothing for a job that shares no plate', async () => {
    const { prisma, updateMany } = db([{ id: 'a', orderPlateId: null, status: 'IN_PROGRESS' }]);
    expect(await startSharedPlateJobs(prisma, 'a')).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
