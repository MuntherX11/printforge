import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CostingService } from '../costing/costing.service';
import { ProductCostResult } from '@printforge/types';

@Injectable()
export class ProductCostingService {
  constructor(
    private prisma: PrismaService,
    private costingService: CostingService,
  ) {}

  async calculateCost(id: string): Promise<ProductCostResult> {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        defaultPrinter: true,
        components: {
          include: {
            material: true,
            materials: { include: { material: true }, orderBy: { sortOrder: 'asc' } },
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    if (!product) throw new NotFoundException('Product not found');

    const componentResults: ProductCostResult['components'] = [];
    let totalMaterialCost = 0;
    let totalMachineCost = 0;

    for (const comp of product.components) {
      const totalGrams = comp.gramsUsed * comp.quantity;
      const totalMinutes = comp.printMinutes * comp.quantity;

      const isMulticolor = !comp.materialId && ((comp as any).materials?.length > 0 || (comp as any).componentMaterials?.length > 0);
      const subMaterials: any[] = (comp as any).materials ?? (comp as any).componentMaterials ?? [];

      let estimate: any;
      if (isMulticolor) {
        const avgCostPerGram = subMaterials.length
          ? subMaterials.reduce((s: number, cm: any) => s + (cm.material?.costPerGram ?? 0), 0) / subMaterials.length
          : 0;
        estimate = await this.costingService.calculateJobCost({
          printDuration: totalMinutes * 60, colorChanges: 0, purgeWasteGrams: 0,
          printer: null, materials: [{ gramsUsed: totalGrams, costPerGram: avgCostPerGram }],
        });
      } else if (!comp.materialId) {
        estimate = await this.costingService.calculateJobCost({
          printDuration: totalMinutes * 60, colorChanges: 0, purgeWasteGrams: 0,
          printer: null, materials: [],
        });
      } else {
        estimate = await this.costingService.estimateFromParams({
          gramsUsed: totalGrams, printMinutes: totalMinutes,
          materialId: comp.materialId, colorChanges: 0,
        });
      }

      totalMaterialCost += estimate.materialCost;
      totalMachineCost += estimate.machineCost;

      const materialName = (comp as any).material?.name
        ?? (isMulticolor
          ? subMaterials.map((cm: any) => cm.material?.name).filter(Boolean).join(' / ') || 'Multicolor'
          : 'Unknown');

      componentResults.push({
        description: comp.description,
        materialName,
        gramsUsed: comp.gramsUsed,
        printMinutes: comp.printMinutes,
        quantity: comp.quantity,
        componentCost: estimate.totalCost,
      });
    }

    const allMaterials = product.components.map((c: any) => {
      const subs: any[] = c.materials ?? c.componentMaterials ?? [];
      const costPerGram = c.material?.costPerGram
        ?? (subs.length ? subs.reduce((s: number, cm: any) => s + (cm.material?.costPerGram ?? 0), 0) / subs.length : 0);
      return { gramsUsed: c.gramsUsed * c.quantity, costPerGram };
    });

    const defaultPrinter = product.defaultPrinterId
      ? await this.prisma.printer.findUnique({ where: { id: product.defaultPrinterId } })
      : null;

    const fullBreakdown = await this.costingService.calculateJobCost({
      printDuration: product.estimatedMinutes * 60,
      colorChanges: product.colorChanges,
      purgeWasteGrams: 0,
      printer: defaultPrinter,
      materials: allMaterials,
    });

    const markupMultiplier = (defaultPrinter as any)?.markupMultiplier || parseFloat(
      (await this.prisma.systemSetting.findUnique({ where: { key: 'markup_multiplier' } }))?.value || '2.5',
    );

    const suggestedPrice = fullBreakdown.totalCost * markupMultiplier;
    await this.prisma.product.update({
      where: { id },
      data: { basePrice: Math.round(suggestedPrice * 1000) / 1000 },
    });

    return {
      ...fullBreakdown,
      suggestedPrice: Math.round(suggestedPrice * 1000) / 1000,
      markupMultiplier,
      components: componentResults,
    };
  }

  async recalculateAggregates(productId: string) {
    const components = await this.prisma.productComponent.findMany({
      where: { productId },
      include: { material: true },
    });

    const estimatedGrams = components.reduce((sum, c) => sum + c.gramsUsed * c.quantity, 0);
    const estimatedMinutes = components.reduce((sum, c) => sum + c.printMinutes * c.quantity, 0);

    await this.prisma.product.update({
      where: { id: productId },
      data: {
        estimatedGrams: Math.round(estimatedGrams * 1000) / 1000,
        estimatedMinutes: Math.round(estimatedMinutes * 1000) / 1000,
      },
    });

    if (components.length > 0) {
      await this.calculateCost(productId);
    }
  }
}
