import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CostingService } from '../costing/costing.service';
import { GcodeParserService } from '../file-parser/gcode-parser.service';
import {
  CreateProductDto,
  UpdateProductDto,
  AddProductComponentDto,
  UpdateProductComponentDto,
  ProductCostResult,
} from '@printforge/types';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class ProductsService {
  constructor(
    private prisma: PrismaService,
    private costingService: CostingService,
    private gcodeParser: GcodeParserService,
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
          include: {
            material: {
              include: {
                spools: {
                  where: { isActive: true },
                  select: { id: true, currentWeight: true },
                },
              },
            },
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    if (!product) throw new NotFoundException('Product not found');

    // Enrich components with stock availability
    const enrichedComponents = product.components.map((c: any) => {
      const activeSpools = c.material?.spools || [];
      const totalStock = activeSpools.reduce((sum: number, s: any) => sum + s.currentWeight, 0);
      const gramsNeeded = c.gramsUsed * c.quantity;
      const { spools, ...materialWithoutSpools } = c.material || {};
      return {
        ...c,
        material: materialWithoutSpools,
        totalStock: Math.round(totalStock),
        gramsNeeded,
        hasEnoughStock: totalStock >= gramsNeeded,
      };
    });

    return { ...product, components: enrichedComponents };
  }

  async remove(id: string) {
    await this.findOne(id);
    // Delete components first, then the product
    await this.prisma.productComponent.deleteMany({ where: { productId: id } });
    // Delete associated attachments
    await this.prisma.attachment.deleteMany({ where: { entityType: 'product', entityId: id } });
    await this.prisma.product.delete({ where: { id } });
    return { deleted: true };
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
    const component = await this.prisma.productComponent.findUnique({
      where: { id: componentId },
      include: { material: true },
    });
    if (!component) throw new NotFoundException('Component not found');

    // If materialId is changing, validate the new material
    if (dto.materialId && dto.materialId !== component.materialId) {
      const newMaterial = await this.prisma.material.findUnique({ where: { id: dto.materialId } });
      if (!newMaterial) throw new NotFoundException('Material not found');
    }

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

  /**
   * Map a hex color to the nearest named filament color using RGB distance.
   */
  private hexToColorName(hex: string): string {
    const named: Record<string, [number, number, number]> = {
      Black:   [0, 0, 0],
      White:   [255, 255, 255],
      Red:     [255, 0, 0],
      Blue:    [0, 0, 255],
      Green:   [0, 128, 0],
      Yellow:  [255, 255, 0],
      Orange:  [255, 128, 0],
      Purple:  [128, 0, 128],
      Pink:    [255, 192, 203],
      Brown:   [128, 64, 0],
      Grey:    [128, 128, 128],
      Silver:  [192, 192, 192],
      Gold:    [255, 215, 0],
      Beige:   [245, 222, 179],
      Cyan:    [0, 206, 209],
      Teal:    [0, 128, 128],
      Navy:    [0, 0, 128],
      Magenta: [255, 0, 255],
      Natural: [240, 225, 200],
    };
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) || 0;
    const g = parseInt(h.slice(2, 4), 16) || 0;
    const b = parseInt(h.slice(4, 6), 16) || 0;

    let bestName = 'Black';
    let bestDist = Infinity;
    for (const [name, [nr, ng, nb]] of Object.entries(named)) {
      const d = (r - nr) ** 2 + (g - ng) ** 2 + (b - nb) ** 2;
      if (d < bestDist) {
        bestDist = d;
        bestName = name;
      }
    }
    return bestName;
  }

  /**
   * Find a material by type + color, or auto-create one (no spool, stock = 0).
   */
  private async findOrCreateMaterial(
    allMaterials: any[],
    materialType: string,
    colorHex?: string,
  ): Promise<string> {
    const typeUpper = materialType.toUpperCase();
    const colorName = colorHex ? this.hexToColorName(colorHex) : null;

    // Try type + color match first
    if (colorName) {
      const match = allMaterials.find(
        m => m.type.toUpperCase() === typeUpper &&
          m.color?.toLowerCase() === colorName.toLowerCase(),
      );
      if (match) return match.id;
    }

    // Exact type match (no color filter) as fallback only if no color info
    if (!colorName) {
      const typeMatch = allMaterials.find(m => m.type.toUpperCase() === typeUpper);
      if (typeMatch) return typeMatch.id;
      if (allMaterials.length > 0) return allMaterials[0].id;
    }

    // Auto-create material with the parsed type + color (no spool = 0 stock)
    const created = await this.prisma.material.create({
      data: {
        name: `${materialType} ${colorName || 'Unknown'}`,
        type: typeUpper as any,
        color: colorName || null,
        costPerGram: 0,
        density: 1.24,
      },
    });
    allMaterials.push(created); // cache so subsequent files can match
    return created.id;
  }

  async onboardFromGcode(productId: string, files: any[]) {
    await this.findOne(productId);
    const results: Array<{ fileName: string; componentsCreated: number }> = [];

    // Get all materials for type + color matching
    const allMaterials = await this.prisma.material.findMany();

    for (const file of files) {
      const analysis = this.gcodeParser.parseHeader(file.buffer);
      const fileName = file.originalname || 'unknown.gcode';

      // If multi-tool, create one component per tool
      if (analysis.tools && analysis.tools.length > 1) {
        let created = 0;

        // Split print time proportionally across tools by grams
        const totalGrams = analysis.tools.reduce((sum, t) => sum + (t.filamentGrams || 0), 0);
        const totalTimeMinutes = analysis.estimatedTimeSeconds
          ? Math.round(analysis.estimatedTimeSeconds / 60)
          : 0;

        for (const tool of analysis.tools) {
          const toolGrams = tool.filamentGrams || 0;

          // Skip tools with 0 grams used
          if (toolGrams === 0) continue;

          const materialType = tool.materialType || analysis.filamentType || 'PLA';
          const materialId = await this.findOrCreateMaterial(
            allMaterials, materialType, tool.colorHex,
          );

          // Proportional time split based on grams
          const toolMinutes = totalGrams > 0
            ? Math.round(totalTimeMinutes * (toolGrams / totalGrams))
            : 0;

          await this.prisma.productComponent.create({
            data: {
              productId,
              materialId,
              description: `${fileName} - Tool ${tool.index}`,
              gramsUsed: toolGrams,
              printMinutes: toolMinutes,
              quantity: 1,
              sortOrder: created,
            },
          });
          created++;
        }
        results.push({ fileName, componentsCreated: created });
      } else {
        // Single tool — one component (skip if 0 grams)
        const gramsUsed = analysis.filamentUsedGrams || 0;
        if (gramsUsed === 0) {
          results.push({ fileName, componentsCreated: 0 });
          continue;
        }

        const materialType = analysis.filamentType || 'PLA';
        const singleToolHex = analysis.filamentColors?.[0] || analysis.tools?.[0]?.colorHex;
        const materialId = await this.findOrCreateMaterial(
          allMaterials, materialType, singleToolHex,
        );

        await this.prisma.productComponent.create({
          data: {
            productId,
            materialId,
            description: fileName.replace(/\.gcode$/i, ''),
            gramsUsed,
            printMinutes: analysis.estimatedTimeSeconds ? Math.round(analysis.estimatedTimeSeconds / 60) : 0,
            quantity: 1,
            sortOrder: 0,
          },
        });
        results.push({ fileName, componentsCreated: 1 });
      }
    }

    await this.recalculateAggregates(productId);
    return { results, product: await this.findOne(productId) };
  }

  async uploadImages(productId: string, files: any[]) {
    await this.findOne(productId);
    const uploadDir = process.env.UPLOAD_DIR || '/app/uploads';
    const now = new Date();
    const dateDir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
    const fullDir = path.join(uploadDir, dateDir);

    if (!fs.existsSync(fullDir)) {
      fs.mkdirSync(fullDir, { recursive: true });
    }

    const attachments = [];
    for (const file of files) {
      const fileName = `${Date.now()}-${file.originalname}`;
      const filePath = path.join(fullDir, fileName);
      fs.writeFileSync(filePath, file.buffer);

      const storagePath = path.join(dateDir, fileName);
      const attachment = await this.prisma.attachment.create({
        data: {
          entityType: 'product',
          entityId: productId,
          filename: fileName,
          originalName: file.originalname,
          mimeType: file.mimetype,
          sizeBytes: file.size,
          storagePath,
        },
      });
      attachments.push(attachment);
    }

    // Set first image as product imageUrl if none set
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (product && !product.imageUrl && attachments.length > 0) {
      await this.prisma.product.update({
        where: { id: productId },
        data: { imageUrl: attachments[0].storagePath },
      });
    }

    return attachments;
  }

  async removeImage(productId: string, attachmentId: string) {
    const attachment = await this.prisma.attachment.findUnique({ where: { id: attachmentId } });
    if (!attachment || attachment.entityId !== productId) throw new NotFoundException('Image not found');

    const uploadDir = process.env.UPLOAD_DIR || '/app/uploads';
    const fullPath = path.join(uploadDir, attachment.storagePath);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }

    await this.prisma.attachment.delete({ where: { id: attachmentId } });

    // Clear imageUrl if it was the product's primary image
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (product?.imageUrl === attachment.storagePath) {
      const nextImage = await this.prisma.attachment.findFirst({
        where: { entityType: 'product', entityId: productId },
      });
      await this.prisma.product.update({
        where: { id: productId },
        data: { imageUrl: nextImage?.storagePath || null },
      });
    }

    return { deleted: true };
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
