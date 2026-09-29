import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { MoonrakerController } from './moonraker.controller';

/**
 * Pausing, resuming or cancelling a live print is ADMIN/OPERATOR, like sending
 * G-code. VIEWER (read-only) and ACCOUNTING could call it before, because the
 * route had only the controller's StaffGuard.
 */
describe('POST /moonraker/control/:printerId/:action roles', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);
  const P = MoonrakerController.prototype;
  const ctx = (handler: unknown, role: string) => ({
    getHandler: () => handler,
    getClass: () => MoonrakerController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role, userType: 'staff' } }) }),
  }) as any;

  it('keeps JwtAuthGuard and StaffGuard on the controller and adds RolesGuard ADMIN/OPERATOR on control', () => {
    expect(reflector.get(GUARDS_METADATA, MoonrakerController)).toEqual([JwtAuthGuard, StaffGuard]);
    expect(reflector.get(GUARDS_METADATA, P.controlPrint)).toEqual([RolesGuard]);
    expect(reflector.get(ROLES_KEY, P.controlPrint)).toEqual(['ADMIN', 'OPERATOR']);
    expect(reflector.get(ROLES_KEY, P.controlPrint)).toEqual(reflector.get(ROLES_KEY, P.sendGcode));
  });

  it.each([['VIEWER', false], ['ACCOUNTING', false], ['OPERATOR', true], ['ADMIN', true]])('%s → %s', (role, allowed) => {
    expect(guard.canActivate(ctx(P.controlPrint, role as string))).toBe(allowed);
  });

  it.each(['pollAll', 'reconnectPrinter'] as const)('%s is ADMIN/OPERATOR too; VIEWER and ACCOUNTING are refused', (name) => {
    const handler = P[name];
    expect(reflector.get(GUARDS_METADATA, handler)).toEqual([RolesGuard]);
    expect(reflector.get(ROLES_KEY, handler)).toEqual(['ADMIN', 'OPERATOR']);
    for (const [role, allowed] of [['VIEWER', false], ['ACCOUNTING', false], ['OPERATOR', true], ['ADMIN', true]] as const) {
      expect(guard.canActivate(ctx(handler, role))).toBe(allowed);
    }
  });

  it('the live status read stays open to every staff role', () => {
    expect(reflector.get(ROLES_KEY, P.getStatus)).toBeUndefined();
    expect(guard.canActivate(ctx(P.getStatus, 'VIEWER'))).toBe(true);
  });

  it('an ADMIN call still reaches the bridge for the printer', async () => {
    const moonraker = { controlPrint: jest.fn(async () => true) };
    const crealityWs = { control: jest.fn(async () => true) };
    const prisma = { printer: { findUnique: jest.fn(async () => ({ id: 'pr-1', connectionType: 'MOONRAKER', moonrakerUrl: 'http://10.0.0.5' })) } };
    const c = new MoonrakerController(moonraker as any, crealityWs as any, prisma as any);
    await expect(c.controlPrint('pr-1', 'pause')).resolves.toEqual({ success: true });
    expect(moonraker.controlPrint).toHaveBeenCalledWith('http://10.0.0.5', 'pause');
    await expect(c.controlPrint('pr-1', 'explode')).rejects.toThrow('Action must be pause, resume, or cancel');
  });
});
