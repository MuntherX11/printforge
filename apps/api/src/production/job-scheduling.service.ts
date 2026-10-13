import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { sharedWithOf } from './job-shared-plate';

@Injectable()
export class JobSchedulingService {
  constructor(private prisma: PrismaService) {}

  async autoAssign() {
    const unassigned = await this.prisma.productionJob.findMany({
      where: { status: 'QUEUED', printerId: null },
      include: { product: { select: { defaultPrinterId: true } } },
      orderBy: { createdAt: 'asc' },
    });

    if (unassigned.length === 0) {
      return { assigned: 0, jobs: [] };
    }

    const printers = await this.prisma.printer.findMany({
      where: {
        isActive: true,
        status: { notIn: ['MAINTENANCE', 'ERROR', 'OFFLINE'] },
      },
      include: {
        _count: {
          select: {
            productionJobs: {
              where: { status: { in: ['QUEUED', 'IN_PROGRESS'] as any[] } },
            },
          },
        },
      },
    });

    if (printers.length === 0) {
      return { assigned: 0, jobs: [], reason: 'No available printers' };
    }

    const loadMap = new Map<string, number>();
    for (const p of printers) {
      loadMap.set(p.id, (p._count as any)?.productionJobs || 0);
    }

    // Determine assignments in memory first
    const assignments: Array<{ jobId: string; printerId: string }> = [];

    for (const job of unassigned) {
      let targetPrinterId: string | null = null;

      const defaultId = job.product?.defaultPrinterId;
      if (defaultId && loadMap.has(defaultId)) {
        targetPrinterId = defaultId;
      }

      if (!targetPrinterId) {
        let minLoad = Infinity;
        for (const [pid, load] of loadMap) {
          if (load < minLoad) {
            minLoad = load;
            targetPrinterId = pid;
          }
        }
      }

      if (!targetPrinterId) continue;

      loadMap.set(targetPrinterId, (loadMap.get(targetPrinterId) || 0) + 1);
      assignments.push({ jobId: job.id, printerId: targetPrinterId });
    }

    if (assignments.length === 0) {
      return { assigned: 0, jobs: [] };
    }

    // Flush all updates in a single transaction instead of N serial round-trips
    const updatedJobs = await this.prisma.$transaction(
      assignments.map(({ jobId, printerId }) =>
        this.prisma.productionJob.update({
          where: { id: jobId },
          data: { printerId },
          include: { printer: { select: { id: true, name: true } } },
        }),
      ),
    );

    return { assigned: updatedJobs.length, jobs: updatedJobs };
  }

  async getQueue() {
    const printers = await this.prisma.printer.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        model: true,
        status: true,
        productionJobs: {
          where: { status: { in: ['QUEUED', 'IN_PROGRESS', 'PAUSED'] } },
          orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            name: true,
            status: true,
            quantityToProduce: true,
            colorChanges: true,
            createdAt: true,
            orderPlateId: true,
            order: { select: { id: true, orderNumber: true } },
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    const unassigned = await this.prisma.productionJob.findMany({
      where: { status: 'QUEUED', printerId: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        status: true,
        quantityToProduce: true,
        colorChanges: true,
        createdAt: true,
        orderPlateId: true,
        order: { select: { id: true, orderNumber: true } },
      },
    });

    // Jobs of one order plate print together: each names the others (v2.19.0).
    const shared = await sharedWithOf(this.prisma, [...printers.flatMap((p) => p.productionJobs), ...unassigned]);
    const withShared = <J extends { id: string }>(j: J) => ({ ...j, sharedWith: shared.get(j.id) ?? [] });
    return {
      printers: printers.map((p) => ({ ...p, productionJobs: p.productionJobs.map(withShared) })),
      unassigned: unassigned.map(withShared),
    };
  }
}
