import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateStorageLocationDto, UpdateStorageLocationDto } from '@printforge/types';

@Injectable()
export class LocationsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateStorageLocationDto) {
    const existing = await this.prisma.storageLocation.findUnique({ where: { name: dto.name } });
    if (existing) throw new ConflictException('Location name already exists');
    return this.prisma.storageLocation.create({ data: dto });
  }

  async findAll() {
    return this.prisma.storageLocation.findMany({
      include: { _count: { select: { spools: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const location = await this.prisma.storageLocation.findUnique({
      where: { id },
      include: {
        spools: {
          include: { material: true },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { spools: true } },
      },
    });
    if (!location) throw new NotFoundException('Location not found');
    return location;
  }

  async update(id: string, dto: UpdateStorageLocationDto) {
    await this.findOne(id);
    return this.prisma.storageLocation.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    const location = await this.findOne(id);
    if (location._count.spools > 0) {
      throw new ConflictException('Cannot delete location with spools assigned');
    }
    return this.prisma.storageLocation.delete({ where: { id } });
  }
}
