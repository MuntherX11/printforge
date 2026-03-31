import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CostingService } from '../costing/costing.service';
import { CreateProductionJobDto, UpdateProductionJobDto } from '@printforge/types';
import { PaginationDto, paginate, paginatedResponse } from '../common/dto/pagination.dto';

@Injectable()
export class JobsService {
  constructor(
    private prisma: PrismaService,
    private costingService: CostingService,
  ) {}

  async create(dto: CreateProductionJobDto) {
    return this.prisma.productionJob.create({
      data: {
        name: dto.name,
        printerId: dto.printerId,
        assignedToId: dto.assignedToId,
        orderId: dto.orderId,
        orderItemId: dto.orderItemId,
        gcodeFilename: dto.gcodeFilename,
        colorChanges: dto.colorChanges || 0,
      },
      include: { printer: true, assignedTo: { select: { id: true, name: true } } },
    });
  }

  async findAll(query: PaginationDto, status?: string) {
    const where = status ? { status: status as any } : {};
    const [data, total] = await Promise.all([
      this.prisma.productionJob.findMany({
        where,
        ...paginate(query),
        include: {
          printer: { select: { id: true, name: true } },
          assignedTo: { select: { id: true, name: true } },
          order: { select: { id: true, orderNumber: true } },
        },
      }),
      this.prisma.productionJob.count({ where }),
    ]);
    return paginatedResponse(data, total, query);
  }

  async findOne(id: string) {
    const job = await this.prisma.productionJob.findUnique({
      where: { id },
      include: {
        printer: true,
        assignedTo: { select: { id: true, name: true, email: true } },
        order: { select: { id: true, orderNumber: true, customer: { select: { id: true, name: true } } } },
        orderItem: true,
        materials: { include: { material: true, spool: true } },
        attachments: true,
      },
    });
    if (!job) throw new NotFoundException('Production job not found');
    return job;
  }

  async update(id: string, dto: UpdateProductionJobDto) {
    const job = await this.findOne(id);

    const data: any = { ...dto };

    // Set timestamps based on status changes
    if (dto.status === 'IN_PROGRESS' && job.status !== 'IN_PROGRESS') {
      data.startedAt = new Date();
    }
    if (dto.status === 'COMPLETED' && job.status !== 'COMPLETED') {
      data.completedAt = new Date();
    }

    const updated = await this.prisma.productionJob.update({
      where: { id },
      data,
      include: {
        printer: true,
        materials: { include: { material: true } },
      },
    });

    return updated;
  }

  async calculateCost(id: string) {
    const job = await this.prisma.productionJob.findUnique({
      where: { id },
      include: { printer: true, materials: { include: { material: true } } },
    });
    if (!job) throw new NotFoundException('Production job not found');

    const breakdown = await this.costingService.calculateJobCost(job);

    return this.prisma.productionJob.update({
      where: { id },
      data: {
        materialCost: breakdown.materialCost,
        machineCost: breakdown.machineCost,
        wasteCost: breakdown.wasteCost,
        overheadCost: breakdown.overheadCost,
        totalCost: breakdown.totalCost,
      },
    });
  }
}
