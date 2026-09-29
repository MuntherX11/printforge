import { BadRequestException, ConflictException } from '@nestjs/common';
import type { CreateStorageLocationDto, UpdateStorageLocationDto } from '@printforge/types';
import type { PrismaService } from '../common/prisma/prisma.service';
import { LocationsService } from './locations.service';

/**
 * POST and PATCH /locations write only name and description. The DTOs are
 * interfaces the ValidationPipe can't whitelist, so a nested `spools` or
 * `parts` write used to reach Prisma: it could delete spools with job history
 * (safety spec §2) or create a filament with no duplicate check (§3).
 */

interface Args {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

function setup(existing: Record<string, unknown> | null = null) {
  const storageLocation = {
    findUnique: jest.fn(async (a: Args) => (a.where?.id === 'loc-1' ? { id: 'loc-1', name: 'Shelf B', spools: [], _count: { spools: 0 } } : existing)),
    create: jest.fn(async (a: Args) => ({ id: 'loc-new', ...a.data })),
    update: jest.fn(async (a: Args) => ({ id: a.where?.id, ...a.data })),
  };
  const svc = new LocationsService({ storageLocation } as unknown as PrismaService);
  return { svc, storageLocation };
}

/** A raw request body, as it arrives off the wire. */
const createBody = (body: unknown) => body as CreateStorageLocationDto;
const updateBody = (body: unknown) => body as UpdateStorageLocationDto;

async function badRequestOf(p: Promise<unknown>): Promise<string> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(BadRequestException);
  return (err as BadRequestException).message;
}

const nestedSpoolCreate = {
  name: 'x',
  spools: {
    create: [{
      initialWeight: 1000,
      currentWeight: 1000,
      material: { create: { name: 'dup', type: 'PLA', brand: 'eSUN', color: 'Red', costPerGram: 0 } },
    }],
  },
};

describe('LocationsService.create', () => {
  it('refuses a nested spools create with 400 and writes nothing', async () => {
    const { svc, storageLocation } = setup();
    expect(await badRequestOf(svc.create(createBody(nestedSpoolCreate)))).toBe('property spools should not exist');
    expect(storageLocation.create).not.toHaveBeenCalled();
    expect(storageLocation.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a parts key too', async () => {
    const { svc } = setup();
    expect(await badRequestOf(svc.create(createBody({ name: 'x', parts: { connect: [{ id: 'p1' }] } })))).toBe(
      'property parts should not exist',
    );
  });

  it('writes only the trimmed name and description, and checks the trimmed name for a duplicate', async () => {
    const { svc, storageLocation } = setup();
    await svc.create({ name: '  Shelf C ', description: ' top row ' });
    expect(storageLocation.findUnique).toHaveBeenCalledWith({ where: { name: 'Shelf C' } });
    expect(storageLocation.create).toHaveBeenCalledWith({ data: { name: 'Shelf C', description: 'top row' } });
  });

  it('a missing, blank or non-text name → 400', async () => {
    const { svc, storageLocation } = setup();
    expect(await badRequestOf(svc.create(createBody({})))).toBe('Name is required');
    expect(await badRequestOf(svc.create(createBody({ name: '   ' })))).toBe('Name is required');
    expect(await badRequestOf(svc.create(createBody({ name: { set: 'x' } })))).toBe('Name must be text');
    expect(storageLocation.create).not.toHaveBeenCalled();
  });

  it('a name already in use → 409', async () => {
    const { svc } = setup({ id: 'loc-2', name: 'Shelf C' });
    await expect(svc.create({ name: 'Shelf C' })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('LocationsService.update', () => {
  it.each<[string, Record<string, unknown>]>([
    ['spools deleteMany', { spools: { deleteMany: {} } }],
    ['spools set beside a valid name', { name: 'Shelf B2', spools: { set: [] } }],
  ])('refuses %s with 400 and writes nothing', async (_label, body) => {
    const { svc, storageLocation } = setup();
    expect(await badRequestOf(svc.update('loc-1', updateBody(body)))).toBe('property spools should not exist');
    expect(storageLocation.update).not.toHaveBeenCalled();
  });

  it('writes only the keys sent: a new name, or a cleared description', async () => {
    const { svc, storageLocation } = setup();
    await svc.update('loc-1', { name: ' Rack 2 ' });
    expect(storageLocation.update).toHaveBeenLastCalledWith({ where: { id: 'loc-1' }, data: { name: 'Rack 2' } });
    await svc.update('loc-1', updateBody({ description: null }));
    expect(storageLocation.update).toHaveBeenLastCalledWith({ where: { id: 'loc-1' }, data: { description: null } });
  });
});
