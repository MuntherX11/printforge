import { ConflictException, Injectable } from '@nestjs/common';
import { plateShares, type Problem } from '@printforge/types';
import { PrismaService } from '../common/prisma/prisma.service';
import { parseFail, parseUpdateJob } from './job-input';
import { JobsService } from './jobs.service';

/**
 * Jobs made from one plate of an order's print plan (v2.19.0) carry its id in
 * `orderPlateId`. They are ONE physical print — several parts on one bed — so
 * starting, completing or failing one of them does the same to the others.
 *
 * The first job goes through JobsService exactly as before; then its siblings
 * go through the same method: on a start, those that were in the first job's
 * status; on a completion or a failure, every sibling that is still open
 * (QUEUED, IN_PROGRESS or PAUSED) — the plate came off the printer, whatever
 * each job's row said. A sibling that already got there (a bridge or another
 * click was quicker) is fine. One that cannot follow never undoes the first
 * job: what happened is said in a SIBLING_JOB warning on the answer.
 *
 * Failing a shared plate with wasted filament: the grams typed in are the
 * plate's, so they are split over its jobs by their planned grams instead of
 * being taken from the spool once per job.
 *
 * Pausing, cancelling and editing stay per job.
 */

export const SIBLING_JOB = 'SIBLING_JOB';

interface Before {
  status: string | null;
  /** the siblings to take along, oldest first */
  siblings: Array<{ id: string; name: string }>;
}

const OPEN = ['QUEUED', 'IN_PROGRESS', 'PAUSED'];

@Injectable()
export class JobSiblingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
  ) {}

  /** The job's status and its siblings, read before the change: those in its status, or (`open`) every open one. */
  private async before(id: string, open = false): Promise<Before> {
    const job = await this.prisma.productionJob.findUnique({ where: { id }, select: { status: true, orderPlateId: true } });
    if (!job?.orderPlateId) return { status: job?.status ?? null, siblings: [] };
    const siblings = await this.prisma.productionJob.findMany({
      where: { orderPlateId: job.orderPlateId, id: { not: id }, status: open ? { in: OPEN as any } : job.status },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
    return { status: job.status, siblings };
  }

  /** Runs `each` for every sibling; a failure becomes a warning, except "already done" (409): that is where it should be. */
  private async follow(siblings: Before['siblings'], did: string, each: (s: { id: string; name: string }, index: number) => Promise<unknown>): Promise<Problem[]> {
    const warnings: Problem[] = [];
    for (const [i, s] of siblings.entries()) {
      try {
        await each(s, i);
      } catch (e) {
        if (e instanceof ConflictException) continue;
        warnings.push({ code: SIBLING_JOB, message: `"${s.name}" is on the same plate but could not be ${did}: ${(e as Error)?.message ?? 'unknown error'} — open it and do it by hand` });
      }
    }
    return warnings;
  }

  /** J8. Starting a job (status IN_PROGRESS) starts the jobs that share its plate. */
  async update(id: string, body: unknown) {
    const starting = parseUpdateJob(body).status === 'IN_PROGRESS';
    const before = starting ? await this.before(id) : { status: null, siblings: [] };
    const result = await this.jobs.update(id, body);
    // Already printing: nothing started, so nothing to pass on.
    if (!before.siblings.length || before.status === 'IN_PROGRESS') return result;
    const warnings = await this.follow(before.siblings, 'started', (s) => this.jobs.update(s.id, { status: 'IN_PROGRESS' }));
    return warnings.length ? { ...result, warnings } : result;
  }

  /** J6. Completing a job completes the jobs that share its plate. */
  async complete(id: string, userId?: string | null) {
    const before = await this.before(id, true);
    const result = await this.jobs.completeJob(id, userId);
    if (!before.siblings.length) return result;
    const warnings = await this.follow(before.siblings, 'completed', (s) => this.jobs.completeJob(s.id, userId));
    return { ...result, warnings: [...(result.warnings ?? []), ...warnings] };
  }

  /** J9. Failing a job fails the jobs that share its plate; the wasted grams are the plate's, shared out. */
  async fail(id: string, body: unknown) {
    const dto = parseFail(body);
    const before = await this.before(id, true);
    if (!before.siblings.length) return this.jobs.failJob(id, body);

    const ids = [id, ...before.siblings.map((s) => s.id)];
    const lines = await this.prisma.jobMaterial.findMany({ where: { jobId: { in: ids } }, select: { jobId: true, gramsUsed: true } });
    const planned = ids.map((jobId) => lines.filter((l) => l.jobId === jobId).reduce((s, l) => s + l.gramsUsed, 0));
    const waste = plateShares(dto.wasteGrams, planned).map((g) => Math.round(g * 10) / 10);
    const bodyFor = (i: number) => ({ failureReason: dto.failureReason ?? undefined, wasteGrams: waste[i] ?? 0 });

    const result = await this.jobs.failJob(id, bodyFor(0));
    const warnings = await this.follow(before.siblings, 'marked as failed', (s, i) => this.jobs.failJob(s.id, bodyFor(i + 1)));
    return warnings.length ? { ...result, warnings } : result;
  }
}
