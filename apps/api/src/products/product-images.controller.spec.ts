import { HttpException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { makeJpeg, makePng } from '../common/utils/__fixtures__/test-images';
import { photoPrisma, PhotoPrisma } from './__fixtures__/photo-prisma';
import { ProductImagesController, sendImageFile } from './product-images.controller';
import { ProductImagesService } from './product-images.service';

/** Minimal express Response double that records what would be sent. */
function fakeRes() {
  const res: any = {
    headers: {} as Record<string, string>,
    statusCode: 200,
    body: undefined as any,
    sent: null as null | { path: string; opts: any },
    headersSent: false,
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
    },
    removeHeader(k: string) {
      delete this.headers[k.toLowerCase()];
    },
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: any) {
      this.body = b;
      return this;
    },
    sendFile(p: string, opts: any, cb: (err?: any) => void) {
      this.sent = { path: p, opts };
      cb();
    },
  };
  return res;
}

type Who = 'none' | 'staff' | 'approved' | 'unapproved';
const users: Record<Who, any> = {
  none: undefined,
  staff: { id: 's1', userType: 'staff', role: 'VIEWER' },
  approved: { id: 'c1', userType: 'customer', isApproved: true },
  unapproved: { id: 'c2', userType: 'customer', isApproved: false },
};

