import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

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

    const assigned: any[] = [];

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

      const updated = await this.prisma.productionJob.update({
        where: { id: job.id },
        data: { printerId: targetPrinterId },
        include: { printer: { select: { id: true, name: true } } },
      });

      loadMap.set(targetPrinterId, (loadMap.get(targetPrinterId) || 0) + 1);
      assigned.push(updated);
    }

    return { assigned: assigned.length, jobs: assigned };
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
        order: { select: { id: true, orderNumber: true } },
      },
    });

    return { printers, unassigned };
  }
}
