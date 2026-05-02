import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

const SPOOL_BUFFER_GRAMS = 50;

@Injectable()
export class JobPlanningService {
  constructor(private prisma: PrismaService) {}

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

    // ARCH-01: collect all materialIds needed across all components so we can
    // batch-fetch every active spool in a single query instead of N selectSpool calls.
    const neededMaterialIds = new Set<string>();
    for (const item of order.items) {
      const product = item.productId ? productMap.get(item.productId) : undefined;
      if (!product) continue;
      for (const comp of product.components) {
        if (comp.isMultiColor && comp.materials.length > 0) {
          comp.materials.forEach(cm => neededMaterialIds.add(cm.materialId));
        } else if (comp.materialId) {
          neededMaterialIds.add(comp.materialId);
        }
      }
    }

    const allSpools = neededMaterialIds.size > 0
      ? await this.prisma.spool.findMany({
          where: { materialId: { in: [...neededMaterialIds] }, isActive: true },
          orderBy: { currentWeight: 'desc' },
        })
      : [];

    // Group by materialId for O(1) lookup
    const spoolsByMaterial = new Map<string, typeof allSpools>();
    for (const s of allSpools) {
      if (!spoolsByMaterial.has(s.materialId)) spoolsByMaterial.set(s.materialId, []);
      spoolsByMaterial.get(s.materialId)!.push(s);
    }

    const plan: any[] = [];

    for (const item of order.items) {
      if (!item.productId) continue;
      const product = productMap.get(item.productId);
      if (!product) continue;

      for (const comp of product.components) {
        const needed = comp.quantity * item.quantity;
        const onHand = comp.stockOnHand;
        const deficit = Math.max(0, needed - onHand);

        const subMaterials: any[] = [];
        if (comp.isMultiColor && comp.materials.length > 0) {
          for (const cm of comp.materials) {
            const cmGrams = cm.gramsUsed * deficit;
            const cmBuffer = cmGrams + SPOOL_BUFFER_GRAMS;
            const spool = this.selectSpoolFromCache(spoolsByMaterial, cm.materialId, cmBuffer);
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
          const totalGrams = comp.gramsUsed * deficit;
          const requiredWithBuffer = totalGrams + SPOOL_BUFFER_GRAMS;
          const spool = this.selectSpoolFromCache(spoolsByMaterial, comp.materialId, requiredWithBuffer);
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

  /**
   * Select the best spool from an already-fetched in-memory cache:
   * prefer the smallest spool that still has enough (best-fit), fall back to
   * the heaviest active spool when none is sufficient.
   */
  private selectSpoolFromCache(
    spoolsByMaterial: Map<string, Array<{ id: string; materialId: string; currentWeight: number }>>,
    materialId: string,
    requiredWithBuffer: number,
  ) {
    const spools = spoolsByMaterial.get(materialId) ?? [];
    if (spools.length === 0) return null;
    // smallest that fits (already sorted desc — scan from end)
    const fitting = spools.filter(s => s.currentWeight >= requiredWithBuffer);
    if (fitting.length > 0) return fitting[fitting.length - 1]; // smallest fitting
    return spools[0]; // fallback: heaviest available
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

    if (order.status === 'CONFIRMED') {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { status: 'IN_PRODUCTION' },
      });
    }

    return { jobsCreated: createdJobs.length, jobs: createdJobs };
  }
}
