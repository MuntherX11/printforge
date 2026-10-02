import { BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { PrismaService } from '../common/prisma/prisma.service';
import { MaterialsController } from './materials.controller';
import { MaterialsService } from './materials.service';

/**
 * v2.17.3: staff set a filament's colour dot from the Filaments list and the
 * Edit Material dialog with PATCH /materials/:id { colorHex }.
 */
describe('PATCH /materials/:id { colorHex }', () => {
  const stored = {
    id: 'm1', name: 'Plamore PLA Haze Blue', type: 'PLA', brand: 'Plamore', color: 'Haze Blue', colorHex: null,
    costPerGram: 0.02, spoolPrice: 20, spoolWeightGrams: 1000, density: 1.24, reorderPoint: 500,
  };
  const setup = () => {
    const update = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...stored, ...data }));
    const prisma = {
      material: { findUnique: jest.fn(async () => stored), update },
      $transaction: jest.fn(),
    };
    return { update, prisma, svc: new MaterialsService(prisma as unknown as PrismaService) };
  };

  it.each([
    ['91202B', '91202B'],
    ['#91202b', '91202B'],
    ['  #a1b2c3 ', 'A1B2C3'],
  ])('%j is stored bare and upper case as %s', async (sent, saved) => {
    const { svc, update } = setup();
    await svc.update('m1', { colorHex: sent });
    expect(update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { colorHex: saved } });
  });

  it('a colour-only PATCH writes nothing but colorHex (no identity lock, no price change)', async () => {
    const { svc, update, prisma } = setup();
    await svc.update('m1', { colorHex: '8CAAC8' });
    expect(update.mock.calls[0][0].data).toEqual({ colorHex: '8CAAC8' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([null, ''])('%j clears the dot (stored as null)', async (sent) => {
    const { svc, update } = setup();
    await svc.update('m1', { colorHex: sent });
    expect(update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { colorHex: null } });
  });

  it.each(['91202', '91202BB', '#FFF', 'GGGGGG', 'red', '##91202B'])('%j is refused with 400 and nothing is written', async (sent) => {
    const { svc, update } = setup();
    await expect(svc.update('m1', { colorHex: sent })).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it('only ADMIN and OPERATOR may PATCH (VIEWER and ACCOUNTING see the dot only)', () => {
    const handler = MaterialsController.prototype.update;
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['ADMIN', 'OPERATOR']);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([RolesGuard]);
  });
});
