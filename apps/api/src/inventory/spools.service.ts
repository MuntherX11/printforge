import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateSpoolDto, UpdateSpoolDto, AdjustSpoolWeightDto } from '@printforge/types';

@Injectable()
export class SpoolsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateSpoolDto) {
    // Verify material exists
    const material = await this.prisma.material.findUnique({ where: { id: dto.materialId } });
    if (!material) throw new NotFoundException('Material not found');

    return this.prisma.spool.create({
      data: {
        materialId: dto.materialId,
        initialWeight: dto.initialWeight,
        currentWeight: dto.initialWeight,
        spoolWeight: dto.spoolWeight ?? 200,
        lotNumber: dto.lotNumber,
        purchasePrice: dto.purchasePrice,
        purchaseDate: dto.purchaseDate ? new Date(dto.purchaseDate) : undefined,
        locationId: dto.locationId || undefined,
      },
      include: { material: true, location: true },
    });
  }

  async findAll(materialId?: string) {
    return this.prisma.spool.findMany({
      where: materialId ? { materialId } : undefined,
      include: { material: true, location: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const spool = await this.prisma.spool.findUnique({
      where: { id },
      include: {
        material: true,
        location: true,
        jobMaterials: {
          include: { job: { select: { id: true, name: true, status: true } } },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });
    if (!spool) throw new NotFoundException('Spool not found');
    return spool;
  }

  async update(id: string, dto: UpdateSpoolDto) {
    await this.findOne(id);
    return this.prisma.spool.update({
      where: { id },
      data: dto,
      include: { material: true },
    });
  }

  async adjustWeight(id: string, dto: AdjustSpoolWeightDto) {
    const spool = await this.findOne(id);
    const newWeight = spool.currentWeight + dto.adjustment;

    if (newWeight < 0) throw new BadRequestException('Weight cannot be negative');

    return this.prisma.spool.update({
      where: { id },
      data: { currentWeight: newWeight },
      include: { material: true },
    });
  }

  async deductWeight(id: string, grams: number) {
    const spool = await this.prisma.spool.findUnique({ where: { id } });
    if (!spool) throw new NotFoundException('Spool not found');

    const newWeight = Math.max(0, spool.currentWeight - grams);
    return this.prisma.spool.update({
      where: { id },
      data: { currentWeight: newWeight },
    });
  }
}
