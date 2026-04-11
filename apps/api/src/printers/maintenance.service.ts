import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateMaintenanceLogDto, CompleteMaintenanceDto } from '@printforge/types';

@Injectable()
export class MaintenanceService {
  constructor(private prisma: PrismaService) {}

  async startMaintenance(printerId: string, dto: CreateMaintenanceLogDto) {
    const printer = await this.prisma.printer.findUnique({ where: { id: printerId } });
    if (!printer) throw new NotFoundException('Printer not found');

    // Check no active jobs on this printer
    const activeJobs = await this.prisma.productionJob.count({
      where: { printerId, status: { in: ['IN_PROGRESS'] } },
    });
    if (activeJobs > 0) {
      throw new BadRequestException('Cannot start maintenance while printer has active jobs. Pause or complete them first.');
    }

    // Create maintenance log
    const log = await this.prisma.maintenanceLog.create({
      data: {
        printerId,
        type: dto.type as any,
        description: dto.description,
        scheduledDate: dto.scheduledDate ? new Date(dto.scheduledDate) : null,
        cost: dto.cost,
        notes: dto.notes,
      },
    });

    // Set printer status to MAINTENANCE
    await this.prisma.printer.update({
      where: { id: printerId },
      data: { status: 'MAINTENANCE' },
    });

    return log;
  }

  async completeMaintenance(printerId: string, logId: string, dto: CompleteMaintenanceDto) {
    const log = await this.prisma.maintenanceLog.findUnique({ where: { id: logId } });
    if (!log) throw new NotFoundException('Maintenance log not found');
    if (log.printerId !== printerId) throw new BadRequestException('Log does not belong to this printer');
    if (log.completedDate) throw new BadRequestException('Maintenance already completed');

    const updated = await this.prisma.maintenanceLog.update({
      where: { id: logId },
      data: {
        completedDate: new Date(),
        downtimeMinutes: dto.downtimeMinutes,
        cost: dto.cost ?? log.cost,
        notes: dto.notes ?? log.notes,
      },
    });

    // Calculate next maintenance due based on interval
    const printer = await this.prisma.printer.findUnique({ where: { id: printerId } });
    const nextDue = printer?.maintenanceIntervalHours
      ? new Date(Date.now() + printer.maintenanceIntervalHours * 3600 * 1000)
      : null;

    // Restore printer to IDLE
    await this.prisma.printer.update({
      where: { id: printerId },
      data: {
        status: 'IDLE',
        nextMaintenanceDue: nextDue,
      },
    });

    return updated;
  }

  async getHistory(printerId: string) {
    const printer = await this.prisma.printer.findUnique({ where: { id: printerId } });
    if (!printer) throw new NotFoundException('Printer not found');

    return this.prisma.maintenanceLog.findMany({
      where: { printerId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async updateMaintenanceSettings(printerId: string, intervalHours: number | null) {
    const printer = await this.prisma.printer.findUnique({ where: { id: printerId } });
    if (!printer) throw new NotFoundException('Printer not found');

    const nextDue = intervalHours
      ? new Date(Date.now() + intervalHours * 3600 * 1000)
      : null;

    return this.prisma.printer.update({
      where: { id: printerId },
      data: {
        maintenanceIntervalHours: intervalHours,
        nextMaintenanceDue: nextDue,
      },
    });
  }

  /**
   * Check all printers for overdue maintenance and return the list.
   */
  async getOverduePrinters() {
    return this.prisma.printer.findMany({
      where: {
        isActive: true,
        nextMaintenanceDue: { lte: new Date() },
        status: { not: 'MAINTENANCE' },
      },
      select: {
        id: true,
        name: true,
        totalPrintHours: true,
        maintenanceIntervalHours: true,
        nextMaintenanceDue: true,
      },
    });
  }
}
