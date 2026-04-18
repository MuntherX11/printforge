import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { GcodeParserService } from '../file-parser/gcode-parser.service';
import { ThreeMfParserService } from '../file-parser/threemf-parser.service';
import { ProductCostingService } from './product-costing.service';
import { OnboardThreeMfDto } from '@printforge/types';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class ProductOnboardingService {
  constructor(
    private prisma: PrismaService,
    private gcodeParser: GcodeParserService,
    private threeMfParser: ThreeMfParserService,
    private productCosting: ProductCostingService,
  ) {}

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

  private async findOrCreateMaterial(
    allMaterials: any[],
    materialType: string,
    colorHex?: string,
  ): Promise<string> {
    const typeUpper = materialType.toUpperCase();
    const colorName = colorHex ? this.hexToColorName(colorHex) : null;

    if (colorName) {
      const match = allMaterials.find(
        m => m.type.toUpperCase() === typeUpper &&
          m.color?.toLowerCase() === colorName.toLowerCase(),
      );
      if (match) return match.id;
    }

    if (!colorName) {
      const typeMatch = allMaterials.find(m => m.type.toUpperCase() === typeUpper);
      if (typeMatch) return typeMatch.id;
      if (allMaterials.length > 0) return allMaterials[0].id;
    }

    const created = await this.prisma.material.create({
      data: {
        name: `${materialType} ${colorName || 'Unknown'}`,
        type: typeUpper as any,
        color: colorName || null,
        costPerGram: 0,
        density: 1.24,
      },
    });
    allMaterials.push(created);
    return created.id;
  }

  private async savePlateThumbnail(productId: string, plateIndex: number, thumbnailBase64: string) {
    try {
      const uploadDir = process.env.UPLOAD_DIR || '/app/uploads';
      const now = new Date();
      const dateDir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
      const fullDir = path.join(uploadDir, dateDir);
      if (!fs.existsSync(fullDir)) fs.mkdirSync(fullDir, { recursive: true });

      const base64Data = thumbnailBase64.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const fileName = `plate-${plateIndex}-${Date.now()}.png`;
      fs.writeFileSync(path.join(fullDir, fileName), buffer);

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

      const product = await this.prisma.product.findUnique({ where: { id: productId } });
      if (product && !product.imageUrl) {
        await this.prisma.product.update({ where: { id: productId }, data: { imageUrl: storagePath } });
      }
    } catch {
      // Non-fatal — thumbnail save failure should not abort the import
    }
  }

  async onboardFromGcode(productId: string, files: any[]) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, defaultPrinterId: true },
    });
    if (!product) throw new NotFoundException('Product not found');

    const results: Array<{ fileName: string; componentsCreated: number }> = [];
    const allMaterials = await this.prisma.material.findMany();

    for (const file of files) {
      const analysis = this.gcodeParser.parseHeader(file.buffer);
      const fileName = file.originalname || 'unknown.gcode';

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

        const component = await this.prisma.productComponent.create({
          data: {
            productId,
            materialId: null,
            description: fileName.replace(/\.gcode$/i, ''),
            gramsUsed: totalGrams,
            printMinutes: totalTimeMinutes,
            quantity: 1,
            sortOrder: 0,
            isMultiColor: true,
          },
        });

        for (const tool of activeTools) {
          const materialType = tool.materialType || analysis.filamentType || 'PLA';
          const materialId = await this.findOrCreateMaterial(allMaterials, materialType, tool.colorHex);
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
        const gramsUsed = analysis.filamentUsedGrams || 0;
        if (gramsUsed === 0) {
          results.push({ fileName, componentsCreated: 0 });
          continue;
        }

        const materialType = analysis.filamentType || 'PLA';
        const singleToolHex = analysis.filamentColors?.[0] || analysis.tools?.[0]?.colorHex;
        const materialId = await this.findOrCreateMaterial(allMaterials, materialType, singleToolHex);

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

    const updateData: any = {};
    if (totalColorChanges > 0) updateData.colorChanges = totalColorChanges;

    if (!product.defaultPrinterId) {
      const printerNamePattern = isMultiColor ? 'HI' : 'Ender';
      const matchedPrinter = await this.prisma.printer.findFirst({
        where: { name: { contains: printerNamePattern, mode: 'insensitive' }, isActive: true },
      });
      if (matchedPrinter) updateData.defaultPrinterId = matchedPrinter.id;
    }

    if (Object.keys(updateData).length > 0) {
      await this.prisma.product.update({ where: { id: productId }, data: updateData });
    }

    await this.productCosting.recalculateAggregates(productId);
    return { results };
  }

  async onboardFromThreeMf(productId: string, fileBuffer: Buffer, dto: OnboardThreeMfDto) {
    const exists = await this.prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!exists) throw new NotFoundException('Product not found');

    const analysis = await this.threeMfParser.parse(fileBuffer);
    const allMaterials = await this.prisma.material.findMany();
    const results: Array<{ plateIndex: number; name: string; componentsCreated: number }> = [];

    const platesToProcess = analysis.plates.filter(p => dto.selectedPlates.includes(p.plateIndex));

    for (const plate of platesToProcess) {
      const componentName = dto.plateNames?.[String(plate.plateIndex)] || plate.name;

      if (plate.tools.length > 1) {
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

        if (plate.thumbnailBase64) {
          await this.savePlateThumbnail(productId, plate.plateIndex, plate.thumbnailBase64);
        }

        results.push({ plateIndex: plate.plateIndex, name: componentName, componentsCreated: 1 });
      } else {
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
          await this.savePlateThumbnail(productId, plate.plateIndex, plate.thumbnailBase64);
        }

        results.push({ plateIndex: plate.plateIndex, name: componentName, componentsCreated: 1 });
      }
    }

    const importedColorChanges = platesToProcess.reduce((s, p) => s + p.toolChanges, 0);
    if (importedColorChanges > 0) {
      await this.prisma.product.update({
        where: { id: productId },
        data: { colorChanges: { increment: importedColorChanges } },
      });
    }

    await this.productCosting.recalculateAggregates(productId);
    return { slicer: analysis.slicer, results };
  }
}
