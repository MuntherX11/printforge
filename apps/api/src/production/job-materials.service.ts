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
      if (dto.gramsUsed > 0 && spool.currentWeight < dto.gramsUsed) {
        throw new BadRequestException(
          `Insufficient filament on spool: ${spool.currentWeight.toFixed(1)} g available, ${dto.gramsUsed} g required`,
        );
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

  /**
   * Swap a filament line to a different colour of the SAME material type.
   *
   * For when the customer changes colour after the file is sliced: geometry
   * and grams are unchanged, only the filament differs. The swap re-reserves a
   * spool in the new colour (smallest that still covers the line, or an
   * explicit spool), re-snapshots the cost, and remembers what the file was
   * sliced with so the picking list can say "printing Red, sliced for White".
   *
   * Type is a hard wall — a colour is an operator's call, printing PETG where
   * the file wants PLA is not.
   */
  async swapColour(lineId: string, dto: { materialId: string; spoolId?: string }) {
    const line = await this.prisma.jobMaterial.findUnique({
      where: { id: lineId },
      include: { material: true, job: { select: { id: true, status: true } } },
    });
    if (!line) throw new NotFoundException('Job material not found');

    // The deduction happens at completion, so after a terminal state the swap
    // would either do nothing or lie about what was consumed.
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(line.job.status)) {
      throw new BadRequestException(`Cannot change filament on a ${line.job.status.toLowerCase()} job`);
    }

    const next = await this.prisma.material.findUnique({ where: { id: dto.materialId } });
    if (!next) throw new NotFoundException('Material not found');
    if (line.material && next.type !== line.material.type) {
      throw new BadRequestException(
        `Filament type must stay ${line.material.type} — pick a different colour, not a different plastic`,
      );
    }

    // Choose the spool: explicit if given, otherwise the smallest active spool
    // of the new material that still covers this line.
    let spool = null;
    if (dto.spoolId) {
      spool = await this.prisma.spool.findUnique({ where: { id: dto.spoolId } });
      if (!spool) throw new NotFoundException('Spool not found');
      if (!spool.isActive) throw new BadRequestException('Spool is inactive and cannot be assigned');
      if (spool.materialId !== next.id) {
        throw new BadRequestException('Spool does not belong to the selected material');
      }
      if (spool.currentWeight < line.gramsUsed) {
        throw new BadRequestException(
          `Only ${spool.currentWeight.toFixed(0)} g left on that spool, ${line.gramsUsed} g needed`,
        );
      }
    } else {
      const candidates = await this.prisma.spool.findMany({
        where: { materialId: next.id, isActive: true, currentWeight: { gt: 0 } },
        orderBy: { currentWeight: 'asc' },
      });
      spool = candidates.find((s) => s.currentWeight >= line.gramsUsed) ?? null;
      if (!spool) {
        const best = candidates[candidates.length - 1];
        throw new BadRequestException(
          best
            ? `No single spool of that colour covers ${line.gramsUsed} g — fullest has ${best.currentWeight.toFixed(0)} g. Pick a spool explicitly if you want to split.`
            : 'No active spool of that colour in stock',
        );
      }
    }

    return this.prisma.jobMaterial.update({
      where: { id: lineId },
      data: {
        materialId: next.id,
        spoolId: spool.id,
        // Grams are the sliced weight — unchanged by colour.
        // New material, new price: re-snapshot.
        costPerGram: next.costPerGram,
        // First swap records the original; later swaps keep it.
        slicedMaterialId: line.slicedMaterialId ?? line.materialId,
      },
      include: { material: true, spool: true, slicedMaterial: true },
    });
  }

  async removeMaterial(id: string) {
    const exists = await this.prisma.jobMaterial.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Job material not found');
    return this.prisma.jobMaterial.delete({ where: { id } });
  }
}
