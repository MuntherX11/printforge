import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import type { PrismaService } from '../common/prisma/prisma.service';
import { fakeCatalogDb } from '../products/__fixtures__/fake-catalog-db';
import { WatchFolderController } from './watch-folder.controller';
import { WatchFolderService, type PendingImport } from './watch-folder.service';

/**
 * POST /watch-folder/:id/import creates a product, so it is ADMIN/OPERATOR and
 * its body goes through the product-input.ts parsers like every other product
 * write. It used to be open to every staff role and wrote the body to Prisma.
 */

function setup(analysis: Record<string, unknown> = { filamentUsedGrams: 42.5, estimatedTimeSeconds: 3600 }, fileType: 'gcode' | 'stl' = 'gcode') {
  const db = fakeCatalogDb();
  db.insert('material', { id: 'mat-1', name: 'PLA Black' });
  db.insert('product', { id: 'p-old', name: 'Old box', sku: 'BOX-1' });
  const svc = new WatchFolderService(db as unknown as PrismaService, {} as any, {} as any);
  const imp: PendingImport = {
    id: 'wi_1_1', filename: 'bracket.gcode', filePath: '/tmp/bracket.gcode', fileType, fileSize: 100,
    analysis, status: 'pending', createdAt: new Date(),
  };
  (svc as any).pendingImports.set(imp.id, imp);
  return { db, svc, imp };
}

async function errorOf(p: Promise<unknown>) {
  return p.then(() => null, (e) => e);
}

