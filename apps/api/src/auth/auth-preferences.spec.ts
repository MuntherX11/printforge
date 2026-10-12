import { BadRequestException, ExecutionContext, ForbiddenException, Logger, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { StaffGuard } from './guards/staff.guard';
import { RolesGuard } from './guards/roles.guard';
import { ROLES_KEY } from './decorators/roles.decorator';

/** A one-user Prisma double: `preferences` is whatever the column holds. */
function fakePrisma(initial: unknown = {}) {
  const row = { id: 'u1', preferences: initial as any };
  return {
    row,
    user: {
      findUnique: jest.fn(async ({ where }: any) => (where.id === row.id ? { preferences: row.preferences } : null)),
      update: jest.fn(async ({ where, data }: any) => {
        if (where.id !== row.id) throw new Error('no such user');
        row.preferences = data.preferences;
        return row;
      }),
    },
  };
}

function build(initial?: unknown) {
  const prisma = fakePrisma(initial);
  const service = new AuthService(prisma as any, {} as any, {} as any);
  const controller = new AuthController(service, {} as any, {} as any);
  return { prisma, service, controller };
}

const staff = { id: 'u1', email: 's@x.om', name: 'S', role: 'VIEWER', isActive: true, userType: 'staff' as const };
const customer = { id: 'c1', email: 'c@x.om', name: 'C', phone: null, isApproved: true, userType: 'customer' as const };

function contextFor(user: unknown): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ user }) }) } as unknown as ExecutionContext;
}

describe('GET /auth/me preferences', () => {
  it('returns {} for a staff user who never set one', async () => {
    const { controller } = build();
    await expect(controller.me(staff)).resolves.toEqual({ ...staff, preferences: {} });
  });

  it('returns the stored layout', async () => {
    const { controller } = build({ productPageLayout: 'FOLDED' });
    await expect(controller.me(staff)).resolves.toMatchObject({ preferences: { productPageLayout: 'FOLDED' } });
  });

  it('leaves out stored keys and values it does not know', async () => {
    const { controller } = build({ productPageLayout: 'GRID', theme: 'dark' });
    await expect(controller.me(staff)).resolves.toMatchObject({ preferences: {} });
  });

  it('survives a column that is not an object', async () => {
    const { controller } = build(null);
    await expect(controller.me(staff)).resolves.toMatchObject({ preferences: {} });
  });

  it('falls back to {} when the preferences cannot be loaded (the column is not there yet during a deploy), warning once', async () => {
    const { controller, prisma } = build({ productPageLayout: 'FOLDED' });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    prisma.user.findUnique.mockRejectedValue(new Error('The column `User.preferences` does not exist in the current database.'));
    await expect(controller.me(staff)).resolves.toEqual({ ...staff, preferences: {} });
    await expect(controller.me(staff)).resolves.toEqual({ ...staff, preferences: {} });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('Could not load user preferences');
    // Saving is not softened: it fails loudly.
    await expect(controller.updateMyPreferences(staff, { productPageLayout: 'TABS' })).rejects.toThrow('does not exist');
    warn.mockRestore();
  });

  it('gives a customer their own record unchanged, without a user lookup', async () => {
    const { controller, prisma } = build();
    await expect(controller.me(customer)).resolves.toBe(customer);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('PATCH /auth/me/preferences', () => {
  it('stores the layout and returns the merged preferences', async () => {
    const { controller, prisma } = build();
    await expect(controller.updateMyPreferences(staff, { productPageLayout: 'FOLDED' })).resolves.toEqual({ productPageLayout: 'FOLDED' });
    expect(prisma.row.preferences).toEqual({ productPageLayout: 'FOLDED' });
    await expect(controller.me(staff)).resolves.toMatchObject({ preferences: { productPageLayout: 'FOLDED' } });
  });

  it('keeps the other stored keys when merging', async () => {
    const { controller, prisma } = build({ productPageLayout: 'TABS', somethingLater: { a: 1 } });
    await controller.updateMyPreferences(staff, { productPageLayout: 'FOLDED' });
    expect(prisma.row.preferences).toEqual({ productPageLayout: 'FOLDED', somethingLater: { a: 1 } });
  });

  it('changes nothing for an empty or missing body', async () => {
    const { controller, prisma } = build({ productPageLayout: 'FOLDED' });
    await expect(controller.updateMyPreferences(staff, {})).resolves.toEqual({ productPageLayout: 'FOLDED' });
    await expect(controller.updateMyPreferences(staff, undefined)).resolves.toEqual({ productPageLayout: 'FOLDED' });
    expect(prisma.row.preferences).toEqual({ productPageLayout: 'FOLDED' });
  });

  it.each([
    [{ theme: 'dark' }, 'property theme should not exist'],
    [{ productPageLayout: 'FOLDED', role: 'ADMIN' }, 'property role should not exist'],
    [{ preferences: { productPageLayout: 'FOLDED' } }, 'property preferences should not exist'],
  ])('rejects the unknown key in %j', async (body, message) => {
    const { controller, prisma } = build();
    await expect(controller.updateMyPreferences(staff, body)).rejects.toThrow(new BadRequestException(message));
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it.each(['GRID', 'tabs', '', null, 1, true, ['TABS'], { set: 'TABS' }])('rejects the layout value %j', async value => {
    const { controller, prisma } = build();
    await expect(controller.updateMyPreferences(staff, { productPageLayout: value })).rejects.toThrow(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it.each(['TABS', [], 3])('rejects the non-object body %j', async body => {
    const { controller } = build();
    await expect(controller.updateMyPreferences(staff, body)).rejects.toThrow(BadRequestException);
  });

  it('only ever writes the signed-in user', async () => {
    const { controller, prisma } = build();
    await controller.updateMyPreferences(staff, { productPageLayout: 'TABS' });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { preferences: { productPageLayout: 'TABS' } } });
  });

  describe('access', () => {
    const handler = AuthController.prototype.updateMyPreferences;
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];

    it('is PATCH auth/me/preferences', () => {
      expect(Reflect.getMetadata(PATH_METADATA, AuthController)).toBe('auth');
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('me/preferences');
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.PATCH);
    });

    it('needs a session and a staff token, and no particular role', () => {
      expect(guards).toEqual([JwtAuthGuard, StaffGuard]);
      expect(guards).not.toContain(RolesGuard);
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toBeUndefined();
    });

    it('refuses a customer token', () => {
      expect(() => new StaffGuard().canActivate(contextFor(customer))).toThrow(ForbiddenException);
    });

    it.each(['ADMIN', 'ACCOUNTING', 'OPERATOR', 'VIEWER'])('lets %s through', role => {
      expect(new StaffGuard().canActivate(contextFor({ ...staff, role }))).toBe(true);
    });

    it('is declared before every :id route of the controller', () => {
      const names = Object.getOwnPropertyNames(AuthController.prototype);
      const paths = names.map(n => String(Reflect.getMetadata(PATH_METADATA, (AuthController.prototype as any)[n]) ?? ''));
      const mine = names.indexOf('updateMyPreferences');
      const firstParam = paths.findIndex(p => p.includes(':'));
      expect(mine).toBeGreaterThan(-1);
      expect(firstParam === -1 || mine < firstParam).toBe(true);
    });
  });
});
