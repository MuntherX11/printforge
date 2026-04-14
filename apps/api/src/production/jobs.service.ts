import { Injectable, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CostingService } from '../costing/costing.service';
import { EventsGateway } from '../websocket/events.gateway';
import { CreateProductionJobDto, UpdateProductionJobDto, FailJobDto } from '@printforge/types';
import { PaginationDto, paginate, paginatedResponse } from '../common/dto/pagination.dto';

const SPOOL_BUFFER_GRAMS = 50;

@Injectable()
export class JobsService {
  constructor(
    private prisma: PrismaService,
    private costingService: CostingService,
    @Optional() private gateway: EventsGateway,
  ) {}

  async create(dto: CreateProductionJobDto) {
    if (!dto.orderId && !dto.productId) {
      throw new BadRequestException('A production job must be linked to an order or a product');
    }

    // Verify existence of linked entities
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
    const job = await this.findOne(id);

    const data: any = { ...dto };

    // Set timestamps based on status changes
    if (dto.status === 'IN_PROGRESS' && job.status !== 'IN_PROGRESS') {
      data.startedAt = new Date();
    }
    if (dto.status === 'COMPLETED' && job.status !== 'COMPLETED') {
      data.completedAt = new Date();
    }

    const updated = await this.prisma.productionJob.update({
      where: { id },
      data,
      include: {
        printer: true,
        materials: { include: { material: true } },
      },
    });

    return updated;
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
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        customer: { select: { id: true, name: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    const productIds = [...new Set(order.items.map(i => i.productId).filter(Boolean))] as string[];
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
      include: {
        components: {
          include: {
            material: true,
            materials: { include: { material: true }, orderBy: { sortOrder: 'asc' } },
          },
          orderBy: { sortOrder: 'asc' },
        },
        defaultPrinter: true,
      },
    });
    const productMap = new Map(products.map(p => [p.id, p]));

    const plan: any[] = [];

    for (const item of order.items) {
      if (!item.productId) continue;
      const product = productMap.get(item.productId);
      if (!product) continue;

      const isMultiColor = product.colorChanges > 0;

      for (const comp of product.components) {
        const needed = comp.quantity * item.quantity;
        const onHand = comp.stockOnHand;
        const deficit = Math.max(0, needed - onHand);

        // Build sub-material spool suggestions for multicolor components
        const subMaterials: any[] = [];
        if (comp.isMultiColor && comp.materials.length > 0) {
          for (const cm of comp.materials) {
            const cmGrams = cm.gramsUsed * deficit;
            const cmBuffer = cmGrams + SPOOL_BUFFER_GRAMS;
            const spool = await this.selectSpool(cm.materialId, cmBuffer);
            subMaterials.push({
              componentMaterialId: cm.id,
              materialId: cm.materialId,
              materialName: cm.material.name,
              materialColor: cm.material.color,
              colorIndex: cm.colorIndex,
              gramsPerUnit: cm.gramsUsed,
              totalGrams: cmGrams,
              suggestedSpool: spool ? {
                id: spool.id,
                pfid: (spool as any).printforgeId || (spool as any).pfid,
                currentWeight: spool.currentWeight,
                hasEnough: spool.currentWeight >= cmBuffer,
              } : null,
            });
          }
        } else if (comp.materialId) {
          // Single-color: one material
          const totalGrams = comp.gramsUsed * deficit;
          const requiredWithBuffer = totalGrams + SPOOL_BUFFER_GRAMS;
          const spool = await this.selectSpool(comp.materialId, requiredWithBuffer);
          subMaterials.push({
            componentMaterialId: null,
            materialId: comp.materialId,
            materialName: comp.material?.name || 'Unknown',
            materialColor: comp.material?.color || null,
            colorIndex: 0,
            gramsPerUnit: comp.gramsUsed,
            totalGrams,
            suggestedSpool: spool ? {
              id: spool.id,
              pfid: (spool as any).printforgeId || (spool as any).pfid,
              currentWeight: spool.currentWeight,
              hasEnough: spool.currentWeight >= requiredWithBuffer,
            } : null,
          });
        }

        plan.push({
          orderItemId: item.id,
          productId: product.id,
          productName: product.name,
          componentId: comp.id,
          componentDescription: comp.description,
          isMultiColor: comp.isMultiColor,
          needed,
          onHand,
          toProduce: deficit,
          gramsPerUnit: comp.gramsUsed,
          totalGrams: comp.gramsUsed * deficit,
          printMinutes: comp.printMinutes * deficit,
          printerId: product.defaultPrinter?.id || null,
          printerName: product.defaultPrinter?.name || null,
          subMaterials,
        });
      }
    }

    return { order, plan };
  }