describe('ProductImagesController', () => {
  let tmp: string;
  let prisma: PhotoPrisma;
  let svc: ProductImagesService;
  let ctrl: ProductImagesController;
  const oldDir = process.env.UPLOAD_DIR;
  let activeImg: string;
  let inactiveImg: string;
  let otherImg: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-photo-ctrl-'));
    process.env.UPLOAD_DIR = tmp;
    prisma = photoPrisma();
    await prisma.product.create({ data: { id: 'pA', isActive: true } });
    await prisma.product.create({ data: { id: 'pI', isActive: false } });
    await prisma.product.create({ data: { id: 'pB', isActive: true } });
    svc = new ProductImagesService(prisma as any);
    ctrl = new ProductImagesController(svc);
    const up = async (pid: string) =>
      (await svc.upload(pid, [{ originalname: 'x.jpg', buffer: makeJpeg({ width: 4, height: 4 }) }]))[0].id;
    activeImg = await up('pA');
    inactiveImg = await up('pI');
    otherImg = await up('pB');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env.UPLOAD_DIR = oldDir;
  });

  async function serve(who: Who, productId: string, imageId: string) {
    const res = fakeRes();
    try {
      await ctrl.serve(productId, imageId, { user: users[who] } as any, res);
      return { status: res.sent ? 200 : res.statusCode, res };
    } catch (e) {
      if (e instanceof HttpException) return { status: e.getStatus(), res, body: e.getResponse(), error: e };
      throw e;
    }
  }

  describe('G5 authorisation matrix (§4.6)', () => {
    // [caller, own image of active product, inactive product, image id of another product, unknown id]
    const matrix: Array<[Who, number, number, number, number]> = [
      ['none', 401, 401, 401, 401],
      ['staff', 200, 200, 404, 404],
      ['approved', 200, 404, 404, 404],
      ['unapproved', 404, 404, 404, 404],
    ];

    it.each(matrix)('%s → active %i, inactive %i, foreign %i, unknown %i', async (who, a, i, f, u) => {
      expect((await serve(who, 'pA', activeImg)).status).toBe(a);
      expect((await serve(who, 'pI', inactiveImg)).status).toBe(i);
      expect((await serve(who, 'pA', otherImg)).status).toBe(f); // image of pB requested through pA
      expect((await serve(who, 'pA', 'does-not-exist')).status).toBe(u);
    });

    it('every staff role gets 200, including inactive products', async () => {
      for (const role of ['ADMIN', 'OPERATOR', 'ACCOUNTING', 'VIEWER']) {
        const res = fakeRes();
        await ctrl.serve('pI', inactiveImg, { user: { userType: 'staff', role } } as any, res);
        expect(res.sent).not.toBeNull();
      }
    });

    it('every 404 has the same body', async () => {
      const bodies = [
        (await serve('approved', 'pI', inactiveImg)).body,
        (await serve('unapproved', 'pA', activeImg)).body,
        (await serve('staff', 'pA', otherImg)).body,
        (await serve('staff', 'pA', 'nope')).body,
      ];
      for (const b of bodies) expect(b).toMatchObject({ message: 'Image not found', statusCode: 404 });
    });

    it('no login is a 401 and the controller class is behind JwtAuthGuard', async () => {
      const r = await serve('none', 'pA', activeImg);
      expect(r.error).toBeInstanceOf(UnauthorizedException);
      expect(Reflect.getMetadata(GUARDS_METADATA, ProductImagesController)).toContain(JwtAuthGuard);
    });

    it('a customer who loses approval (or a product that is deactivated) stops getting the image', async () => {
      expect((await serve('approved', 'pA', activeImg)).status).toBe(200);
      prisma.product.rows.find((p) => p.id === 'pA')!.isActive = false;
      expect((await serve('approved', 'pA', activeImg)).status).toBe(404);
    });
  });

  describe('G5 headers', () => {
    it('sets the §4.6 headers and sendFile options', async () => {
      const { res } = await serve('staff', 'pA', activeImg);
      expect(res.headers).toMatchObject({
        'content-type': 'image/jpeg',
        'x-content-type-options': 'nosniff',
        'content-disposition': 'inline; filename="photo.jpg"',
        'content-security-policy': "default-src 'none'; sandbox",
        'cross-origin-resource-policy': 'same-origin',
        'cache-control': 'private, no-cache',
      });
      expect(res.sent.opts).toEqual({ dotfiles: 'deny', cacheControl: false, etag: true, lastModified: true });
      const key = prisma.productImage.rows.find((r) => r.id === activeImg)!.storageKey;
      expect(res.sent.path).toBe(path.join(path.resolve(tmp), 'product-images', key));
    });

    it('a sendFile error becomes the standard 404 body', () => {
      const res = fakeRes();
      res.sendFile = (_p: string, _o: any, cb: (e?: any) => void) => cb(Object.assign(new Error('ENOENT'), { status: 404 }));
      sendImageFile(res, '/nowhere/x.png', 'image/png');
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ success: false, error: 'Image not found', statusCode: 404 });
    });

    it('sendImageFile refuses a mime outside the allowlist', () => {
      const res = fakeRes();
      sendImageFile(res, '/x/y.svg', 'image/svg+xml');
      expect(res.sent).toBeNull();
      expect(res.statusCode).toBe(404);
    });
  });

  describe('G5 path and mime hardening', () => {
    it('a tampered storageKey (../x.png) → 404, even for staff', async () => {
      prisma.productImage.rows.find((r) => r.id === activeImg)!.storageKey = '../x.png';
      const r = await serve('staff', 'pA', activeImg);
      expect(r.status).toBe(404);
      expect(r.res.sent).toBeNull();
    });

    it('a storageKey that only looks opaque but is not (absolute, dotted, uppercase) → 404', async () => {
      for (const key of ['/etc/passwd', 'ABCDEFGHIJKLMNOPQRSTUVWX.png', `${'a'.repeat(32)}.svg`, `..${'a'.repeat(30)}.png`]) {
        prisma.productImage.rows.find((r) => r.id === activeImg)!.storageKey = key;
        expect((await serve('staff', 'pA', activeImg)).status).toBe(404);
      }
    });

    it('stored mime image/svg+xml → 404', async () => {
      prisma.productImage.rows.find((r) => r.id === activeImg)!.mimeType = 'image/svg+xml';
      expect((await serve('staff', 'pA', activeImg)).status).toBe(404);
    });

    it('a mime that does not match the key extension → 404', async () => {
      prisma.productImage.rows.find((r) => r.id === activeImg)!.mimeType = 'image/png';
      expect((await serve('staff', 'pA', activeImg)).status).toBe(404);
    });

    it('never reads Product.imageUrl', async () => {
      prisma.product.rows.find((p) => p.id === 'pA')!.imageUrl = '../../etc/passwd';
      const { res } = await serve('staff', 'pA', activeImg);
      expect(res.sent.path).toContain('product-images');
    });
  });

  describe('throttling and guards metadata', () => {
    it('G5 skips the short, medium and long throttlers', () => {
      const reflector = new Reflector();
      for (const name of ['short', 'medium', 'long']) {
        expect(reflector.get(`THROTTLER:SKIP${name}`, ProductImagesController.prototype.serve)).toBe(true);
      }
    });

    it('G1 is staff-only; G2–G4 require ADMIN/OPERATOR', () => {
      const guards = (m: any) => Reflect.getMetadata(GUARDS_METADATA, m) ?? [];
      expect(guards(ProductImagesController.prototype.list)).toContain(StaffGuard);
      for (const m of ['upload', 'reorder', 'remove'] as const) {
        expect(guards(ProductImagesController.prototype[m])).toContain(RolesGuard);
        expect(Reflect.getMetadata('roles', ProductImagesController.prototype[m])).toEqual(['ADMIN', 'OPERATOR']);
      }
      // G5 has no extra guard: its own check handles customers (404, not 403).
      expect(guards(ProductImagesController.prototype.serve)).toEqual([]);
    });
  });

  describe('P15 support: component plate thumbnails (route wired in WP4)', () => {
    let compA: string;
    let compB: string;
    beforeEach(async () => {
      fs.mkdirSync(path.join(tmp, 'thumbs'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'thumbs', 'a.png'), makePng({ width: 8, height: 8 }));
      fs.writeFileSync(path.join(tmp, 'thumbs', 'b.png'), makePng({ width: 8, height: 8 }));
      fs.writeFileSync(path.join(tmp, 'thumbs', 'fake.png'), Buffer.from('; G-code\nG1 X0\n'));
      const attA = await prisma.attachment.create({ data: { entityType: 'product', entityId: 'pA', storagePath: path.join('thumbs', 'a.png') } });
      const attB = await prisma.attachment.create({ data: { entityType: 'product', entityId: 'pB', storagePath: path.join('thumbs', 'b.png') } });
      compA = (await prisma.productComponent.create({ data: { productId: 'pA', thumbnailAttachmentId: attA.id } })).id;
      compB = (await prisma.productComponent.create({ data: { productId: 'pB', thumbnailAttachmentId: attB.id } })).id;
    });

    it('serves the PNG of a component of this product', async () => {
      const t = await svc.resolveComponentThumbnail('pA', compA);
      expect(t).toMatchObject({ mime: 'image/png', ext: 'png' });
      expect(t.absPath).toBe(path.join(path.resolve(tmp), 'thumbs', 'a.png'));
    });

    it('a component of another product → 404', async () => {
      await expect(svc.resolveComponentThumbnail('pA', compB)).rejects.toThrow('Image not found');
    });

    it('a thumbnail attachment of another product → 404', async () => {
      prisma.productComponent.rows.find((c) => c.id === compA)!.thumbnailAttachmentId =
        prisma.productComponent.rows.find((c) => c.id === compB)!.thumbnailAttachmentId;
      await expect(svc.resolveComponentThumbnail('pA', compA)).rejects.toThrow('Image not found');
    });

    it('a non-PNG file behind a thumbnail id → 404', async () => {
      const att = await prisma.attachment.create({ data: { entityType: 'product', entityId: 'pA', storagePath: path.join('thumbs', 'fake.png') } });
      prisma.productComponent.rows.find((c) => c.id === compA)!.thumbnailAttachmentId = att.id;
      await expect(svc.resolveComponentThumbnail('pA', compA)).rejects.toThrow('Image not found');
    });

    it('a thumbnail path escaping UPLOAD_DIR → 404', async () => {
      const att = await prisma.attachment.create({ data: { entityType: 'product', entityId: 'pA', storagePath: '../../etc/passwd' } });
      prisma.productComponent.rows.find((c) => c.id === compA)!.thumbnailAttachmentId = att.id;
      await expect(svc.resolveComponentThumbnail('pA', compA)).rejects.toThrow('Image not found');
    });
  });
});
