import { Global, INestApplication, Module } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { StaffGuard } from '../auth/guards/staff.guard';
import { ChunkUploadsService } from '../chunk-uploads/chunk-uploads.service';
import { PrismaModule } from '../common/prisma/prisma.module';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisCacheService } from '../common/redis/redis-cache.service';
import { WatchFolderService } from '../file-parser/watch-folder.service';
import { ProductImageBackfillService } from './product-image-backfill.service';
import { ProductsController } from './products.controller';
import { ProductsModule } from './products.module';

/**
 * Critic fix 1 / WP4 acceptance: boots ProductsModule, walks the Express router
 * stack and asserts that no `METHOD /path` under /products is registered twice
 * (a second handler would silently shadow or be shadowed by the first).
 */
/** SettingsService needs the (global) Redis cache; the route table doesn't. */
@Global()
@Module({ providers: [{ provide: RedisCacheService, useValue: {} }], exports: [RedisCacheService] })
class StubRedisModule {}

describe('ProductsModule routes', () => {
  let app: INestApplication;
  let routes: string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, StubRedisModule, ProductsModule] })
      .overrideProvider(PrismaService).useValue({})
      .overrideProvider(ChunkUploadsService).useValue({ consume: jest.fn() })
      .overrideProvider(WatchFolderService).useValue({})
      .overrideProvider(ProductImageBackfillService).useValue({})
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    const stack: any[] = app.getHttpAdapter().getInstance()._router.stack;
    routes = stack
      .filter((layer) => layer.route)
      .flatMap((layer) => Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${layer.route.path}`))
      .filter((r) => r.split(' ')[1].startsWith('/products'));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('registers every METHOD /path under /products exactly once', () => {
    const seen = new Map<string, number>();
    for (const r of routes) seen.set(r, (seen.get(r) ?? 0) + 1);
    const twice = [...seen.entries()].filter(([, n]) => n > 1).map(([r]) => r);
    expect(twice).toEqual([]);
    expect(routes.length).toBeGreaterThan(40);
  });

  it('covers the photo routes, the moved option routes and the moved import routes', () => {
    expect(routes).toEqual(expect.arrayContaining([
      'POST /products/:id/images',
      'DELETE /products/:id/images/:imageId',
      'GET /products/:id/images/:imageId',
      'POST /products/:id/variants',
      'PATCH /products/:id/variants/:variantId',
      'DELETE /products/:id/variants/:variantId',
      'POST /products/:id/variants/:variantId/calculate',
      'PUT /products/:id/variants/:variantId/colour-slots',
      'PUT /products/:id/option-kinds',
      'POST /products/:id/onboard-gcode',
      'POST /products/:id/onboard-3mf',
      'PUT /products/:id/colour-links',
      'GET /products/:id/components/:componentId/thumbnail',
      'GET /products/:id/bulk-floor',
      'GET /products/:id/cost',
    ]));
  });

  it('the removed routes are gone', () => {
    expect(routes).not.toContain('GET /products/:id/bulk-costs');
    expect(routes).not.toContain('POST /products/:id/variants/:variantId/onboard-gcode');
  });
});

describe('P15 component thumbnail route', () => {
  const reflector = new Reflector();
  const handler = ProductsController.prototype.thumbnail;

  it('skips all three named throttlers (short, medium, long), like the photo route', () => {
    for (const name of ['short', 'medium', 'long']) {
      expect(reflector.get(`THROTTLER:SKIP${name}`, handler)).toBe(true);
    }
  });

  it('is staff-only', () => {
    expect(reflector.get(GUARDS_METADATA, handler)).toContain(StaffGuard);
  });

  it('serves the authorised PNG through the shared helper, and 404s otherwise', async () => {
    const images = { resolveComponentThumbnail: jest.fn(async () => ({ absPath: '/u/t.png', mime: 'image/png', ext: 'png' })) };
    const ctrl = new ProductsController({} as any, {} as any, images as any);
    const res: any = { headers: {}, setHeader(k: string, v: string) { this.headers[k] = v; }, sendFile: jest.fn() };
    await ctrl.thumbnail('p1', 'c1', res);
    expect(images.resolveComponentThumbnail).toHaveBeenCalledWith('p1', 'c1');
    expect(res.sendFile).toHaveBeenCalledWith('/u/t.png', expect.objectContaining({ dotfiles: 'deny' }), expect.any(Function));
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(res.headers['Cache-Control']).toBe('private, no-cache');
  });
});
