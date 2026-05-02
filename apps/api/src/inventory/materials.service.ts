import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateMaterialDto, UpdateMaterialDto, BulkMaterialUploadRow, MaterialType } from '@printforge/types';

@Injectable()
export class MaterialsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateMaterialDto) {
    return this.prisma.material.create({ data: dto });
  }

  async findAll() {
    return this.prisma.material.findMany({
      include: {
        spools: { where: { isActive: true }, select: { id: true, currentWeight: true } },
        _count: { select: { spools: true } },
      },
      orderBy: { name: 'asc' },
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

  async update(id: string, dto: UpdateMaterialDto) {
    await this.findOne(id);
    return this.prisma.material.update({ where: { id }, data: dto });
  }

  async bulkImport(rows: BulkMaterialUploadRow[]) {
    const results = { created: 0, skipped: 0, errors: [] as string[] };
    const validTypes = ['PLA', 'PETG', 'ABS', 'TPU', 'ASA', 'NYLON', 'RESIN', 'OTHER'];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // +2 for header row + 0-index
      if (!row.name || !row.type || !row.costPerGram) {
        results.errors.push(`Row ${rowNum}: missing required fields (name, type, costPerGram)`);
        results.skipped++;
        continue;
      }
      const type = row.type.toUpperCase();
      if (!validTypes.includes(type)) {
        results.errors.push(`Row ${rowNum}: invalid type "${row.type}"`);
        results.skipped++;
        continue;
      }
      try {
        await this.prisma.material.create({
          data: {
            name: row.name,
            type: type as MaterialType,
            color: row.color || null,
            brand: row.brand || null,
            costPerGram: Number(row.costPerGram),
            density: row.density ? Number(row.density) : 1.24,
            reorderPoint: row.reorderPoint ? Number(row.reorderPoint) : 500,
          },
        });
        results.created++;
      } catch (err: unknown) {
        results.errors.push(`Row ${rowNum}: ${(err as Error).message}`);
        results.skipped++;
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