describe('POST /watch-folder/:id/import body', () => {
  it.each<[string, Record<string, unknown>]>([
    ['nested components', { components: { create: [{ materialId: 'mat-1', gramsUsed: -5, description: 'x' }] } }],
    ['basePrice', { basePrice: 0.001 }],
    ['estimatedGrams', { estimatedGrams: 1e9 }],
    ['isActive', { isActive: false }],
  ])('%s → 400, no product, the file stays pending', async (_label, extra) => {
    const h = setup();
    const err = await errorOf(h.svc.importAsProduct(h.imp.id, { name: 'Bracket', ...extra }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe(`property ${Object.keys(extra)[0]} should not exist`);
    expect(h.db.t('product')).toHaveLength(1);
    expect(h.imp.status).toBe('pending');
  });

  it('name and SKU follow parseProductCreate', async () => {
    const h = setup();
    expect((await errorOf(h.svc.importAsProduct(h.imp.id, { name: '  ' }))).message).toBe('Product name is required');
    expect((await errorOf(h.svc.importAsProduct(h.imp.id, { name: { set: 'x' } }))).message).toBe('Product name is required');
    expect((await errorOf(h.svc.importAsProduct(h.imp.id, { name: 'A', sku: 7 }))).message).toBe('"sku" must be text');
    expect((await errorOf(h.svc.importAsProduct(h.imp.id, { name: 'A', materialId: { connect: { id: 'mat-1' } } }))).message)
      .toBe('"materialId" must be an id');
    const out: any = await h.svc.importAsProduct(h.imp.id, { name: '<b>Bracket</b> ' + 'x'.repeat(300) });
    expect(out.name.startsWith('Bracket ')).toBe(true);
    expect(out.name).toHaveLength(200);
  });

  it('a taken SKU → 409 and an unknown material → 404; nothing is written and the file stays pending', async () => {
    const h = setup();
    expect(await errorOf(h.svc.importAsProduct(h.imp.id, { name: 'Bracket', sku: 'BOX-1' }))).toBeInstanceOf(ConflictException);
    expect(await errorOf(h.svc.importAsProduct(h.imp.id, { name: 'Bracket', materialId: 'mat-nope' }))).toBeInstanceOf(NotFoundException);
    expect(h.db.t('product')).toHaveLength(1);
    expect(h.db.t('productComponent')).toHaveLength(0);
    expect(h.imp.status).toBe('pending');
  });

  it('what the Watch Folder screen sends still saves: the product and its one component from the file', async () => {
    const h = setup();
    const out: any = await h.svc.importAsProduct(h.imp.id, { name: 'Bracket', sku: 'BR-1', materialId: 'mat-1' });
    expect(out).toMatchObject({ name: 'Bracket', sku: 'BR-1', estimatedGrams: 42.5, estimatedMinutes: 60 });
    expect(out.components).toEqual([expect.objectContaining({
      materialId: 'mat-1', description: 'bracket.gcode', gramsUsed: 42.5, printMinutes: 60, quantity: 1, sortOrder: 0, variantId: null,
      material: expect.objectContaining({ name: 'PLA Black' }),
    })]);
    // A new component's stock is per colour from the start (stockConfirmedAt set), as P9 does.
    expect(Object.prototype.toString.call(out.components[0].stockConfirmedAt)).toBe('[object Date]');
    expect(h.imp.status).toBe('imported');
    // A second click finds nothing to import.
    expect(await h.svc.importAsProduct(h.imp.id, { name: 'Bracket again' })).toBeNull();
    expect(h.db.t('product')).toHaveLength(2);
  });

  it('without a material the product is saved alone, as before', async () => {
    const h = setup({ estimatedGrams: 12, estimatedMinutes: 30 }, 'stl');
    const out: any = await h.svc.importAsProduct(h.imp.id, { name: 'Clip' });
    expect(out).toMatchObject({ name: 'Clip', sku: null, estimatedGrams: 12, estimatedMinutes: 30, components: [] });
  });

  it('weights and times read from the file are bounded', async () => {
    const huge = setup({ filamentUsedGrams: 1e9, estimatedTimeSeconds: 60 });
    expect((await errorOf(huge.svc.importAsProduct(huge.imp.id, { name: 'X' }))).message)
      .toBe("The file's filament weight in grams (1000000000) is more than 100000");
    expect(huge.db.t('product')).toHaveLength(1);

    const odd = setup({ filamentUsedGrams: Infinity, estimatedTimeSeconds: -60 });
    const out: any = await odd.svc.importAsProduct(odd.imp.id, { name: 'X' });
    expect(out).toMatchObject({ estimatedGrams: 0, estimatedMinutes: 0 });

    const none = setup({ filamentUsedGrams: null, estimatedTimeSeconds: 600 });
    expect((await errorOf(none.svc.importAsProduct(none.imp.id, { name: 'X', materialId: 'mat-1' }))).message)
      .toMatch(/^This file has no filament weight/);
    expect(none.db.t('product')).toHaveLength(1);
  });
});

describe('watch folder write roles', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);
  const P = WatchFolderController.prototype;
  const ctx = (handler: unknown, role: string) => ({
    getHandler: () => handler,
    getClass: () => WatchFolderController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role, userType: 'staff' } }) }),
  }) as any;

  it('import and dismiss are ADMIN/OPERATOR; the lists stay open to every staff role', () => {
    expect(reflector.get(GUARDS_METADATA, WatchFolderController)).toEqual([JwtAuthGuard, StaffGuard]);
    for (const handler of [P.importAsProduct, P.dismiss]) {
      expect(reflector.get(GUARDS_METADATA, handler)).toEqual([RolesGuard]);
      expect(reflector.get(ROLES_KEY, handler)).toEqual(['ADMIN', 'OPERATOR']);
    }
    expect(reflector.get(ROLES_KEY, P.getPending)).toBeUndefined();
    expect(reflector.get(ROLES_KEY, P.getAll)).toBeUndefined();
  });

  it.each([['VIEWER', false], ['ACCOUNTING', false], ['OPERATOR', true], ['ADMIN', true]])('%s → %s', (role, allowed) => {
    expect(guard.canActivate(ctx(P.importAsProduct, role as string))).toBe(allowed);
    expect(guard.canActivate(ctx(P.dismiss, role as string))).toBe(allowed);
  });
});
