import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreatePartDto, UpdatePartDto, SetProductPartDto, PART_CATEGORIES } from '@printforge/types';
import { PaginationDto, paginate, paginatedResponse } from '../common/dto/pagination.dto';
import { optionalNumber, requiredText, requiredEnum } from '../common/utils/validate-number';

/** Bounds for a bought-in part. Deliberately generous but finite. */
const LIMITS = {
  unitCost: { min: 0, max: 100_000 },
  stockQty: { min: 0, max: 10_000_000, integer: true },
  reorderPoint: { min: 0, max: 10_000_000, integer: true },
};

@Injectable()
export class PartsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreatePartDto) {
    const data = {
      name: requiredText(dto.name, 'Name', 120),
      sku: dto.sku?.trim() || null,
      category: !dto.category
        ? 'OTHER'
        : requiredEnum(dto.category, 'category', PART_CATEGORIES),
      description: dto.description?.trim().slice(0, 500) || null,
      unitCost: optionalNumber(dto.unitCost, 'unitCost', LIMITS.unitCost) ?? 0,
      stockQty: optionalNumber(dto.stockQty, 'stockQty', LIMITS.stockQty) ?? 0,
      reorderPoint: optionalNumber(dto.reorderPoint, 'reorderPoint', LIMITS.reorderPoint) ?? 0,
      supplier: dto.supplier?.trim().slice(0, 200) || null,
      locationId: dto.locationId || null,
      isActive: dto.isActive ?? true,
    };
    try {
      return await this.prisma.part.create({
        data: data as any,
        include: { location: { select: { id: true, name: true } } },
      });
    } catch (e: any) {
      // A duplicate SKU is user error, not a server fault.
      if (e?.code === 'P2002') throw new BadRequestException(`SKU "${data.sku}" is already used by another part`);
      throw e;
    }
  }

  /** Flat array when no explicit page is requested (matches the materials route). */
  async findAll(query: PaginationDto, paginated: boolean, category?: string) {
    const where = category ? { category: category as any } : {};
    if (!paginated) {
      return this.prisma.part.findMany({
        where,
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
        include: { location: { select: { id: true, name: true } } },
      });
    }
    const [data, total] = await Promise.all([
      this.prisma.part.findMany({
        where,
        ...paginate(query),
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
        include: { location: { select: { id: true, name: true } } },
      }),
      this.prisma.part.count({ where }),
    ]);
    return paginatedResponse(data, total, query);
  }

  async findOne(id: string) {
    const part = await this.prisma.part.findUnique({
      where: { id },
      include: {
        location: { select: { id: true, name: true } },
        productParts: {
          include: { product: { select: { id: true, name: true } } },
        },
      },
    });
    if (!part) throw new NotFoundException('Part not found');
    return part;
  }

  async update(id: string, dto: UpdatePartDto) {
    await this.ensureExists(id);
    try {
      return await this.prisma.part.update({
        where: { id },
        data: {
          name: dto.name !== undefined ? requiredText(dto.name, 'Name', 120) : undefined,
          sku: dto.sku !== undefined ? dto.sku?.trim() || null : undefined,
          category: dto.category !== undefined
            ? (requiredEnum(dto.category, 'category', PART_CATEGORIES) as any)
            : undefined,
          description: dto.description !== undefined ? dto.description?.trim().slice(0, 500) || null : undefined,
          unitCost: optionalNumber(dto.unitCost, 'unitCost', LIMITS.unitCost),
          stockQty: optionalNumber(dto.stockQty, 'stockQty', LIMITS.stockQty),
          reorderPoint: optionalNumber(dto.reorderPoint, 'reorderPoint', LIMITS.reorderPoint),
          supplier: dto.supplier !== undefined ? dto.supplier?.trim().slice(0, 200) || null : undefined,
          locationId: dto.locationId !== undefined ? dto.locationId || null : undefined,
          isActive: dto.isActive,
        },
        include: { location: { select: { id: true, name: true } } },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new BadRequestException('That SKU is already used by another part');
      throw e;
    }
  }

  async remove(id: string) {
    await this.ensureExists(id);

    const [onBom, consumed] = await Promise.all([
      this.prisma.productPart.count({ where: { partId: id } }),
      // Historical consumption also pins the row via a foreign key. Checking it
      // here turns what was a raw 500 from Prisma into a clear explanation.
      this.prisma.jobPart.count({ where: { partId: id } }),
    ]);

    if (onBom > 0) {
      throw new BadRequestException(
        `This part is used by ${onBom} product${onBom === 1 ? '' : 's'} — remove it from those BOMs first, or mark it inactive.`,
      );
    }
    if (consumed > 0) {
      throw new BadRequestException(
        `This part has been consumed by ${consumed} production job${consumed === 1 ? '' : 's'}, so it is kept for cost history. ` +
        `Mark it inactive instead — it will disappear from pickers but past job costs stay accurate.`,
      );
    }

    await this.prisma.part.delete({ where: { id } });
    return { deleted: true };
  }

  /** Relative stock change (+restock / -correction). Never goes below zero. */
  async adjustStock(id: string, delta: number) {
    if (!Number.isInteger(delta) || delta === 0) {
      throw new BadRequestException('Adjustment must be a non-zero whole number');
    }
    const part = await this.ensureExists(id);
    const next = Math.max(0, part.stockQty + delta);
    return this.prisma.part.update({
      where: { id },
      data: { stockQty: next },
      include: { location: { select: { id: true, name: true } } },
    });
  }

  /** Active parts at or below their reorder point (reorderPoint 0 = not tracked). */
  getLowStock() {
    return this.prisma.$queryRaw`
      SELECT id, name, sku, category, "unitCost", "stockQty", "reorderPoint", supplier
      FROM "Part"
      WHERE "isActive" = true AND "reorderPoint" > 0 AND "stockQty" <= "reorderPoint"
      ORDER BY ("stockQty"::float / NULLIF("reorderPoint", 0)) ASC
    `;
  }

  // ---- Product BOM ----

  listForProduct(productId: string) {
    return this.prisma.productPart.findMany({
      where: { productId },
      orderBy: [{ sortOrder: 'asc' }],
      include: { part: true },
    });
  }

  /** Add a part to a product's BOM, or update its quantity if already present. */
  async setProductPart(productId: string, dto: SetProductPartDto) {
    if (!Number.isInteger(dto.quantity) || dto.quantity < 1) {
      throw new BadRequestException('Quantity must be a whole number of 1 or more');
    }
    const [product, part] = await Promise.all([
      this.prisma.product.findUnique({ where: { id: productId }, select: { id: true } }),
      this.prisma.part.findUnique({ where: { id: dto.partId }, select: { id: true } }),
    ]);
    if (!product) throw new NotFoundException('Product not found');
    if (!part) throw new NotFoundException('Part not found');

    return this.prisma.productPart.upsert({
      where: { productId_partId: { productId, partId: dto.partId } },
      create: { productId, partId: dto.partId, quantity: dto.quantity },
      update: { quantity: dto.quantity },
      include: { part: true },
    });
  }

  async removeProductPart(productId: string, partId: string) {
    const line = await this.prisma.productPart.findUnique({
      where: { productId_partId: { productId, partId } },
    });
    if (!line) throw new NotFoundException('That part is not on this product');
    await this.prisma.productPart.delete({ where: { id: line.id } });
    return { deleted: true };
  }

  private async ensureExists(id: string) {
    const part = await this.prisma.part.findUnique({ where: { id } });
    if (!part) throw new NotFoundException('Part not found');
    return part;
  }
}
