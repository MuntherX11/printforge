import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { PrismaService } from '../common/prisma/prisma.service';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';

/**
 * The Locations screen (inventory/locations/page.tsx) still saves after the
 * POST/PATCH allowlist, and the write routes keep their ADMIN/OPERATOR gate.
 */
describe('Locations screen payloads and write roles', () => {
  function setup() {
    const storageLocation = {
      findUnique: jest.fn(async (a: any) => (a.where?.id === 'loc-1' ? { id: 'loc-1', name: 'Shelf B', spools: [], _count: { spools: 0 } } : null)),
      create: jest.fn(async (a: any) => ({ id: 'loc-new', ...a.data })),
      update: jest.fn(async (a: any) => ({ id: a.where?.id, ...a.data })),
    };
    return { svc: new LocationsService({ storageLocation } as unknown as PrismaService), storageLocation };
  }

  it('Add Location sends name with a blank description as undefined, and it saves', async () => {
    const { svc, storageLocation } = setup();
    await svc.create({ name: 'Shelf D', description: undefined });
    expect(storageLocation.create).toHaveBeenCalledWith({ data: { name: 'Shelf D', description: null } });
    await svc.create({ name: 'Shelf E', description: 'Bottom drawer' });
    expect(storageLocation.create).toHaveBeenLastCalledWith({ data: { name: 'Shelf E', description: 'Bottom drawer' } });
  });

  it('POST and PATCH /locations stay ADMIN or OPERATOR', () => {
    const reflector = new Reflector();
    for (const handler of [LocationsController.prototype.create, LocationsController.prototype.update]) {
      expect(reflector.get(GUARDS_METADATA, handler)).toEqual([RolesGuard]);
      expect(reflector.get(ROLES_KEY, handler)).toEqual(['ADMIN', 'OPERATOR']);
    }
  });
});