  private async selectSpool(materialId: string, requiredWithBuffer: number) {
    // Best: lowest weight spool that has enough + buffer
    const best = await this.prisma.spool.findFirst({
      where: {
        materialId,
        isActive: true,
        currentWeight: { gte: requiredWithBuffer },
      },
      orderBy: { currentWeight: 'asc' },
    });
    if (best) return best;

    // Fallback: spool with most stock
    return this.prisma.spool.findFirst({
      where: { materialId, isActive: true },
      orderBy: { currentWeight: 'desc' },
    });
  }

  async createFromPlan(orderId: string, planOverrides?: Array<{
    componentId: string;
    toProduce: number;
    printerId?: string;
    spoolId?: string;
  }>) {
    const { order, plan } = await this.previewPlan(orderId);
    const overrideMap = new Map((planOverrides || []).map(o => [o.componentId, o]));
    const createdJobs: any[] = [];

    for (const item of plan) {
      const override = overrideMap.get(item.componentId);
      const toProduce = override?.toProduce ?? item.toProduce;
      if (toProduce <= 0) continue;

      const printerId = override?.printerId || item.printerId;

      const job = await this.prisma.productionJob.create({
        data: {
          name: `${item.productName} — ${item.componentDescription} (×${toProduce})`,
          orderId,
          orderItemId: item.orderItemId,
          productId: item.productId,
          componentId: item.componentId,
          quantityToProduce: toProduce,
          printerId,
          colorChanges: item.isMultiColor
            ? (await this.prisma.product.findUnique({ where: { id: item.productId } }))?.colorChanges || 0
            : 0,
        },
        include: { printer: true },
      });

      // Create JobMaterial for each sub-material (handles both single + multicolor)
      for (const sub of item.subMaterials) {
        const material = await this.prisma.material.findUnique({ where: { id: sub.materialId } });
        if (!material) continue;

        const spoolId = override?.spoolId || sub.suggestedSpool?.id || null;

        await this.prisma.jobMaterial.create({
          data: {
            jobId: job.id,
            materialId: sub.materialId,
            spoolId,
            gramsUsed: sub.gramsPerUnit * toProduce,
            costPerGram: material.costPerGram,
            colorIndex: sub.colorIndex,
          },
        });
      }

      createdJobs.push(job);
    }

    // Update order status to IN_PRODUCTION if it was CONFIRMED
    if (order.status === 'CONFIRMED') {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { status: 'IN_PRODUCTION' },
      });
    }

    return { jobsCreated: createdJobs.length, jobs: createdJobs };
  }

  async completeJob(id: string) {
    const job = await this.prisma.productionJob.findUnique({
      where: { id },
      include: { materials: true },
    });
    if (!job) throw new NotFoundException('Production job not found');

    // Increment stockOnHand on the component
    if (job.componentId && job.quantityToProduce > 0) {
      await this.prisma.productComponent.update({
        where: { id: job.componentId },
        data: { stockOnHand: { increment: job.quantityToProduce } },
      });
    }

    // Deduct from spool weight
    for (const mat of job.materials) {
      if (mat.spoolId && mat.gramsUsed > 0) {
        await this.prisma.spool.update({
          where: { id: mat.spoolId },
          data: { currentWeight: { decrement: mat.gramsUsed } },
        });
      }
    }

    // Accumulate print hours on printer
    if (job.printerId && job.printDuration) {
      await this.prisma.printer.update({
        where: { id: job.printerId },
        data: { totalPrintHours: { increment: job.printDuration / 3600 } },
      });
    }

    // Auto-calculate COGS before marking complete so P&L reports are accurate
    await this.calculateCost(id).catch(() => {
      // Non-fatal: cost fields may already be populated or materials missing
    });

    // Mark job completed
    const completed = await this.update(id, { status: 'COMPLETED' } as any);
    this.gateway?.broadcastNotification({
      type: 'success',
      title: 'Job Completed',
      message: `"${job.name}" finished successfully.`,
    });
    return completed;
  }

  // ============ FAILED PRINT TRACKING ============

  async failJob(id: string, dto: FailJobDto) {
    const job = await this.prisma.productionJob.findUnique({
      where: { id },
      include: { materials: true },
    });
    if (!job) throw new NotFoundException('Production job not found');
    if (job.status === 'COMPLETED') {
      throw new BadRequestException('Cannot mark a completed job as failed');
    }

    // Deduct waste from spools (filament used up to failure point)
    const wasteGrams = dto.wasteGrams || 0;
    if (wasteGrams > 0 && job.materials.length > 0) {
      // Distribute waste proportionally across materials
      const totalPlanned = job.materials.reduce((s, m) => s + m.gramsUsed, 0);
      for (const mat of job.materials) {
        if (mat.spoolId && totalPlanned > 0) {
          const proportion = mat.gramsUsed / totalPlanned;
          const matWaste = wasteGrams * proportion;
          await this.prisma.spool.update({
            where: { id: mat.spoolId },
            data: { currentWeight: { decrement: matWaste } },
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

    // Clone the job as a new QUEUED job linked to the original
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

    // Clone materials
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

  // ============ JOB SCHEDULING / AUTO-ASSIGNMENT ============

  /**
   * Auto-assign all unassigned QUEUED jobs to available printers.
   * Strategy:
   *  1. Get active printers not in MAINTENANCE/ERROR/OFFLINE
   *  2. For each job, prefer the product's defaultPrinterId if available
   *  3. Load-balance by assigning to printer with fewest active jobs (QUEUED + IN_PROGRESS)
   */
  async autoAssign() {
    // Get unassigned queued jobs
    const unassigned = await this.prisma.productionJob.findMany({
      where: { status: 'QUEUED', printerId: null },
      include: { product: { select: { defaultPrinterId: true } } },
      orderBy: { createdAt: 'asc' },
    });

    if (unassigned.length === 0) {
      return { assigned: 0, jobs: [] };
    }

    // Get available printers (active, not in maintenance/error/offline)
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

    // Build a mutable load map: printerId → current active job count
    const loadMap = new Map<string, number>();
    for (const p of printers) {
      loadMap.set(p.id, (p._count as any)?.productionJobs || 0);
    }

    const assigned: any[] = [];

    for (const job of unassigned) {
      let targetPrinterId: string | null = null;

      // Prefer product's default printer if it's available
      const defaultId = job.product?.defaultPrinterId;
      if (defaultId && loadMap.has(defaultId)) {
        targetPrinterId = defaultId;
      }

      // Otherwise pick the printer with the lowest load
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

      // Assign the job
      const updated = await this.prisma.productionJob.update({
        where: { id: job.id },
        data: { printerId: targetPrinterId },
        include: { printer: { select: { id: true, name: true } } },
      });

      // Increment the load count for this printer
      loadMap.set(targetPrinterId, (loadMap.get(targetPrinterId) || 0) + 1);
      assigned.push(updated);
    }

    return { assigned: assigned.length, jobs: assigned };
  }

  /**
   * Get the job queue grouped by printer.
   * Returns each printer with its ordered queue of QUEUED + IN_PROGRESS jobs.
   */
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

    // Also get unassigned jobs
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
