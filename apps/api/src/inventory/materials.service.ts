import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateMaterialDto, UpdateMaterialDto, BulkMaterialUploadRow, MaterialType } from '@printforge/types';
import { PaginationDto, paginatedResponse } from '../common/dto/pagination.dto';

/** Derive costPerGram from spool-level pricing fields when they are supplied. */
function resolveCostPerGram(
  spoolPrice?: number | null,
  spoolWeightGrams?: number | null,
  fallbackCostPerGram?: number | null,
): number {
  if (spoolPrice != null && spoolPrice > 0) {
    const weight = (spoolWeightGrams != null && spoolWeightGrams > 0) ? spoolWeightGrams : 1000;
    return spoolPrice / weight;
  }
  return fallbackCostPerGram ?? 0;
}

@Injectable()
export class MaterialsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateMaterialDto) {
    const { spoolPrice, spoolWeightGrams, costPerGram: rawCpg, ...rest } = dto as any;
    const costPerGram = resolveCostPerGram(spoolPrice, spoolWeightGrams, rawCpg);
    return this.prisma.material.create({
      data: { ...rest, spoolPrice: spoolPrice ?? null, spoolWeightGrams: spoolWeightGrams ?? null, costPerGram },
    });
  }

  async findAll(pagination: PaginationDto, paginate = true) {
    const materialInclude = {
      spools: { where: { isActive: true }, select: { id: true, currentWeight: true } },
      _count: { select: { spools: true } },
    };

    // When no ?page= param was sent (e.g. dropdown loaders requesting all materials),
    // return a plain array so callers can use .map() without unwrapping.
    if (!paginate) {
      const limit = Math.min(pagination.limit ?? 500, 1000);
      return this.prisma.material.findMany({
        include: materialInclude,
        orderBy: { name: 'asc' },
        take: limit,
      });
    }

    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;
    const [data, total] = await Promise.all([
      this.prisma.material.findMany({
        include: materialInclude,
        orderBy: { name: 'asc' },
        take: limit,
        skip: (page - 1) * limit,
      }),
      this.prisma.material.count(),
    ]);
    return paginatedResponse(data, total, pagination);
  }

  async findOne(id: string) {
    const material = await this.prisma.material.findUnique({
      where: { id },
      include: {
        spools: { orderBy: { createdAt: 'desc' }, include: { location: true } },
        _count: { select: { spools: true, jobMaterials: true } },
      },
    });
    if (!material) throw new NotFoundException('Material not found');
    return material;
  }

  async update(id: string, dto: UpdateMaterialDto) {
    await this.findOne(id);
    const { spoolPrice, spoolWeightGrams, costPerGram: rawCpg, ...rest } = dto as any;

    // Re-derive costPerGram whenever spool pricing fields are changed.
    // If the caller doesn't send spoolPrice at all, fall back to the explicit costPerGram.
    const updateData: any = { ...rest };
    if (spoolPrice !== undefined || spoolWeightGrams !== undefined) {
      updateData.spoolPrice = spoolPrice ?? null;
      updateData.spoolWeightGrams = spoolWeightGrams ?? null;
      // Fetch current record to use existing spoolWeightGrams as default
      const existing = await this.prisma.material.findUnique({ where: { id } });
      const effectiveWeight = spoolWeightGrams ?? existing?.spoolWeightGrams ?? 1000;
      const effectivePrice = spoolPrice ?? existing?.spoolPrice;
      updateData.costPerGram = resolveCostPerGram(effectivePrice, effectiveWeight, rawCpg ?? existing?.costPerGram);
    } else if (rawCpg !== undefined) {
      updateData.costPerGram = rawCpg;
    }

    return this.prisma.material.update({ where: { id }, data: updateData });
  }

  async bulkImport(rows: BulkMaterialUploadRow[]) {
    const results = { created: 0, skipped: 0, errors: [] as string[] };
    const validTypes = ['PLA', 'PETG', 'ABS', 'TPU', 'ASA', 'NYLON', 'RESIN', 'OTHER'];

    const validRows: Array<{
      name: string;
      type: MaterialType;
      color: string | null;
      brand: string | null;
      costPerGram: number;
      spoolPrice: number | null;
      spoolWeightGrams: number | null;
      density: number;
      reorderPoint: number;
    }> = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // +2 for header row + 0-index
      const hasSpoolPricing = row.spoolPrice != null && Number(row.spoolPrice) > 0;
      if (!row.name || !row.type || (!hasSpoolPricing && !row.costPerGram)) {
        results.errors.push(`Row ${rowNum}: missing required fields (name, type, and either spoolPrice or costPerGram)`);
        results.skipped++;
        continue;
      }
      const type = row.type.toUpperCase();
      if (!validTypes.includes(type)) {
        results.errors.push(`Row ${rowNum}: invalid type "${row.type}"`);
        results.skipped++;
        continue;
      }
      const spoolPrice = hasSpoolPricing ? Number(row.spoolPrice) : null;
      const spoolWeightGrams = row.spoolWeightGrams ? Number(row.spoolWeightGrams) : (hasSpoolPricing ? 1000 : null);
      validRows.push({
        name: row.name,
        type: type as MaterialType,
        color: row.color || null,
        brand: row.brand || null,
        costPerGram: resolveCostPerGram(spoolPrice, spoolWeightGrams, row.costPerGram ? Number(row.costPerGram) : null),
        spoolPrice,
        spoolWeightGrams,
        density: row.density ? Number(row.density) : 1.24,
        reorderPoint: row.reorderPoint ? Number(row.reorderPoint) : 500,
      });
    }

    if (validRows.length > 0) {
      try {
        const inserted = await this.prisma.material.createMany({
          data: validRows,
          skipDuplicates: true,
        });
        results.created = inserted.count;
        // Rows silently skipped by skipDuplicates count as skipped
        results.skipped += validRows.length - inserted.count;
      } catch (err: unknown) {
        results.errors.push(`Bulk insert failed: ${(err as Error).message}`);
        results.skipped += validRows.length;
      }
    }

    return results;
  }

  async remove(id: string) {
    const material = await this.prisma.material.findUnique({ where: { id } });
    if (!material) throw new NotFoundException('Material not found');
    // Cascade: clear references then delete
    await this.prisma.jobMaterial.deleteMany({ where: { materialId: id } });
    await this.prisma.productComponent.deleteMany({ where: { materialId: id } });
    await this.prisma.spool.deleteMany({ where: { materialId: id } });
    await this.prisma.material.delete({ where: { id } });
    return { deleted: true };
  }

  async getLowStock() {
    const materials = await this.prisma.material.findMany({
      include: { spools: { where: { isActive: true } } },
    });

    return materials.filter(m => {
      const totalWeight = m.spools.reduce((sum, s) => sum + s.currentWeight, 0);
      return totalWeight < m.reorderPoint;
    }).map(m => ({
      ...m,
      totalStock: m.spools.reduce((sum, s) => sum + s.currentWeight, 0),
    }));
  }
}
