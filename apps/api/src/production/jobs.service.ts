import { Injectable, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CostingService } from '../costing/costing.service';
import { EventsGateway } from '../websocket/events.gateway';
import { JobPlanningService } from './job-planning.service';
import { JobSchedulingService } from './job-scheduling.service';
import { CreateProductionJobDto, UpdateProductionJobDto, FailJobDto } from '@printforge/types';
import { PaginationDto, paginate, paginatedResponse } from '../common/dto/pagination.dto';
import { EmailNotificationService } from '../communications/email-notification.service';
import { WhatsAppService } from '../communications/whatsapp.service';
import { SettingsService } from '../settings/settings.service';

@Injectable()
export class JobsService {
  constructor(
    private prisma: PrismaService,
    private costingService: CostingService,
    @Optional() private gateway: EventsGateway,
    private jobPlanning: JobPlanningService,
    private jobScheduling: JobSchedulingService,
    @Optional() private emailNotifications?: EmailNotificationService,
    @Optional() private whatsapp?: WhatsAppService,
    @Optional() private settingsService?: SettingsService,
  ) {}

  async create(dto: CreateProductionJobDto) {
    if (!dto.orderId && !dto.productId) {
      throw new BadRequestException('A production job must be linked to an order or a product');
    }

    if (dto.orderId) {
      const order = await this.prisma.order.findUnique({ where: { id: dto.orderId } });
      if (!order) throw new NotFoundException('Linked order not found');
    }
    if (dto.productId) {
      const product = await this.prisma.product.findUnique({ where: { id: dto.productId } });
      if (!product) throw new NotFoundException('Linked product not found');
    }

    return this.prisma.productionJob.create({
      data: {
        name: dto.name,
        productId: dto.productId,
        printerId: dto.printerId,
        assignedToId: dto.assignedToId,
        orderId: dto.orderId,
        orderItemId: dto.orderItemId,
        gcodeFilename: dto.gcodeFilename,
        colorChanges: dto.colorChanges || 0,
      },
      include: { printer: true, assignedTo: { select: { id: true, name: true } } },
    });
  }

  async findAll(query: PaginationDto, status?: string) {
    const validStatuses = ['QUEUED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'];
    const where = status && validStatuses.includes(status) ? { status: status as any } : {};

    const [data, total] = await Promise.all([
      this.prisma.productionJob.findMany({
        where,
        ...paginate(query),
        include: {
          printer: { select: { id: true, name: true } },
          assignedTo: { select: { id: true, name: true } },
          order: { select: { id: true, orderNumber: true } },
        },
      }),
      this.prisma.productionJob.count({ where }),
    ]);
    return paginatedResponse(data, total, query);
  }

  async findOne(id: string) {
    const job = await this.prisma.productionJob.findUnique({
      where: { id },
      include: {
        printer: true,
        assignedTo: { select: { id: true, name: true, email: true } },
        order: { select: { id: true, orderNumber: true, customer: { select: { id: true, name: true } } } },
        orderItem: true,
        materials: { include: { material: true, spool: true } },
        reprintOf: { select: { id: true, name: true, status: true } },
        reprints: { select: { id: true, name: true, status: true }, orderBy: { createdAt: 'desc' } },
        attachments: true,
      },
    });
    if (!job) throw new NotFoundException('Production job not found');
    return job;
  }

  async update(id: string, dto: UpdateProductionJobDto) {
    if (dto.status === 'COMPLETED' || dto.status === 'FAILED') {
      throw new BadRequestException('Use /jobs/:id/complete or /jobs/:id/fail to transition to terminal states');
    }

    const job = await this.findOne(id);

    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) {
      throw new BadRequestException(`Cannot modify a job in terminal state: ${job.status}`);
    }

    const data: any = { ...dto };

    if (dto.status === 'IN_PROGRESS' && job.status !== 'IN_PROGRESS') {
      data.startedAt = new Date();
    }

