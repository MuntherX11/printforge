import { Injectable, NotFoundException, BadRequestException, ConflictException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisCacheService } from '../common/redis/redis-cache.service';
import { colourKeyHasMaterial } from '../stock-ledger/colour-key';
import {
  CreateMaterialDto, UpdateMaterialDto, BulkMaterialUploadRow, MaterialType, FilamentStockRow, FilamentStockSpool,
  FilamentIdentity, filamentIdentityKey, filamentIdentityLabel,
} from '@printforge/types';
import { PaginationDto, paginatedResponse } from '../common/dto/pagination.dto';
import { optionalNumber, requiredNumber, requiredText, requiredEnum } from '../common/utils/validate-number';
import { stockStatus } from './stock-status';
import {
  MATERIAL_TX, duplicateMaterialConflict, findDuplicateMaterial, isMaterialBusy, lockMaterialIdentity,
} from './material-identity';

const MATERIAL_TYPES = ['PLA', 'PETG', 'ABS', 'TPU', 'ASA', 'NYLON', 'RESIN', 'OTHER'] as const;

/** The columns that make a filament's identity (filamentIdentityKey). */
const IDENTITY_FIELDS = ['type', 'brand', 'color'] as const;

/** A spreadsheet cell as identity text: String(…) for the key only, blank → null. */
const cellText = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

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
  constructor(private prisma: PrismaService, @Optional() private cache?: RedisCacheService) {}

  /** A filament write clears the 60 s dashboard KPI cache, so its Low Stock tile matches this list. */
  private stockChanged<T>(result: T): T {
    this.cache?.invalidate('dashboard:kpis').catch(() => {});
    return result;
  }

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
    if (dto.colorHex !== undefined) {
      // Stored bare and uppercase so comparisons never hinge on "#" or case.
      const raw = (dto.colorHex ?? '').toString().trim().replace(/^#/, '');
      if (raw === '') {
        out.colorHex = null;
      } else if (/^[0-9a-fA-F]{6}$/.test(raw)) {
        out.colorHex = raw.toUpperCase();
      } else {
        throw new BadRequestException('colorHex must be six hex digits, e.g. 91202B');
      }
    }

    const spoolPrice = optionalNumber(dto.spoolPrice, 'spoolPrice', LIMITS.spoolPrice);
    const spoolWeightGrams = optionalNumber(dto.spoolWeightGrams, 'spoolWeightGrams', LIMITS.spoolWeightGrams);
    const costPerGram = optionalNumber(dto.costPerGram, 'costPerGram', LIMITS.costPerGram);
    const density = optionalNumber(dto.density, 'density', LIMITS.density);
    const reorderPoint = optionalNumber(dto.reorderPoint, 'reorderPoint', LIMITS.reorderPoint);
    if (density !== undefined) out.density = density;
    if (reorderPoint !== undefined) out.reorderPoint = reorderPoint;

    return { fields: out, spoolPrice, spoolWeightGrams, costPerGram };
  }

  /**
   * A filament with a colour is created under the identity lock and refused
   * with 409 MATERIAL_DUPLICATE when the same brand + type + colour exists
   * (safety spec §3). A colourless one has no identity and is created as before.
   */
  async create(dto: CreateMaterialDto) {
    const { fields, spoolPrice, spoolWeightGrams, costPerGram } = this.validateFields(dto);
    const data = {
      ...fields,
      spoolPrice: spoolPrice ?? null,
      spoolWeightGrams: spoolWeightGrams ?? null,
      costPerGram: resolveCostPerGram(spoolPrice, spoolWeightGrams, costPerGram),
    };
    const identity: FilamentIdentity = { type: fields.type, brand: fields.brand ?? null, color: fields.color ?? null };
    if (filamentIdentityKey(identity) === null) return this.stockChanged(await this.prisma.material.create({ data }));
    return this.stockChanged(await this.prisma.$transaction(async (tx) => {
      await lockMaterialIdentity(tx);
      const dup = await findDuplicateMaterial(tx, identity);
      if (dup) throw duplicateMaterialConflict(dup, identity, 'create');
      return tx.material.create({ data });
    }, MATERIAL_TX));
  }

  /**
   * @param paginate  false when the caller sent no ?page= — returns a flat array.
   * @param limitSent false when the caller sent no ?limit=. PaginationDto's
   *   class default (20) is filled in by the transform either way, so without
   *   this flag the flat-mode 500 default was never reached and Quick Quote and
   *   Watch Folder saw only the first 20 filaments.
   */
  async findAll(pagination: PaginationDto, paginate = true, limitSent = true) {
    const materialInclude = {
      spools: { where: { isActive: true }, select: { id: true, currentWeight: true } },
      _count: { select: { spools: true } },
    };

    // When no ?page= param was sent (e.g. dropdown loaders requesting all materials),
    // return a plain array so callers can use .map() without unwrapping.
    if (!paginate) {
      const limit = Math.min(limitSent ? (pagination.limit ?? 500) : 500, 1000);
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

  /**
   * Every filament with its stock, for the Filaments list (GET /materials/stock).
   * Exactly two queries whatever the number of filaments (no N+1). Totals and
   * the status count ACTIVE spools only; `spools` lists inactive ones too, so
   * an old label's PF-ID still finds its filament. No row cap: a farm holds
   * 60–225 filaments; past ~1000, move the search server-side instead.
   */
  async stockOverview(): Promise<FilamentStockRow[]> {
    const [materials, spools] = await Promise.all([
      this.prisma.material.findMany({
        select: {
          id: true, name: true, type: true, color: true, colorHex: true, brand: true, costPerGram: true,
          spoolPrice: true, spoolWeightGrams: true, reorderPoint: true, createdAt: true,
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.spool.findMany({
        select: {
          id: true, materialId: true, printforgeId: true, currentWeight: true, isActive: true, createdAt: true,
          location: { select: { name: true } },
        },
        orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
      }),
    ]);

    // Spools arrive already ordered (active first, newest first); grouping keeps that order.
    const byMaterial = new Map<string, FilamentStockSpool[]>();
    for (const s of spools) {
      const own = byMaterial.get(s.materialId) ?? [];
      own.push({
        id: s.id,
        printforgeId: s.printforgeId,
        currentWeight: s.currentWeight,
        isActive: s.isActive,
        locationName: s.location?.name ?? null,
      });
      byMaterial.set(s.materialId, own);
    }

    return materials.map((m) => {
      const own = byMaterial.get(m.id) ?? [];
      let totalStock = 0;
      let activeSpools = 0;
      for (const s of own) {
        if (!s.isActive) continue;
        totalStock += s.currentWeight;
        activeSpools++;
      }
      return {
        id: m.id,
        name: m.name,
        type: m.type as MaterialType,
        color: m.color,
        colorHex: m.colorHex,
        brand: m.brand,
        costPerGram: m.costPerGram,
        spoolPrice: m.spoolPrice,
        spoolWeightGrams: m.spoolWeightGrams,
        reorderPoint: m.reorderPoint,
        createdAt: m.createdAt.toISOString(),
        totalStock,
        activeSpools,
        stockStatus: stockStatus(totalStock, m.reorderPoint),
        spools: own,
      };
    });
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

  /**
   * The identity lock is taken only when the stored brand + type + colour key
   * actually changes (safety spec §3). Identity fields equal to the stored
   * value are dropped, so a price-only save that resends them writes no
   * identity column, and a legacy duplicate row stays editable.
   */
  async update(id: string, dto: UpdateMaterialDto) {
    const current = await this.findOne(id);
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

    for (const k of IDENTITY_FIELDS) {
      if (k in updateData && updateData[k] === current[k]) delete updateData[k];
    }
    const next: FilamentIdentity = {
      type: 'type' in updateData ? updateData.type : current.type,
      brand: 'brand' in updateData ? updateData.brand : current.brand,
      color: 'color' in updateData ? updateData.color : current.color,
    };
    const nextKey = filamentIdentityKey(next);
    if (nextKey === null || nextKey === filamentIdentityKey(current)) {
      return this.stockChanged(await this.prisma.material.update({ where: { id }, data: updateData }));
    }
    return this.stockChanged(await this.prisma.$transaction(async (tx) => {
      await lockMaterialIdentity(tx);
      const dup = await findDuplicateMaterial(tx, next, id);
      if (dup) throw duplicateMaterialConflict(dup, next, 'update');
      return tx.material.update({ where: { id }, data: updateData });
    }, MATERIAL_TX));
  }

  async bulkImport(rows: BulkMaterialUploadRow[]) {
    const results = { created: 0, skipped: 0, errors: [] as string[] };
    const validTypes = ['PLA', 'PETG', 'ABS', 'TPU', 'ASA', 'NYLON', 'RESIN', 'OTHER'];

    const validRows: Array<{
      rowNum: number;
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
        rowNum,
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
        // Row messages are collected inside the transaction and merged only
        // after it commits, so a rolled-back pass leaves no stray lines.
        const pass = await this.prisma.$transaction(async (tx) => {
          await lockMaterialIdentity(tx);
          const out = { created: 0, skipped: 0, errors: [] as string[] };
          // Material.name carries no unique constraint, so `skipDuplicates` had
          // nothing to key on — re-uploading the same sheet silently created a
          // second copy of every material (verified live). Dedupe explicitly,
          // both within the sheet and against what is already stored.
          const existing = await tx.material.findMany({
            select: { id: true, name: true, type: true, brand: true, color: true, createdAt: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          });
          const seen = new Set(existing.map((m) => `${m.name.trim().toLowerCase()}|${m.type}`));
          // Safety spec §3: brand + type + colour → the oldest stored row with it.
          const stored = new Map<string, { name: string }>();
          for (const m of existing) {
            const key = filamentIdentityKey(m);
            if (key !== null && !stored.has(key)) stored.set(key, m);
          }
          /** identity key → the sheet row that is being created with it */
          const sheet = new Map<string, number>();

          const toInsert: Array<Omit<(typeof validRows)[number], 'rowNum'>> = [];
          for (const { rowNum, ...row } of validRows) {
            const key = `${row.name.trim().toLowerCase()}|${row.type}`;
            if (seen.has(key)) {
              out.errors.push(`"${row.name}" (${row.type}) already exists — skipped`);
              out.skipped++;
              continue;
            }
            const identity: FilamentIdentity = { type: row.type, brand: cellText(row.brand), color: cellText(row.color) };
            const identityKey = filamentIdentityKey(identity);
            if (identityKey !== null) {
              const hit = stored.get(identityKey);
              const earlier = sheet.get(identityKey);
              if (hit || earlier !== undefined) {
                const why = hit ? `already exists as "${hit.name}"` : `repeats row ${earlier}`;
                out.errors.push(`Row ${rowNum}: ${filamentIdentityLabel(identity)} ${why} — skipped`);
                out.skipped++;
                continue;
              }
              sheet.set(identityKey, rowNum);
            }
            seen.add(key);
            toInsert.push(row);
          }

          if (toInsert.length > 0) {
            const inserted = await tx.material.createMany({ data: toInsert });
            out.created = inserted.count;
            out.skipped += toInsert.length - inserted.count;
          }
          return out;
        }, MATERIAL_TX);
        results.created = pass.created;
        results.skipped += pass.skipped;
        results.errors.push(...pass.errors);
      } catch (err: unknown) {
        // A busy identity lock is a 409 'try again in a few seconds', not a failed insert.
        if (isMaterialBusy(err)) throw err;
        results.errors.push(`Bulk insert failed: ${(err as Error).message}`);
        results.skipped += validRows.length;
      }
    }

    return results.created > 0 ? this.stockChanged(results) : results;
  }

  /**
   * Delete a filament only when nothing uses it (spec §3.3 "Deleting a
   * filament"). One transaction: lock the row, count every reference, and 409
   * with the counts when any exist. It never deletes components, job lines,
   * spools or colour assignments — the old cascade destroyed them before a
   * foreign key failed.
   */
  async remove(id: string) {
    return this.prisma.$transaction(async (tx: any) => {
      const rows = (await tx.$queryRaw(
        Prisma.sql`/* lock:Material:UPDATE */ SELECT "id", "name" FROM "Material" WHERE "id" = ANY(${[id]}::text[]) FOR UPDATE`,
      )) as Array<{ id: string; name: string }>;
      const locked = rows[0];
      if (!locked) throw new NotFoundException('Material not found');
      const [components, componentSlots, colours, jobLines, spools, stockRows] = await Promise.all([
        tx.productComponent.count({ where: { materialId: id } }),
        tx.componentMaterial.count({ where: { materialId: id } }),
        tx.colourOptionSlot.count({ where: { materialId: id } }),
        tx.jobMaterial.count({ where: { OR: [{ materialId: id }, { slicedMaterialId: id }, { plannedMaterialId: id }, { plannedSlicedMaterialId: id }] } }),
        tx.spool.count({ where: { materialId: id } }),
        tx.componentColourStock.findMany({ where: { stockOnHand: { gt: 0 }, colourKey: { contains: `:${id}` } }, select: { colourKey: true } }),
      ]);
      const stocked = (stockRows as Array<{ colourKey: string }>).filter((r) => colourKeyHasMaterial(r.colourKey, id)).length;
      const parts = components + componentSlots + stocked;
      if (parts + colours + jobLines + spools > 0) {
        throw new ConflictException(
          `"${locked.name}" is used by ${parts} parts, ${colours} colours, ${jobLines} job lines and ${spools} spools — remove it from those first`,
        );
      }
      await tx.material.delete({ where: { id } });
      return { deleted: true };
    }, { timeout: 30_000, maxWait: 10_000 }).then((out: { deleted: boolean }) => this.stockChanged(out));
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
