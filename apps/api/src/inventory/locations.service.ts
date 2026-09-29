import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateStorageLocationDto, UpdateStorageLocationDto } from '@printforge/types';
import { allowedBody, optionalText, requiredText } from '../common/utils/validate-number';

/** Longest location name and description kept, in characters. */
const NAME_MAX = 100;
const DESCRIPTION_MAX = 500;

/**
 * The only keys POST and PATCH /locations write. The location DTOs are
 * interfaces the global ValidationPipe can't whitelist, and StorageLocation
 * has spools and parts relations: passing the body straight to Prisma let
 * {"spools":{"deleteMany":{}}} delete a shelf's spools with their job history
 * (getting round the spool delete guard) and {"spools":{"create":[...]}}
 * create a filament with no duplicate check. Any other key → 400.
 */
const LOCATION_KEYS: readonly string[] = ['name', 'description'];

function locationName(raw: unknown): string {
  if (raw !== undefined && raw !== null && typeof raw !== 'string') throw new BadRequestException('Name must be text');
  return requiredText(raw, 'Name', NAME_MAX);
}

@Injectable()
export class LocationsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateStorageLocationDto) {
    const body = allowedBody(dto, LOCATION_KEYS);
    const data: Prisma.StorageLocationCreateInput = {
      name: locationName(body.name),
      description: optionalText(body.description, 'description', DESCRIPTION_MAX) ?? null,
    };
    const existing = await this.prisma.storageLocation.findUnique({ where: { name: data.name } });
    if (existing) throw new ConflictException('Location name already exists');
    return this.prisma.storageLocation.create({ data });
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
    const body = allowedBody(dto, LOCATION_KEYS);
    const data: Prisma.StorageLocationUpdateInput = {};
    if (body.name !== undefined) data.name = locationName(body.name);
    const description = optionalText(body.description, 'description', DESCRIPTION_MAX);
    if (description !== undefined) data.description = description;
    await this.findOne(id);
    return this.prisma.storageLocation.update({ where: { id }, data });
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