    return this.prisma.productionJob.update({
      where: { id },
      data,
      include: {
        printer: true,
        materials: { include: { material: true } },
      },
    });
  }

  async calculateCost(id: string) {
    const job = await this.prisma.productionJob.findUnique({
      where: { id },
      include: { printer: true, materials: { include: { material: true } } },
    });
    if (!job) throw new NotFoundException('Production job not found');

    const breakdown = await this.costingService.calculateJobCost(job);

    return this.prisma.productionJob.update({
      where: { id },
      data: {
        materialCost: breakdown.materialCost,
        machineCost: breakdown.machineCost,
        wasteCost: breakdown.wasteCost,
        overheadCost: breakdown.overheadCost,
        totalCost: breakdown.totalCost,
      },
    });
  }

  async previewPlan(orderId: string) {
    return this.jobPlanning.previewPlan(orderId);
  }

  async createFromPlan(orderId: string, planOverrides?: Array<{
    componentId: string;
    toProduce: number;
    printerId?: string;
    spoolId?: string;
  }>) {
    return this.jobPlanning.createFromPlan(orderId, planOverrides);
  }

  async completeJob(id: string) {
    const job = await this.prisma.productionJob.findUnique({
      where: { id },
      include: { materials: true },
    });
    if (!job) throw new NotFoundException('Production job not found');
    if (job.status === 'COMPLETED') {
      throw new BadRequestException('Job is already completed');
    }

    if (job.componentId && job.quantityToProduce > 0) {
      await this.prisma.productComponent.update({
        where: { id: job.componentId },
        data: { stockOnHand: { increment: job.quantityToProduce } },
      });
    }

    for (const mat of job.materials) {
      if (mat.spoolId && mat.gramsUsed > 0) {
        const spool = await this.prisma.spool.findUnique({ where: { id: mat.spoolId }, select: { currentWeight: true } });
        const newWeight = Math.max(0, (spool?.currentWeight ?? 0) - mat.gramsUsed);
        await this.prisma.spool.update({ where: { id: mat.spoolId }, data: { currentWeight: newWeight } });
      }
    }

    if (job.printerId && job.printDuration) {
      await this.prisma.printer.update({
        where: { id: job.printerId },
        data: { totalPrintHours: { increment: job.printDuration / 3600 } },
      });
    }

    await this.calculateCost(id).catch(() => {
      // Non-fatal: cost fields may already be populated or materials missing
    });

    const completed = await this.prisma.productionJob.update({
      where: { id },
      data: { status: 'COMPLETED', completedAt: new Date() },
      include: { printer: true, materials: { include: { material: true } } },
    });
    this.gateway?.broadcastNotification({
      type: 'success',
      title: 'Job Completed',
      message: `"${job.name}" finished successfully.`,
    });

    // If this job belongs to an order, check if all order jobs are now done
    // and notify the customer
    if (job.orderId) {
      await this.notifyOrderCompletedIfAllDone(job.orderId).catch(() => {});
    }

    return completed;
  }

  private async notifyOrderCompletedIfAllDone(orderId: string) {
    const allJobs = await this.prisma.productionJob.findMany({
      where: { orderId },
      select: { status: true },
    });

    const allDone = allJobs.length > 0 && allJobs.every(j =>
      ['COMPLETED', 'FAILED', 'CANCELLED'].includes(j.status),
    );
    if (!allDone) return;

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: true },
    });
    if (!order) return;

    const notifyEnabled = await this.settingsService?.get('notify_order_completed', 'true') ?? 'true';
    if (notifyEnabled === 'false') return;

    const companyName = await this.settingsService?.get('company_name', 'PrintForge') ?? 'PrintForge';
    const customer = order.customer as any;

    if (customer?.email) {
      this.emailNotifications?.notifyCustomerOrderCompleted(customer.email, { orderNumber: order.orderNumber }).catch(() => {});
    }
    if (customer?.phone) {
      this.whatsapp?.sendOrderCompleted(customer.phone, { customerName: customer.name, orderNumber: order.orderNumber, companyName }).catch(() => {});
    }
  }

  async failJob(id: string, dto: FailJobDto) {
    const job = await this.prisma.productionJob.findUnique({
      where: { id },
      include: { materials: true },
    });
    if (!job) throw new NotFoundException('Production job not found');
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) {
      throw new BadRequestException('Cannot fail a job that is already in a terminal state');
    }

    const wasteGrams = dto.wasteGrams || 0;
    if (wasteGrams > 0 && job.materials.length > 0) {
      const totalPlanned = job.materials.reduce((s, m) => s + m.gramsUsed, 0);
      for (const mat of job.materials) {
        if (mat.spoolId && totalPlanned > 0) {
          const proportion = mat.gramsUsed / totalPlanned;
          const matWaste = wasteGrams * proportion;
          const spool = await this.prisma.spool.findUnique({
            where: { id: mat.spoolId },
            select: { currentWeight: true },
          });
          const newWeight = Math.max(0, (spool?.currentWeight ?? 0) - matWaste);
          await this.prisma.spool.update({
            where: { id: mat.spoolId },
            data: { currentWeight: newWeight },
          });
        }
      }
    }

    const failed = await this.prisma.productionJob.update({
      where: { id },
      data: {
        status: 'FAILED',
        failureReason: dto.failureReason,
        failedAt: new Date(),
        wasteGrams,
      },
      include: { printer: true, materials: { include: { material: true } } },
    });
    this.gateway?.broadcastNotification({
      type: 'error',
      title: 'Job Failed',
      message: `"${job.name}" failed${dto.failureReason ? `: ${dto.failureReason}` : ''}.`,
    });
    return failed;
  }

  async reprintJob(id: string) {
    const original = await this.prisma.productionJob.findUnique({
      where: { id },
      include: { materials: true },
    });
    if (!original) throw new NotFoundException('Production job not found');
    if (original.status !== 'FAILED') {
      throw new BadRequestException('Only failed jobs can be reprinted');
    }

    const newJob = await this.prisma.productionJob.create({
      data: {
        name: `${original.name} (reprint)`,
        printerId: original.printerId,
        assignedToId: original.assignedToId,
        orderId: original.orderId,
        orderItemId: original.orderItemId,
        productId: original.productId,
        componentId: original.componentId,
        quantityToProduce: original.quantityToProduce,
        colorChanges: original.colorChanges,
        gcodeFilename: original.gcodeFilename,
        reprintOfId: original.id,
      },
      include: { printer: true },
    });

    for (const mat of original.materials) {
      await this.prisma.jobMaterial.create({
        data: {
          jobId: newJob.id,
          materialId: mat.materialId,
          spoolId: mat.spoolId,
          gramsUsed: mat.gramsUsed,
          costPerGram: mat.costPerGram,
          colorIndex: mat.colorIndex,
        },
      });
    }

    return newJob;
  }

  async getFailureStats() {
    const [totalJobs, failedJobs, wasteAgg, reprintCount] = await Promise.all([
      this.prisma.productionJob.count(),
      this.prisma.productionJob.count({ where: { status: 'FAILED' } }),
      this.prisma.productionJob.aggregate({
        where: { status: 'FAILED' },
        _sum: { wasteGrams: true },
      }),
      this.prisma.productionJob.count({ where: { reprintOfId: { not: null } } }),
    ]);

    return {
      totalJobs,
      failedJobs,
      failureRate: totalJobs > 0 ? Math.round((failedJobs / totalJobs) * 10000) / 100 : 0,
      totalWasteGrams: wasteAgg._sum.wasteGrams || 0,
      reprintCount,
    };
  }

  async autoAssign() {
    return this.jobScheduling.autoAssign();
  }

  async getQueue() {
    return this.jobScheduling.getQueue();
  }
}
