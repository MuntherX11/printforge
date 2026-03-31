import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreatePrinterDto, UpdatePrinterDto } from '@printforge/types';

@Injectable()
export class PrintersService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreatePrinterDto) {
    return this.prisma.printer.create({ data: dto as any });
  }

  async findAll() {
    return this.prisma.printer.findMany({
      include: {
        _count: { select: { productionJobs: true } },
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
        _count: { select: { productionJobs: true } },
      },
    });
    if (!printer) throw new NotFoundException('Printer not found');
    return printer;
  }

  async update(id: string, dto: UpdatePrinterDto) {
    await this.findOne(id);
    return this.prisma.printer.update({ where: { id }, data: dto as any });
  }

  async remove(id: string) {
    await this.findOne(id);
    // Check for active jobs before deleting
    const activeJobs = await this.prisma.productionJob.count({
      where: { printerId: id, status: { in: ['QUEUED', 'IN_PROGRESS', 'PAUSED'] } },
    });
    if (activeJobs > 0) {
      throw new NotFoundException(`Cannot delete printer with ${activeJobs} active job(s). Complete or cancel them first.`);
    }
    // Unlink completed jobs so they're not lost
    await this.prisma.productionJob.updateMany({
      where: { printerId: id },
      data: { printerId: null as any },
    });
    return this.prisma.printer.delete({ where: { id } });
  }

  async updateStatus(id: string, status: string, lastSeen?: Date) {
    return this.prisma.printer.update({
      where: { id },
      data: { status: status as any, lastSeen: lastSeen || new Date() },
    });
  }
}
