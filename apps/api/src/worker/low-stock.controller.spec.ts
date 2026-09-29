import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { LowStockController } from './low-stock.controller';

/** POST /low-stock/check writes notifications, so it is ADMIN/OPERATOR, not every staff role. */
describe('POST /low-stock/check roles', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);
  const handler = LowStockController.prototype.check;
  const ctx = (role: string) => ({
    getHandler: () => handler,
    getClass: () => LowStockController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role, userType: 'staff' } }) }),
  }) as any;

  it('keeps JwtAuthGuard and StaffGuard and adds RolesGuard ADMIN/OPERATOR', () => {
    expect(reflector.get(GUARDS_METADATA, LowStockController)).toEqual([JwtAuthGuard, StaffGuard]);
    expect(reflector.get(GUARDS_METADATA, handler)).toEqual([RolesGuard]);
    expect(reflector.get(ROLES_KEY, handler)).toEqual(['ADMIN', 'OPERATOR']);
  });

  it.each([['VIEWER', false], ['ACCOUNTING', false], ['OPERATOR', true], ['ADMIN', true]])('%s → %s', (role, allowed) => {
    expect(guard.canActivate(ctx(role as string))).toBe(allowed);
  });

  it('an allowed call still runs the check', async () => {
    const processor = { checkLowStock: jest.fn(async () => ({ alerts: 0 })) };
    await expect(new LowStockController(processor as any).check()).resolves.toEqual({ alerts: 0 });
    expect(processor.checkLowStock).toHaveBeenCalledTimes(1);
  });
});
