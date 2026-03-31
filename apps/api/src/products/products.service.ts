import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CostingService } from '../costing/costing.service';
import {
  CreateProductDto,
  UpdateProductDto,
  AddProductComponentDto,
  UpdateProductComponentDto,
  ProductCostResult,
} from '@printforge/types';

@Injectable()
export class ProductsService {
  constructor(
    private prisma: PrismaService,
    private costingService: CostingService,
  ) {}

  async create(dto: CreateProductDto) {
    return this.prisma.product.create({
      data: {
        name: dto.name,
        description: dto.description,
        sku: dto.sku,
        colorChanges: dto.colorChanges || 0,
      },
      include: { components: { include: { material: true } } },
    });
  }

  async findAll() {
    return this.prisma.product.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { components: true } },
      },
    });
  }

  async findAllActive() {
    return this.prisma.product.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        sku: true,
        estimatedGrams: true,
        estimatedMinutes: true,
        colorChanges: true,
        basePrice: true,
      },
    });
  }

  async findOne(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        components: {
          include: { material: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async update(id: string, dto: UpdateProductDto) {
    await this.findOne(id);
    return this.prisma.product.update({
      where: { id },
      data: dto,
      include: {
        components: {
          include: { material: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
  }

  async addComponent(productId: string, dto: AddProductComponentDto) {
    await this.findOne(productId);
    const material = await this.prisma.material.findUnique({ where: { id: dto.materialId } });
    if (!material) throw new NotFoundException('Material not found');

    const component = await this.prisma.productComponent.create({
      data: {
        productId,
        materialId: dto.materialId,
        description: dto.description,
        gramsUsed: dto.gramsUsed,
        printMinutes: dto.printMinutes || 0,
        quantity: dto.quantity || 1,
        sortOrder: dto.sortOrder || 0,
      },
      include: { material: true },
    });

    await this.recalculateAggregates(productId);
    return component;
  }

  async updateComponent(componentId: string, dto: UpdateProductComponentDto) {
    const component = await this.prisma.productComponent.findUnique({ where: { id: componentId } });
    if (!component) throw new NotFoundException('Component not found');

    const updated = await this.prisma.productComponent.update({
      where: { id: componentId },
      data: dto,
      include: { material: true },
    });

    await this.recalculateAggregates(component.productId);
    return updated;
  }

  async removeComponent(componentId: string) {
    const component = await this.prisma.productComponent.findUnique({ where: { id: componentId } });
    if (!component) throw new NotFoundException('Component not found');

    await this.prisma.productComponent.delete({ where: { id: componentId } });
    await this.recalculateAggregates(component.productId);
    return { deleted: true };
  }

  async calculateCost(id: string): Promise<ProductCostResult> {
    const product = await this.findOne(id);

    const componentResults: ProductCostResult['components'] = [];
    let totalMaterialCost = 0;
    let totalMachineCost = 0;

    for (const comp of product.components) {
      const totalGrams = comp.gramsUsed * comp.quantity;
      const totalMinutes = comp.printMinutes * comp.quantity;

      const estimate = await this.costingService.estimateFromParams({
        gramsUsed: totalGrams,
        printMinutes: totalMinutes,
        materialId: comp.materialId,
        colorChanges: 0,
      });

      totalMaterialCost += estimate.materialCost;
      totalMachineCost += estimate.machineCost;

      componentResults.push({
        description: comp.description,
        materialName: comp.material.name,
        gramsUsed: comp.gramsUsed,
        printMinutes: comp.printMinutes,
        quantity: comp.quantity,
        componentCost: estimate.totalCost,
      });
    }

    // Calculate full product cost with color changes
    const allMaterials = product.components.map(c => ({
      gramsUsed: c.gramsUsed * c.quantity,
      costPerGram: c.material.costPerGram,
    }));

    const fullBreakdown = await this.costingService.calculateJobCost({
      printDuration: product.estimatedMinutes * 60,
      colorChanges: product.colorChanges,
      purgeWasteGrams: 0,
      printer: null,
      materials: allMaterials,
    });

    const markupMultiplier = parseFloat(
      (await this.prisma.systemSetting.findUnique({ where: { key: 'markup_multiplier' } }))?.value || '2.5',
    );

    const suggestedPrice = fullBreakdown.totalCost * markupMultiplier;

    // Update cached basePrice
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

  private async recalculateAggregates(productId: string) {
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

    // Recalculate cost if there are components
    if (components.length > 0) {
      await this.calculateCost(productId);
    }
  }
}
