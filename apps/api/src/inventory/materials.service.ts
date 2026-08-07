import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateMaterialDto, UpdateMaterialDto, BulkMaterialUploadRow, MaterialType } from '@printforge/types';
import { PaginationDto, paginatedResponse } from '../common/dto/pagination.dto';
import { optionalNumber, requiredNumber, requiredText, requiredEnum } from '../common/utils/validate-number';

const MATERIAL_TYPES = ['PLA', 'PETG', 'ABS', 'TPU', 'ASA', 'NYLON', 'RESIN', 'OTHER'] as const;

/** Bounds for filament pricing/stock figures. */
const LIMITS = {
  costPerGram: { min: 0, max: 1000 },
  spoolPrice: { min: 0, max: 100_000 },
  // A spool must have real weight — 0 previously fell back to 1000 g silently,
  // quietly producing the wrong cost per gram.
  spoolWeightGrams: { min: 1, max: 100_000 },
  density: { min: 0.1, max: 30 },
  reorderPoint: { min: 0, max: 10_000_000 },
};

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

  /**
   * Validate the numeric/text fields shared by create and update.
   * Every value is bounded — a mistyped "-5" or "1e12" during inventory entry
   * must fail loudly rather than land in the database and skew product costing.
   */
  private validateFields(dto: any, { partial = false } = {}) {
    const out: any = {};
    if (!partial || dto.name !== undefined) out.name = requiredText(dto.name, 'Name', 120);
    if (!partial || dto.type !== undefined) out.type = requiredEnum(dto.type, 'type', MATERIAL_TYPES);
    if (dto.color !== undefined) out.color = dto.color?.trim().slice(0, 60) || null;
    if (dto.brand !== undefined) out.brand = dto.brand?.trim().slice(0, 100) || null;

    const spoolPrice = optionalNumber(dto.spoolPrice, 'spoolPrice', LIMITS.spoolPrice);
    const spoolWeightGrams = optionalNumber(dto.spoolWeightGrams, 'spoolWeightGrams', LIMITS.spoolWeightGrams);
    const costPerGram = optionalNumber(dto.costPerGram, 'costPerGram', LIMITS.costPerGram);
    const density = optionalNumber(dto.density, 'density', LIMITS.density);
    const reorderPoint = optionalNumber(dto.reorderPoint, 'reorderPoint', LIMITS.reorderPoint);
    if (density !== undefined) out.density = density;
    if (reorderPoint !== undefined) out.reorderPoint = reorderPoint;

    return { fields: out, spoolPrice, spoolWeightGrams, costPerGram };
  }

  async create(dto: CreateMaterialDto) {
    const { fields, spoolPrice, spoolWeightGrams, costPerGram } = this.validateFields(dto);
    return this.prisma.material.create({
      data: {
        ...fields,
        spoolPrice: spoolPrice ?? null,
        spoolWeightGrams: spoolWeightGrams ?? null,
        costPerGram: resolveCostPerGram(spoolPrice, spoolWeightGrams, costPerGram),
      },
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
    const v = this.validateFields(dto, { partial: true });
    const spoolPrice = v.spoolPrice;
    const spoolWeightGrams = v.spoolWeightGrams;
    const rawCpg = v.costPerGram;

    // Re-derive costPerGram whenever spool pricing fields are changed.
    // If the caller doesn't send spoolPrice at all, fall back to the explicit costPerGram.
    const updateData: any = { ...v.fields };
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
      // Bound every numeric cell — a stray "-8" or "1e12" in a spreadsheet must
      // fail its row, not poison costing for that filament.
      let spoolPrice: number | null, spoolWeightGrams: number | null, costPerGram: number, density: number, reorderPoint: number;
      try {
        spoolPrice = hasSpoolPricing
          ? requiredNumber(row.spoolPrice, 'spoolPrice', LIMITS.spoolPrice) : null;
        spoolWeightGrams = row.spoolWeightGrams
          ? requiredNumber(row.spoolWeightGrams, 'spoolWeightGrams', LIMITS.spoolWeightGrams)
          : (hasSpoolPricing ? 1000 : null);
        const explicitCpg = row.costPerGram
          ? requiredNumber(row.costPerGram, 'costPerGram', LIMITS.costPerGram) : null;
        costPerGram = resolveCostPerGram(spoolPrice, spoolWeightGrams, explicitCpg);
        density = row.density ? requiredNumber(row.density, 'density', LIMITS.density) : 1.24;
        reorderPoint = row.reorderPoint ? requiredNumber(row.reorderPoint, 'reorderPoint', LIMITS.reorderPoint) : 500;
      } catch (e: any) {
        results.errors.push(`Row ${rowNum}: ${e?.response?.message ?? e.message}`);
        results.skipped++;
        continue;
      }

      validRows.push({
        name: String(row.name).trim().slice(0, 120),
        type: type as MaterialType,
        color: row.color || null,
        brand: row.brand || null,
        costPerGram,
        spoolPrice,
        spoolWeightGrams,
        density,
        reorderPoint,
      });
    }

    if (validRows.length > 0) {
      try {
        // Material.name carries no unique constraint, so `skipDuplicates` had
        // nothing to key on — re-uploading the same sheet silently created a
        // second copy of every material (verified live). Dedupe explicitly,
        // both within the sheet and against what is already stored.
        const existing = await this.prisma.material.findMany({ select: { name: true, type: true } });
        const seen = new Set(existing.map((m) => `${m.name.trim().toLowerCase()}|${m.type}`));

        const toInsert: typeof validRows = [];
        for (const row of validRows) {
          const key = `${row.name.trim().toLowerCase()}|${row.type}`;
          if (seen.has(key)) {
            results.errors.push(`"${row.name}" (${row.type}) already exists — skipped`);
            results.skipped++;
            continue;
          }
          seen.add(key);
          toInsert.push(row);
        }

        if (toInsert.length > 0) {
          const inserted = await this.prisma.material.createMany({ data: toInsert });
          results.created = inserted.count;
          results.skipped += toInsert.length - inserted.count;
        }
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
