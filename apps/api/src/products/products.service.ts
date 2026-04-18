import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { ProductCostingService } from './product-costing.service';
import { ProductOnboardingService } from './product-onboarding.service';
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
    private productCosting: ProductCostingService,
    private productOnboarding: ProductOnboardingService,
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

    const enrichedComponents = product.components.map((c: any) => {
      if (c.isMultiColor && c.materials?.length > 0) {
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

    await this.prisma.productComponent.deleteMany({ where: { productId: id } });
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

    await this.productCosting.recalculateAggregates(productId);
    return component;
  }

  async updateComponent(componentId: string, dto: UpdateProductComponentDto) {
    const component = await this.prisma.productComponent.findUnique({
      where: { id: componentId },
      include: { material: true },
    });
    if (!component) throw new NotFoundException('Component not found');

    if (dto.materialId && dto.materialId !== component.materialId) {
      const newMaterial = await this.prisma.material.findUnique({ where: { id: dto.materialId } });
      if (!newMaterial) throw new NotFoundException('Material not found');
    }

    const updated = await this.prisma.productComponent.update({
      where: { id: componentId },
      data: dto,
      include: { material: true },
    });

    await this.productCosting.recalculateAggregates(component.productId);
    return updated;
  }

  async removeComponent(componentId: string) {
    const component = await this.prisma.productComponent.findUnique({ where: { id: componentId } });
    if (!component) throw new NotFoundException('Component not found');

    await this.prisma.productComponent.delete({ where: { id: componentId } });
    await this.productCosting.recalculateAggregates(component.productId);
    return { deleted: true };
  }

  async calculateCost(id: string): Promise<ProductCostResult> {
    return this.productCosting.calculateCost(id);
  }

  async onboardFromGcode(productId: string, files: any[]) {
    const { results } = await this.productOnboarding.onboardFromGcode(productId, files);
    return { results, product: await this.findOne(productId) };
  }

  async onboardFromThreeMf(productId: string, fileBuffer: Buffer, dto: OnboardThreeMfDto) {
    const { slicer, results } = await this.productOnboarding.onboardFromThreeMf(productId, fileBuffer, dto);
    return { slicer, results, product: await this.findOne(productId) };
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
}
