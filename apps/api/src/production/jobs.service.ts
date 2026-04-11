import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CostingService } from '../costing/costing.service';
import { CreateProductionJobDto, UpdateProductionJobDto } from '@printforge/types';
import { PaginationDto, paginate, paginatedResponse } from '../common/dto/pagination.dto';

const SPOOL_BUFFER_GRAMS = 50;

@Injectable()
export class JobsService {
  constructor(
    private prisma: PrismaService,
    private costingService: CostingService,
  ) {}

  async create(dto: CreateProductionJobDto) {
    return this.prisma.productionJob.create({
      data: {
        name: dto.name,
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
    const where = status ? { status: status as any } : {};
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

    // Mark job completed
    return this.update(id, { status: 'COMPLETED' } as any);
  }
}
