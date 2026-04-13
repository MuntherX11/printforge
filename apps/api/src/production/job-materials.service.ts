import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { AddJobMaterialDto } from '@printforge/types';

@Injectable()
export class JobMaterialsService {
  constructor(private prisma: PrismaService) {}

  async addMaterial(jobId: string, dto: AddJobMaterialDto) {
    const job = await this.prisma.productionJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');

    const material = await this.prisma.material.findUnique({ where: { id: dto.materialId } });
    if (!material) throw new NotFoundException('Material not found');

    // Validate spool belongs to this material and is active (avoids FK error + catches stale IDs)
    if (dto.spoolId) {
      const spool = await this.prisma.spool.findUnique({ where: { id: dto.spoolId } });
      if (!spool) throw new NotFoundException('Spool not found');
      if (!spool.isActive) throw new BadRequestException('Spool is inactive and cannot be assigned');
      if (spool.materialId !== dto.materialId) {
        throw new BadRequestException('Spool does not belong to the selected material');
      }
    }

    return this.prisma.jobMaterial.create({
      data: {
        jobId,
        materialId: dto.materialId,
        spoolId: dto.spoolId,
        gramsUsed: dto.gramsUsed,
        costPerGram: material.costPerGram,
        colorIndex: dto.colorIndex || 0,
      },
      include: { material: true, spool: true },
    });
  }

  async removeMaterial(id: string) {
    return this.prisma.jobMaterial.delete({ where: { id } });
  }
}
