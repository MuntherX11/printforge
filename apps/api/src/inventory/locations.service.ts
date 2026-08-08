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

  /**
   * Spools available to put in a location: everything currently unassigned,
   * plus whatever already lives here (so the picker can show them ticked).
   *
   * Returns the fields used to identify a spool by eye on the shelf — colour,
   * type, brand and grams remaining.
   */
  async assignableSpools(id: string) {
    await this.findOne(id);
    const spools = await this.prisma.spool.findMany({
      where: { isActive: true, OR: [{ locationId: null }, { locationId: id }] },
      select: {
        id: true,
        printforgeId: true,
        currentWeight: true,
        locationId: true,
        material: { select: { color: true, type: true, brand: true, name: true } },
      },
      orderBy: [{ currentWeight: 'desc' }],
    });
    return spools.map((s) => ({
      id: s.id,
      printforgeId: s.printforgeId,
      color: s.material?.color ?? null,
      type: s.material?.type ?? null,
      brand: s.material?.brand ?? null,
      materialName: s.material?.name ?? null,
      gramsRemaining: Math.round(s.currentWeight),
      assignedHere: s.locationId === id,
    }));
  }

  /**
   * Set exactly which spools live in this location. Spools ticked are moved
   * here; spools previously here but now unticked are cleared, so the dialog
   * can be used to remove as well as add.
   */
  async setSpools(id: string, spoolIds: string[]) {
    await this.findOne(id);
    const ids = Array.from(new Set((spoolIds ?? []).filter((s) => typeof s === 'string' && s)));

    // Only accept spools that exist — a bad id shouldn't half-apply the change.
    const found = ids.length
      ? await this.prisma.spool.findMany({ where: { id: { in: ids } }, select: { id: true } })
      : [];
    if (found.length !== ids.length) {
      throw new NotFoundException('One or more selected spools no longer exist');
    }

    const [cleared, assigned] = await this.prisma.$transaction([
      // Unassign anything here that wasn't ticked.
      this.prisma.spool.updateMany({
        where: { locationId: id, ...(ids.length ? { id: { notIn: ids } } : {}) },
        data: { locationId: null },
      }),
      // Move every ticked spool here (no-op for ones already here).
      ids.length
        ? this.prisma.spool.updateMany({ where: { id: { in: ids } }, data: { locationId: id } })
        : this.prisma.spool.updateMany({ where: { id: '' }, data: { locationId: null } }),
    ]);

    return { assigned: assigned.count, removed: cleared.count };
  }

  async remove(id: string) {
    const location = await this.findOne(id);
    if (location._count.spools > 0) {
      throw new ConflictException('Cannot delete location with spools assigned');
    }
    return this.prisma.storageLocation.delete({ where: { id } });
  }
}
