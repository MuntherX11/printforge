import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { LocationsController } from './locations.controller';
import { MaterialsController } from './materials.controller';
import { SpoolsController } from './spools.controller';

/**
 * Safety spec §1 (QR spool page leak): spool, location and filament-detail
 * data is staff only. The class guards run JwtAuthGuard before StaffGuard, the
 * QR landing route is no longer marked public, and the method-level role guards on
 * writes and QR exports are unchanged.
 */

type Handler = (...args: never[]) => unknown;
const guardsOf = (target: object): unknown[] => Reflect.getMetadata(GUARDS_METADATA, target) ?? [];
const spoolMethods = Object.getOwnPropertyNames(SpoolsController.prototype).filter((k) => k !== 'constructor');
const spoolHandler = (name: string): Handler =>
  (SpoolsController.prototype as unknown as Record<string, Handler>)[name];

function contextFor(user: unknown): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ user }) }) } as unknown as ExecutionContext;
}

describe('spool, location and filament-detail routes are staff only (safety §1)', () => {
  it('SpoolsController class guards are exactly [JwtAuthGuard, StaffGuard], in that order', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, SpoolsController)).toEqual([JwtAuthGuard, StaffGuard]);
  });

  it('no SpoolsController method is public; findByPfid in particular is not', () => {
    expect(spoolMethods).toContain('findByPfid');
    for (const name of spoolMethods) {
      expect([name, Reflect.getMetadata(IS_PUBLIC_KEY, spoolHandler(name))]).toEqual([name, undefined]);
    }
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, SpoolsController)).toBeUndefined();
  });

  it('writes and QR exports keep RolesGuard with ADMIN and OPERATOR', () => {
    const guarded = ['create', 'update', 'adjustWeight', 'remove', 'generateQrPng', 'generateQrImages', 'generateQrLabels'];
    for (const name of guarded) {
      expect([name, guardsOf(spoolHandler(name))]).toEqual([name, [RolesGuard]]);
      expect([name, Reflect.getMetadata(ROLES_KEY, spoolHandler(name))]).toEqual([name, ['ADMIN', 'OPERATOR']]);
    }
    for (const name of ['findAll', 'findOne', 'findByPfid']) {
      expect([name, guardsOf(spoolHandler(name))]).toEqual([name, []]);
    }
  });

  it('LocationsController class guards contain StaffGuard after JwtAuthGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, LocationsController)).toEqual([JwtAuthGuard, StaffGuard]);
  });

  it('GET /materials/:id is staff only; GET /materials (the list) stays open for the customer quick quote', () => {
    expect(guardsOf(MaterialsController.prototype.findOne)).toContain(StaffGuard);
    expect(guardsOf(MaterialsController.prototype.findAll)).not.toContain(StaffGuard);
    expect(guardsOf(MaterialsController)).toEqual([JwtAuthGuard]);
  });

  it('StaffGuard: a customer and a missing user get 403 "Staff access only"; a staff VIEWER passes', () => {
    const guard = new StaffGuard();
    for (const user of [{ userType: 'customer', id: 'c1' }, undefined]) {
      let err: unknown;
      try {
        guard.canActivate(contextFor(user));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).message).toBe('Staff access only');
      expect((err as ForbiddenException).getStatus()).toBe(403);
    }
    expect(guard.canActivate(contextFor({ userType: 'staff', role: 'VIEWER' }))).toBe(true);
  });
});
