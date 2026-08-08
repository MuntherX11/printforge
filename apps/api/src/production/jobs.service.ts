import { Injectable, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { requiredNumber } from '../common/utils/validate-number';
import { CostingService } from '../costing/costing.service';
import { EventsGateway } from '../websocket/events.gateway';
import { JobPlanningService } from './job-planning.service';
import { JobSchedulingService } from './job-scheduling.service';
import { CreateProductionJobDto, UpdateProductionJobDto, FailJobDto, JobStatus } from '@printforge/types';
import { PaginationDto, paginate, paginatedResponse } from '../common/dto/pagination.dto';
import { EmailNotificationService } from '../communications/email-notification.service';
import { WhatsAppService } from '../communications/whatsapp.service';
import { SettingsService } from '../settings/settings.service';

/** Minimal shape of a customer row returned via Prisma include. */
interface CustomerRecord {
  name: string;
  email: string | null;
  phone: string | null;
}

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
    const purpose = dto.purpose ?? 'CUSTOMER';
    const isInternal = purpose !== 'CUSTOMER';

    // Test/sample/waste prints are deliberately not tied to an order or a
    // product — they still burn filament, so they carry their own material
    // lines instead.
    if (!isInternal && !dto.orderId && !dto.productId) {
      throw new BadRequestException('A production job must be linked to an order or a product');
    }
    if (isInternal && !dto.productId && !(dto.materials?.length)) {
      throw new BadRequestException('A test print needs at least one filament line (spool + grams)');
    }

    let autoName = dto.name?.trim() || '';

    if (dto.orderId) {
      const order = await this.prisma.order.findUnique({
        where: { id: dto.orderId },
        include: { customer: { select: { name: true } } },
      });
      if (!order) throw new NotFoundException('Linked order not found');
      if (!autoName) {
        autoName = order.customer?.name
          ? `${order.orderNumber} — ${order.customer.name}`
          : order.orderNumber;
      }
    }
    if (dto.productId) {
      const product = await this.prisma.product.findUnique({ where: { id: dto.productId } });
      if (!product) throw new NotFoundException('Linked product not found');
      if (!autoName) autoName = product.name;
    }

    // quantityToProduce was previously never persisted, so every job recorded 1
    // no matter what was requested — silently under-consuming BOM parts and
    // under-crediting component stock on completion.
    const quantityToProduce = dto.quantityToProduce === undefined
      ? 1
      : requiredNumber(dto.quantityToProduce, 'quantityToProduce', { min: 1, max: 100_000, integer: true });

    // Validate any inline filament lines BEFORE creating anything, so a bad
    // spool id can't leave a job with no materials attached.
    const materialLines: Array<{
      spoolId: string; materialId: string; gramsUsed: number; costPerGram: number;
    }> = [];
    for (const [i, line] of (dto.materials ?? []).entries()) {
      const grams = requiredNumber(line?.gramsUsed, `materials[${i}].gramsUsed`, { min: 0.1, max: 100_000 });
      const spool = await this.prisma.spool.findUnique({
        where: { id: String(line?.spoolId ?? '') },
        select: { id: true, materialId: true, currentWeight: true, material: { select: { costPerGram: true } } },
      });
      if (!spool) throw new BadRequestException(`Filament line ${i + 1}: spool not found`);
      if (spool.currentWeight < grams) {
        throw new BadRequestException(
          `Filament line ${i + 1}: only ${spool.currentWeight.toFixed(0)} g left on that spool, ${grams} g requested`,
        );
      }
      materialLines.push({
        spoolId: spool.id,
        materialId: spool.materialId,
        gramsUsed: grams,
        // Snapshot, so a later price change doesn't rewrite this job's cost.
        costPerGram: spool.material?.costPerGram ?? 0,
      });
    }

    if (isInternal && !autoName) {
      autoName = purpose === 'TEST' ? 'Test print' : purpose === 'SAMPLE' ? 'Sample print' : 'Waste / reprint';
    }

    // One transaction so a job never exists without the filament lines it was
    // created to consume.
    return this.prisma.$transaction(async (tx) => {
      const job = await tx.productionJob.create({
        data: {
          name: autoName || 'Untitled Job',
          productId: dto.productId,
          variantId: dto.variantId,
          componentId: dto.componentId,
          printerId: dto.printerId,
          assignedToId: dto.assignedToId,
          orderId: dto.orderId,
          orderItemId: dto.orderItemId,
          gcodeFilename: dto.gcodeFilename,
          colorChanges: dto.colorChanges || 0,
          quantityToProduce,
          purpose: purpose as any,
        },
      });

      if (materialLines.length) {
        await tx.jobMaterial.createMany({
          data: materialLines.map((l) => ({ ...l, jobId: job.id })),
        });
      }

      return tx.productionJob.findUnique({
        where: { id: job.id },
        include: {
          printer: true,
          assignedTo: { select: { id: true, name: true } },
          materials: { include: { material: true, spool: true } },
        },
      });
    });
  }

  async findAll(query: PaginationDto, status?: string) {
    const validStatuses = ['QUEUED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'];
    const where = status && validStatuses.includes(status) ? { status: status as JobStatus } : {};

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
        materials: {
          include: {
            material: true,
            // Location matters as much as the spool id — the operator has to
            // physically go and fetch it.
            spool: { include: { location: { select: { id: true, name: true } } } },
          },
        },
        reprintOf: { select: { id: true, name: true, status: true } },
        reprints: { select: { id: true, name: true, status: true }, orderBy: { createdAt: 'desc' } },
        attachments: true,
      },
    });
    if (!job) throw new NotFoundException('Production job not found');

    return { ...job, filamentPlan: await this.buildFilamentPlan(job) };
  }

  /**
   * What to load into the printer, as a picking list.
   *
   * Two cases. If filament has already been assigned to the job, report exactly
   * that — with the spool's PrintForge id and where it lives. If it hasn't
   * (a job created straight from a product), derive the requirement from the
   * product's BOM and suggest a spool for each material: the one with least
   * remaining that still covers the job, so part-used spools get finished
   * first rather than opening a new one.
   */
  private async buildFilamentPlan(job: any) {
    const fmt = (m: any, spool: any, grams: number, assigned: boolean, enough: boolean) => ({
      materialId: m?.id ?? null,
      colour: m?.color ?? null,
      type: m?.type ?? null,
      brand: m?.brand ?? null,
      // "White · PLA · eSUN" — how it reads on the shelf
      label: [m?.color, m?.type, m?.brand].filter(Boolean).join(' · ') || m?.name || 'Unknown filament',
      gramsNeeded: Math.round(grams * 10) / 10,
      spoolId: spool?.id ?? null,
      spoolRef: spool?.printforgeId ?? null,
      location: spool?.location?.name ?? null,
      spoolRemaining: spool ? Math.round(spool.currentWeight) : null,
      assigned,
      hasEnough: enough,
    });

    // Filament already assigned to this job.
    if (job.materials?.length) {
      return job.materials.map((jm: any) =>
        fmt(jm.material, jm.spool, jm.gramsUsed, true,
          jm.spool ? jm.spool.currentWeight >= jm.gramsUsed : false),
      );
    }

    if (!job.productId) return [];

    // Otherwise work out what the product needs and suggest spools.
    const components = await this.prisma.productComponent.findMany({
      where: { productId: job.productId },
      include: { material: true, materials: { include: { material: true } } },
    });

    const needed = new Map<string, { material: any; grams: number }>();
    // Components that have a weight but no filament picked yet. Silently
    // dropping them would show an empty list on a job that clearly needs
    // filament, so they get surfaced as an unresolved line instead.
    let unassignedGrams = 0;
    const qty = job.quantityToProduce || 1;
    for (const c of components) {
      if (!c.materialId && !((c as any).materials ?? []).length && c.gramsUsed) {
        unassignedGrams += c.gramsUsed * c.quantity * qty;
      }
      if (c.materialId && c.material) {
        const prev = needed.get(c.materialId);
        const grams = c.gramsUsed * c.quantity * qty;
        needed.set(c.materialId, { material: c.material, grams: (prev?.grams ?? 0) + grams });
      }
      // Multicolour components carry their materials on the join table.
      for (const cm of (c as any).materials ?? []) {
        if (!cm.materialId || !cm.material) continue;
        const prev = needed.get(cm.materialId);
        const grams = cm.gramsUsed * c.quantity * qty;
        needed.set(cm.materialId, { material: cm.material, grams: (prev?.grams ?? 0) + grams });
      }
    }
    const unresolved = unassignedGrams > 0
      ? [fmt({ name: 'Filament not set on product' }, null, unassignedGrams, false, false)]
      : [];
    if (needed.size === 0) return unresolved;

    const spools = await this.prisma.spool.findMany({
      where: { materialId: { in: Array.from(needed.keys()) }, isActive: true, currentWeight: { gt: 0 } },
      include: { location: { select: { id: true, name: true } } },
      orderBy: { currentWeight: 'asc' },
    });

    const planned = Array.from(needed.values()).map(({ material, grams }) => {
      const candidates = spools.filter((s) => s.materialId === material.id);
      // Smallest spool that still covers the job; otherwise the fullest one.
      const pick = candidates.find((s) => s.currentWeight >= grams)
        ?? candidates[candidates.length - 1]
        ?? null;
      return fmt(material, pick, grams, false, !!pick && pick.currentWeight >= grams);
    });

    return [...planned, ...unresolved];
  }

  async update(id: string, dto: UpdateProductionJobDto) {
    if (dto.status === 'COMPLETED' || dto.status === 'FAILED') {
      throw new BadRequestException('Use /jobs/:id/complete or /jobs/:id/fail to transition to terminal states');
    }

    const job = await this.findOne(id);

    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) {
      throw new BadRequestException(`Cannot modify a job in terminal state: ${job.status}`);
    }

    const data: UpdateProductionJobDto & { startedAt?: Date } = { ...dto };

    if (dto.status === JobStatus.IN_PROGRESS && job.status !== JobStatus.IN_PROGRESS) {
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

    // Wrap all inventory mutations + job status update in a single transaction
    // so a crash mid-way doesn't leave stock incremented but spool not decremented.
    const completed = await this.prisma.$transaction(async (tx) => {
      if (job.componentId && job.quantityToProduce > 0) {
        await tx.productComponent.update({
          where: { id: job.componentId },
          data: { stockOnHand: { increment: job.quantityToProduce } },
        });
      }

      // ARCH-01: batch spool reads into one query instead of N findUnique calls
      const spoolIds = job.materials.filter(m => m.spoolId && m.gramsUsed > 0).map(m => m.spoolId!);
      const spoolRows = spoolIds.length > 0
        ? await tx.spool.findMany({ where: { id: { in: spoolIds } }, select: { id: true, currentWeight: true } })
        : [];
      const spoolWeights = new Map(spoolRows.map(s => [s.id, s.currentWeight]));

      for (const mat of job.materials) {
        if (mat.spoolId && mat.gramsUsed > 0) {
          const newWeight = Math.max(0, (spoolWeights.get(mat.spoolId) ?? 0) - mat.gramsUsed);
          await tx.spool.update({ where: { id: mat.spoolId }, data: { currentWeight: newWeight } });
        }
      }

      // Non-printed parts (NFC tags, heat inserts, keyrings…): consume the
      // product's BOM once per finished unit. Component-level jobs are skipped
      // so a multi-component product doesn't consume the same parts repeatedly
      // — the parts belong to the assembled product, not each printed piece.
      if (job.productId && !job.componentId && job.quantityToProduce > 0) {
        const bom = await tx.productPart.findMany({
          where: { productId: job.productId },
          include: { part: { select: { stockQty: true, unitCost: true } } },
        });
        for (const line of bom) {
          const needed = line.quantity * job.quantityToProduce;
          if (needed <= 0) continue;
          await tx.part.update({
            where: { id: line.partId },
            data: { stockQty: Math.max(0, line.part.stockQty - needed) },
          });
          await tx.jobPart.create({
            data: {
              jobId: id,
              partId: line.partId,
              quantity: needed,
              unitCost: line.part.unitCost, // snapshot so past jobs stay accurate
            },
          });
        }
      }

      if (job.printerId && job.printDuration) {
        await tx.printer.update({
          where: { id: job.printerId },
          data: { totalPrintHours: { increment: job.printDuration / 3600 } },
        });
      }

      return tx.productionJob.update({
        where: { id },
        data: { status: 'COMPLETED', completedAt: new Date() },
        include: { printer: true, materials: { include: { material: true } } },
      });
    });

    // Non-fatal: run after commit so it doesn't block the transaction
    await this.calculateCost(id).catch(() => {
      // Cost fields may already be populated or materials missing
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
    const customer = order.customer as CustomerRecord | null;

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

    // Wrap spool deductions + status update in a single transaction so a mid-loop
    // crash doesn't leave stock partially decremented while the job stays non-FAILED.
    const failed = await this.prisma.$transaction(async (tx) => {
      if (wasteGrams > 0 && job.materials.length > 0) {
        const totalPlanned = job.materials.reduce((s, m) => s + m.gramsUsed, 0);
        if (totalPlanned > 0) {
          // ARCH-01: batch spool reads — one findMany instead of N findUnique calls
          const failSpoolIds = job.materials.filter(m => m.spoolId).map(m => m.spoolId!);
          const failSpools = failSpoolIds.length > 0
            ? await tx.spool.findMany({ where: { id: { in: failSpoolIds } }, select: { id: true, currentWeight: true } })
            : [];
          const failSpoolWeights = new Map(failSpools.map(s => [s.id, s.currentWeight]));

          for (const mat of job.materials) {
            if (mat.spoolId) {
              const proportion = mat.gramsUsed / totalPlanned;
              const matWaste = wasteGrams * proportion;
              const newWeight = Math.max(0, (failSpoolWeights.get(mat.spoolId) ?? 0) - matWaste);
              await tx.spool.update({ where: { id: mat.spoolId }, data: { currentWeight: newWeight } });
            }
          }
        }
      }

      return tx.productionJob.update({
        where: { id },
        data: {
          status: 'FAILED',
          failureReason: dto.failureReason,
          failedAt: new Date(),
          wasteGrams,
        },
        include: { printer: true, materials: { include: { material: true } } },
      });
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

    // ARCH-01: createMany instead of N sequential create calls
    if (original.materials.length > 0) {
      await this.prisma.jobMaterial.createMany({
        data: original.materials.map(mat => ({
          jobId: newJob.id,
          materialId: mat.materialId,
          spoolId: mat.spoolId,
          gramsUsed: mat.gramsUsed,
          costPerGram: mat.costPerGram,
          colorIndex: mat.colorIndex,
        })),
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
