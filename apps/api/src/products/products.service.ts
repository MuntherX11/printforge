import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CostingService } from '../costing/costing.service';
import { GcodeParserService } from '../file-parser/gcode-parser.service';
import { ThreeMfParserService } from '../file-parser/threemf-parser.service';
import {
  CreateProductDto,
  UpdateProductDto,
  AddProductComponentDto,
  UpdateProductComponentDto,
  ProductCostResult,
  OnboardThreeMfDto,
} from '@printforge/types';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class ProductsService {
  constructor(
    private prisma: PrismaService,
    private costingService: CostingService,
    private gcodeParser: GcodeParserService,
    private threeMfParser: ThreeMfParserService,
  ) {}

  async create(dto: CreateProductDto) {
    return this.prisma.product.create({
      data: {
        name: dto.name,
        description: dto.description,
        sku: dto.sku,
        colorChanges: dto.colorChanges || 0,
        defaultPrinterId: (dto as any).defaultPrinterId || null,
      },
      include: { components: { include: { material: true } }, defaultPrinter: true },
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
        defaultPrinter: true,
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
            materials: {
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
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    if (!product) throw new NotFoundException('Product not found');

    // Enrich components with stock availability
    const enrichedComponents = product.components.map((c: any) => {
      if (c.isMultiColor && c.materials?.length > 0) {
        // Multicolor: check each sub-material has enough stock
        const enrichedMaterials = c.materials.map((cm: any) => {
          const activeSpools = cm.material?.spools || [];
          const totalStock = activeSpools.reduce((sum: number, s: any) => sum + s.currentWeight, 0);
          const gramsNeeded = cm.gramsUsed * c.quantity;
          const { spools, ...matWithout } = cm.material || {};
          return {
            ...cm,
            material: matWithout,
            totalStock: Math.round(totalStock),
            gramsNeeded,
            hasEnoughStock: totalStock >= gramsNeeded,
          };
        });
        const allHaveStock = enrichedMaterials.every((m: any) => m.hasEnoughStock);
        return {
          ...c,
          material: null,
          materials: enrichedMaterials,
          totalStock: null,
          gramsNeeded: c.gramsUsed * c.quantity,
          hasEnoughStock: allHaveStock,
        };
      } else {
        // Single-color
        const activeSpools = c.material?.spools || [];
        const totalStock = activeSpools.reduce((sum: number, s: any) => sum + s.currentWeight, 0);
        const gramsNeeded = c.gramsUsed * c.quantity;
        const { spools, ...materialWithoutSpools } = c.material || {};
        return {
          ...c,
          material: materialWithoutSpools,
          materials: c.materials || [],
          totalStock: Math.round(totalStock),
          gramsNeeded,
          hasEnoughStock: totalStock >= gramsNeeded,
        };
      }
    });

    return { ...product, components: enrichedComponents };
  }

  async remove(id: string) {
    await this.findOne(id);

    // Block deletion if there are active (non-terminal) production jobs for this product
    const activeJobCount = await this.prisma.productionJob.count({
      where: {
        productId: id,
        status: { in: ['QUEUED', 'IN_PROGRESS', 'PAUSED'] },
      },
    });
    if (activeJobCount > 0) {
      throw new BadRequestException(
        `Cannot delete product: ${activeJobCount} active production job${activeJobCount > 1 ? 's' : ''} reference it. Complete or cancel them first.`,
      );
    }

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

      // Multicolor components have materialId=null — estimateFromParams would crash with null ID
      const isMulticolor = !comp.materialId && (comp.materials?.length > 0 || (comp as any).componentMaterials?.length > 0);
      const subMaterials: any[] = comp.materials ?? (comp as any).componentMaterials ?? [];

      let estimate: any;
      if (isMulticolor) {
        const avgCostPerGram = subMaterials.length
          ? subMaterials.reduce((s: number, cm: any) => s + (cm.material?.costPerGram ?? 0), 0) / subMaterials.length
          : 0;
        estimate = await this.costingService.calculateJobCost({
          printDuration: totalMinutes * 60,
          colorChanges: 0,
          purgeWasteGrams: 0,
          printer: null,
          materials: [{ gramsUsed: totalGrams, costPerGram: avgCostPerGram }],
        });
      } else if (!comp.materialId) {
        // No material assigned and no sub-materials — calculate machine time cost only
        estimate = await this.costingService.calculateJobCost({
          printDuration: totalMinutes * 60,
          colorChanges: 0,
          purgeWasteGrams: 0,
          printer: null,
          materials: [],
        });
      } else {
        estimate = await this.costingService.estimateFromParams({
          gramsUsed: totalGrams,
          printMinutes: totalMinutes,
          materialId: comp.materialId,
          colorChanges: 0,
        });
      }

      totalMaterialCost += estimate.materialCost;
      totalMachineCost += estimate.machineCost;

      const materialName = comp.material?.name
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

    // Calculate full product cost with color changes.
    // For multicolor components, average the sub-material cost-per-gram as a proxy.
    const allMaterials = product.components.map(c => {
      const subs: any[] = c.materials ?? c.componentMaterials ?? [];
      const costPerGram = c.material?.costPerGram
        ?? (subs.length
          ? subs.reduce((s: number, cm: any) => s + (cm.material?.costPerGram ?? 0), 0) / subs.length
          : 0);
      return { gramsUsed: c.gramsUsed * c.quantity, costPerGram };
    });

    // Use product's default printer for cost calculation if set
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

    const markupMultiplier = defaultPrinter?.markupMultiplier || parseFloat(
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

      // If multi-tool, create ONE component with multiple ComponentMaterials
      if (analysis.tools && analysis.tools.length > 1) {
        const activeTools = analysis.tools.filter(t => (t.filamentGrams || 0) > 0);
        if (activeTools.length === 0) {
          results.push({ fileName, componentsCreated: 0 });
          continue;
        }

        const totalGrams = activeTools.reduce((sum, t) => sum + (t.filamentGrams || 0), 0);
        const totalTimeMinutes = analysis.estimatedTimeSeconds
          ? Math.round(analysis.estimatedTimeSeconds / 60)
          : 0;

        // Create one component for the entire multicolor part
        const component = await this.prisma.productComponent.create({
          data: {
            productId,
            materialId: null, // multicolor — uses ComponentMaterial entries
            description: fileName.replace(/\.gcode$/i, ''),
            gramsUsed: totalGrams,
            printMinutes: totalTimeMinutes,
            quantity: 1,
            sortOrder: 0,
            isMultiColor: true,
          },
        });

        // Create a ComponentMaterial for each active tool/color
        for (const tool of activeTools) {
          const materialType = tool.materialType || analysis.filamentType || 'PLA';
          const materialId = await this.findOrCreateMaterial(
            allMaterials, materialType, tool.colorHex,
          );

          await this.prisma.componentMaterial.create({
            data: {
              componentId: component.id,
              materialId,
              gramsUsed: tool.filamentGrams || 0,
              colorIndex: tool.index,
              sortOrder: tool.index,
            },
          });
        }

        results.push({ fileName, componentsCreated: 1 });
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

    // Detect multicolor: sum color changes across all files
    let totalColorChanges = 0;
    let isMultiColor = false;
    for (const file of files) {
      const analysis = this.gcodeParser.parseHeader(file.buffer);
      if (analysis.totalFilamentChanges && analysis.totalFilamentChanges > 0) {
        totalColorChanges += analysis.totalFilamentChanges;
        isMultiColor = true;
      }
      const activeTools = (analysis.tools || []).filter(t => (t.filamentGrams || 0) > 0);
      if (activeTools.length > 1) isMultiColor = true;
    }

    // Update product color changes and auto-assign default printer
    const updateData: any = {};
    if (totalColorChanges > 0) updateData.colorChanges = totalColorChanges;

    // Auto-assign default printer if none set: multicolor → "HI", single → "Ender"
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product?.defaultPrinterId) {
      const printerNamePattern = isMultiColor ? 'HI' : 'Ender';
      const matchedPrinter = await this.prisma.printer.findFirst({
        where: { name: { contains: printerNamePattern, mode: 'insensitive' }, isActive: true },
      });
      if (matchedPrinter) updateData.defaultPrinterId = matchedPrinter.id;
    }

    if (Object.keys(updateData).length > 0) {
      await this.prisma.product.update({ where: { id: productId }, data: updateData });
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

  async onboardFromThreeMf(productId: string, fileBuffer: Buffer, dto: OnboardThreeMfDto) {
    await this.findOne(productId);

    const analysis = await this.threeMfParser.parse(fileBuffer);
    const allMaterials = await this.prisma.material.findMany();
    const results: Array<{ plateIndex: number; name: string; componentsCreated: number }> = [];

    // Determine which plates to process
    const platesToProcess = analysis.plates.filter(p => dto.selectedPlates.includes(p.plateIndex));

    for (const plate of platesToProcess) {
      const componentName = dto.plateNames?.[String(plate.plateIndex)] || plate.name;

      if (plate.tools.length > 1) {
        // Multicolor plate — one component with multiple ComponentMaterials
        const component = await this.prisma.productComponent.create({
          data: {
            productId,
            materialId: null,
            description: componentName,
            gramsUsed: plate.weightGrams,
            printMinutes: Math.round(plate.printSeconds / 60),
            quantity: 1,
            sortOrder: plate.plateIndex,
            isMultiColor: true,
          },
        });

        for (const tool of plate.tools) {
          const materialType = tool.materialType || 'PLA';
          const materialId = await this.findOrCreateMaterial(allMaterials, materialType, tool.colorHex);
          await this.prisma.componentMaterial.create({
            data: {
              componentId: component.id,
              materialId,
              gramsUsed: tool.filamentGrams,
              colorIndex: tool.index,
              sortOrder: tool.index,
            },
          });
        }

        // Save plate thumbnail as product attachment if available
        if (plate.thumbnailBase64) {
          await this.savePlateThumbail(productId, plate.plateIndex, plate.thumbnailBase64);
        }

        results.push({ plateIndex: plate.plateIndex, name: componentName, componentsCreated: 1 });
      } else {
        // Single-color plate
        if (plate.weightGrams === 0) {
          results.push({ plateIndex: plate.plateIndex, name: componentName, componentsCreated: 0 });
          continue;
        }

        const tool = plate.tools[0];
        const materialType = tool?.materialType || 'PLA';
        const materialId = await this.findOrCreateMaterial(allMaterials, materialType, tool?.colorHex);

        await this.prisma.productComponent.create({
          data: {
            productId,
            materialId,
            description: componentName,
            gramsUsed: plate.weightGrams,
            printMinutes: Math.round(plate.printSeconds / 60),
            quantity: 1,
            sortOrder: plate.plateIndex,
          },
        });

        if (plate.thumbnailBase64) {
          await this.savePlateThumbail(productId, plate.plateIndex, plate.thumbnailBase64);
        }

        results.push({ plateIndex: plate.plateIndex, name: componentName, componentsCreated: 1 });
      }
    }

    // Update color changes if any plate has tool changes
    const totalColorChanges = platesToProcess.reduce((s, p) => s + p.toolChanges, 0);
    if (totalColorChanges > 0) {
      await this.prisma.product.update({
        where: { id: productId },
        data: { colorChanges: totalColorChanges },
      });
    }

    await this.recalculateAggregates(productId);
    return { slicer: analysis.slicer, results, product: await this.findOne(productId) };
  }

  /**
   * Decode a base64 thumbnail and store it as a product attachment.
   */
  private async savePlateThumbail(productId: string, plateIndex: number, thumbnailBase64: string) {
    try {
      const uploadDir = process.env.UPLOAD_DIR || '/app/uploads';
      const now = new Date();
      const dateDir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
      const fullDir = path.join(uploadDir, dateDir);
      if (!fs.existsSync(fullDir)) fs.mkdirSync(fullDir, { recursive: true });

      // Strip data URL prefix if present
      const base64Data = thumbnailBase64.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const fileName = `plate-${plateIndex}-${Date.now()}.png`;
      const filePath = path.join(fullDir, fileName);
      fs.writeFileSync(filePath, buffer);

      const storagePath = path.join(dateDir, fileName);
      await this.prisma.attachment.create({
        data: {
          entityType: 'product',
          entityId: productId,
          filename: fileName,
          originalName: `Plate ${plateIndex} thumbnail`,
          mimeType: 'image/png',
          sizeBytes: buffer.length,
          storagePath,
        },
      });

      // Set as product imageUrl if none set yet
      const product = await this.prisma.product.findUnique({ where: { id: productId } });
      if (product && !product.imageUrl) {
        await this.prisma.product.update({ where: { id: productId }, data: { imageUrl: storagePath } });
      }
    } catch {
      // Non-fatal — thumbnail save failure should not abort the import
    }
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
