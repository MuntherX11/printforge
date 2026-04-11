import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreatePrinterDto, UpdatePrinterDto } from '@printforge/types';

// Whitelist of fields that can be set via API
const ALLOWED_CREATE_FIELDS = ['name', 'model', 'connectionType', 'moonrakerUrl', 'hourlyRate', 'wattage', 'markupMultiplier'] as const;
const ALLOWED_UPDATE_FIELDS = [...ALLOWED_CREATE_FIELDS, 'isActive', 'status'] as const;

function pickAllowed<T extends Record<string, any>>(dto: T, allowed: readonly string[]): Partial<T> {
  const result: any = {};
  for (const key of allowed) {
    if (dto[key] !== undefined) result[key] = dto[key];
  }
  return result;
}

@Injectable()
export class PrintersService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreatePrinterDto) {
    return this.prisma.printer.create({ data: pickAllowed(dto, ALLOWED_CREATE_FIELDS) as any });
  }

  async findAll() {
    return this.prisma.printer.findMany({
      include: {
        _count: { select: { productionJobs: true, maintenanceLogs: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const printer = await this.prisma.printer.findUnique({
      where: { id },
      include: {
        productionJobs: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: { id: true, name: true, status: true, startedAt: true, completedAt: true, totalCost: true },
        },
        maintenanceLogs: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        _count: { select: { productionJobs: true, maintenanceLogs: true } },
      },
    });
    if (!printer) throw new NotFoundException('Printer not found');
    return printer;
  }

  async update(id: string, dto: UpdatePrinterDto) {
    await this.findOne(id);
    return this.prisma.printer.update({ where: { id }, data: pickAllowed(dto, ALLOWED_UPDATE_FIELDS) as any });
  }

  async remove(id: string) {
    await this.findOne(id);

    return this.prisma.$transaction(async (tx) => {
      // Check for active jobs inside transaction to prevent race conditions
      const activeJobs = await tx.productionJob.count({
        where: { printerId: id, status: { in: ['QUEUED', 'IN_PROGRESS', 'PAUSED'] } },
      });
      if (activeJobs > 0) {
        throw new ConflictException(`Cannot delete printer with ${activeJobs} active job(s). Complete or cancel them first.`);
      }
      // Unlink completed jobs so they're not lost
      await tx.productionJob.updateMany({
        where: { printerId: id },
        data: { printerId: null as any },
      });
      return tx.printer.delete({ where: { id } });
    });
  }

  async updateStatus(id: string, status: string, lastSeen?: Date) {
    return this.prisma.printer.update({
      where: { id },
      data: { status: status as any, lastSeen: lastSeen || new Date() },
    });
  }
}
