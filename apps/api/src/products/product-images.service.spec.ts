import { BadRequestException, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeHeic, makeJpeg, makePng, makeWebpVp8 } from '../common/utils/__fixtures__/test-images';
import { sniffImage } from '../common/utils/image-sniff';
import { photoPrisma, PhotoPrisma } from './__fixtures__/photo-prisma';
import {
  imagePathForKey,
  ProductImagesService,
  sanitizeImageName,
  STORAGE_KEY_RE,
} from './product-images.service';

const file = (name: string, buffer: Buffer) => ({ originalname: name, buffer, size: buffer.length });
const has = (buf: Buffer, s: string) => buf.includes(Buffer.from(s, 'latin1'));

describe('ProductImagesService', () => {
  let tmp: string;
  let prisma: PhotoPrisma;
  let svc: ProductImagesService;
  const oldDir = process.env.UPLOAD_DIR;

  const photoFiles = () => {
    const dir = path.join(tmp, 'product-images');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-photos-'));
    process.env.UPLOAD_DIR = tmp;
    prisma = photoPrisma();
    await prisma.product.create({ data: { id: 'p1', name: 'Sardine tin', isActive: true, imageUrl: null } });
    svc = new ProductImagesService(prisma as any);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env.UPLOAD_DIR = oldDir;
  });

  describe('upload (G2)', () => {
    it('stores sniffed photos under opaque keys and returns them, first one as cover', async () => {
      const out = await svc.upload('p1', [file('a.jpg', makeJpeg({ width: 40, height: 30 })), file('b.png', makePng({ width: 8, height: 8 }))], 'u1');
      expect(out).toHaveLength(2);
      expect(out[0]).toMatchObject({ mimeType: 'image/jpeg', width: 40, height: 30, sortOrder: 0, isCover: true });
      expect(out[1]).toMatchObject({ mimeType: 'image/png', sortOrder: 1, isCover: false });
      expect(out[0].url).toBe(`/api/products/p1/images/${out[0].id}`);
      for (const row of prisma.productImage.rows) {
        expect(row.storageKey).toMatch(STORAGE_KEY_RE);
        expect(row.storageKey).not.toContain('a.jpg');
        expect(row.uploadedById).toBe('u1');
      }
      expect(photoFiles().sort()).toEqual(prisma.productImage.rows.map((r) => r.storageKey).sort());
    });

    it('opaque key format: 32 hex chars + the SNIFFED extension, whatever the client called it', async () => {
      await svc.upload('p1', [file('holiday.jpg', makeWebpVp8(10, 10))]);
      const key = prisma.productImage.rows[0].storageKey;
      expect(key).toMatch(/^[0-9a-f]{32}\.webp$/);
      expect(prisma.productImage.rows[0].mimeType).toBe('image/webp');
    });

    it('rejects by sniff: SVG/HTML named .jpg, and HEIC with its own message', async () => {
      await expect(svc.upload('p1', [file('evil.jpg', Buffer.from('<svg onload="alert(1)"/>'))])).rejects.toThrow(
        '"evil.jpg" is not a JPG, PNG or WebP image',
      );
      await expect(svc.upload('p1', [file('x.jpg', Buffer.from('<html><script></script></html>'))])).rejects.toThrow(
        BadRequestException,
      );
      await expect(svc.upload('p1', [file('IMG_1.jpg', makeHeic())])).rejects.toThrow(
        'HEIC photos are not supported — export as JPG',
      );
      await expect(svc.upload('p1', [file('big.png', makePng({ width: 12001, height: 10 }))])).rejects.toThrow(
        '"big.png" is larger than 12000 px',
      );
      expect(prisma.productImage.rows).toHaveLength(0);
      expect(photoFiles()).toHaveLength(0);
    });

    it('a bad file anywhere in the batch stores nothing', async () => {
      await expect(
        svc.upload('p1', [file('ok.png', makePng({ width: 4, height: 4 })), file('bad.jpg', Buffer.from('GIF89a......'))]),
      ).rejects.toThrow('"bad.jpg" is not a JPG, PNG or WebP image');
      expect(prisma.productImage.rows).toHaveLength(0);
      expect(photoFiles()).toHaveLength(0);
    });

    it('rejects by count: the 31st photo', async () => {
      for (let i = 0; i < 3; i++) {
        await svc.upload('p1', Array.from({ length: 10 }, (_, j) => file(`${i}-${j}.png`, makePng({ width: 2, height: 2 }))));
      }
      expect(prisma.productImage.rows).toHaveLength(30);
      await expect(svc.upload('p1', [file('31.png', makePng({ width: 2, height: 2 }))])).rejects.toThrow(
        'A product can have at most 30 photos',
      );
      expect(photoFiles()).toHaveLength(30);
    });

    it('rejects more than 10 files per request and an empty request', async () => {
      await expect(
        svc.upload('p1', Array.from({ length: 11 }, (_, j) => file(`${j}.png`, makePng({ width: 2, height: 2 })))),
      ).rejects.toThrow('Upload at most 10 photos at a time');
      await expect(svc.upload('p1', [])).rejects.toThrow('No files uploaded');
    });

    it('404 for an unknown product', async () => {
      await expect(svc.upload('nope', [file('a.png', makePng({ width: 2, height: 2 }))])).rejects.toThrow(NotFoundException);
    });

    it('decodes a UTF-8 Arabic name that multer delivered as latin1', async () => {
      const mangled = Buffer.from('صورة.jpg', 'utf8').toString('latin1');
      await svc.upload('p1', [file(mangled, makeJpeg({ width: 2, height: 2 }))]);
      expect(prisma.productImage.rows[0].originalName).toBe('صورة.jpg');
    });

    it('a row failure unlinks every file already written', async () => {
      prisma.productImage.failCreate = (d) =>
        d.sortOrder === 1 ? Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003' }) : null;
      await expect(
        svc.upload('p1', [file('a.png', makePng({ width: 2, height: 2 })), file('b.png', makePng({ width: 3, height: 3 }))]),
      ).rejects.toThrow('Foreign key constraint failed');
      expect(prisma.productImage.rows).toHaveLength(0);
      expect(photoFiles()).toHaveLength(0);
    });

    it('stores the STRIPPED bytes: a GPS JPEG is stored (and so served) without GPS; sizeBytes is the stripped length', async () => {
      const src = makeJpeg({ width: 100, height: 50, exif: true, orientation: 6, xmp: true });
      expect(has(src, 'GPS')).toBe(true);
      await svc.upload('p1', [file('gps.jpg', src)]);
      const row = prisma.productImage.rows[0];
      const stored = fs.readFileSync(imagePathForKey(row.storageKey)!);
      expect(has(stored, 'GPS')).toBe(false);
      expect(has(stored, 'http://ns.adobe.com/xap')).toBe(false);
      expect(row.sizeBytes).toBe(stored.length);
      expect(row.sizeBytes).toBeLessThan(src.length);
      expect(sniffImage(stored)).toMatchObject({ width: 100, height: 50 });
      // What G5 would serve is exactly that file.
      const served = await svc.resolveForServe('p1', row.id, { userType: 'customer', isApproved: true });
      expect(has(fs.readFileSync(served.absPath), 'GPS')).toBe(false);
    });
  });

  describe('sanitizeImageName', () => {
    it('strips control characters and path separators and trims to 120 chars', () => {
      const ctl = String.fromCharCode(0, 7, 0x1b);
      expect(sanitizeImageName(`../..${ctl}/etc\\passwd.jpg`)).toBe('....etcpasswd.jpg');
      expect(Array.from(sanitizeImageName('a'.repeat(300))).length).toBe(120);
      expect(sanitizeImageName('   ')).toBe('photo');
      expect(sanitizeImageName(undefined)).toBe('photo');
    });

    it('keeps a latin1 name that is not valid UTF-8 as it is', () => {
      expect(sanitizeImageName('café.jpg')).toBe('café.jpg');
    });
  });

  describe('reorder (G3)', () => {
    let ids: string[];
    beforeEach(async () => {
      const out = await svc.upload('p1', [1, 2, 3].map((n) => file(`${n}.png`, makePng({ width: n, height: n }))));
      ids = out.map((x) => x.id);
    });

    it('applies the order and the first becomes the cover', async () => {
      const out = await svc.reorder('p1', { imageIds: [ids[2], ids[0], ids[1]] });
      expect(out.map((x) => x.id)).toEqual([ids[2], ids[0], ids[1]]);
      expect(out[0].isCover).toBe(true);
    });

    it('requires the exact id set', async () => {
      const msg = 'imageIds must list every photo of this product exactly once';
      await expect(svc.reorder('p1', { imageIds: [ids[0], ids[1]] })).rejects.toThrow(msg);
      await expect(svc.reorder('p1', { imageIds: [ids[0], ids[1], ids[1]] })).rejects.toThrow(msg);
      await expect(svc.reorder('p1', { imageIds: [ids[0], ids[1], 'foreign'] })).rejects.toThrow(msg);
      await expect(svc.reorder('p1', { imageIds: [...ids, 'extra'] })).rejects.toThrow(msg);
      await expect(svc.reorder('p1', { imageIds: 'nope' })).rejects.toThrow(msg);
      await expect(svc.reorder('p1', null)).rejects.toThrow(msg);
      // Nothing moved.
      expect((await svc.list('p1')).map((x) => x.id)).toEqual(ids);
    });
  });

  describe('remove (G4)', () => {
    it('deletes the row, then unlinks the file', async () => {
      const [img] = await svc.upload('p1', [file('a.png', makePng({ width: 2, height: 2 }))]);
      expect(photoFiles()).toHaveLength(1);
      expect(await svc.remove('p1', img.id)).toEqual({ deleted: true });
      expect(prisma.productImage.rows).toHaveLength(0);
      expect(photoFiles()).toHaveLength(0);
    });

    it('does not unlink when the transaction fails', async () => {
      const [img] = await svc.upload('p1', [file('a.png', makePng({ width: 2, height: 2 }))]);
      const orig = prisma.productImage.deleteMany.bind(prisma.productImage);
      prisma.productImage.deleteMany = async () => {
        throw new Error('db down');
      };
      await expect(svc.remove('p1', img.id)).rejects.toThrow('db down');
      expect(photoFiles()).toHaveLength(1);
      prisma.productImage.deleteMany = orig;
    });

    it('a migrated photo also removes its legacy Attachment row and file', async () => {
      fs.mkdirSync(path.join(tmp, '2025', '01'), { recursive: true });
      const legacyRel = path.join('2025', '01', '1700-old.jpg');
      fs.writeFileSync(path.join(tmp, legacyRel), makeJpeg({ width: 2, height: 2 }));
      const att = await prisma.attachment.create({
        data: { entityType: 'product', entityId: 'p1', storagePath: legacyRel, filename: '1700-old.jpg', originalName: 'old.jpg', mimeType: 'image/jpeg', sizeBytes: 1 },
      });
      const [img] = await svc.upload('p1', [file('a.png', makePng({ width: 2, height: 2 }))]);
      prisma.productImage.rows[0].legacyAttachmentId = att.id;

      await svc.remove('p1', img.id);
      expect(prisma.attachment.rows).toHaveLength(0);
      expect(fs.existsSync(path.join(tmp, legacyRel))).toBe(false);
      expect(photoFiles()).toHaveLength(0);
    });

    it('404 for an image of another product or an unknown id', async () => {
      await prisma.product.create({ data: { id: 'p2', isActive: true } });
      const [img] = await svc.upload('p1', [file('a.png', makePng({ width: 2, height: 2 }))]);
      await expect(svc.remove('p2', img.id)).rejects.toThrow('Image not found');
      await expect(svc.remove('p1', 'nope')).rejects.toThrow('Image not found');
      expect(prisma.productImage.rows).toHaveLength(1);
    });
  });

  describe('list (G1)', () => {
    it('orders by sortOrder, createdAt, id and flags the cover', async () => {
      const t = new Date('2026-01-01T00:00:00Z');
      prisma.productImage.rows.push(
        { id: 'b', productId: 'p1', storageKey: 'b'.repeat(32) + '.png', mimeType: 'image/png', sizeBytes: 1, width: 1, height: 1, originalName: 'b', sortOrder: 1, createdAt: t },
        { id: 'a', productId: 'p1', storageKey: 'a'.repeat(32) + '.png', mimeType: 'image/png', sizeBytes: 1, width: 1, height: 1, originalName: 'a', sortOrder: 1, createdAt: t },
        { id: 'c', productId: 'p1', storageKey: 'c'.repeat(32) + '.png', mimeType: 'image/png', sizeBytes: 1, width: 1, height: 1, originalName: 'c', sortOrder: 0, createdAt: new Date(t.getTime() + 1) },
      );
      const out = await svc.list('p1');
      expect(out.map((x) => [x.id, x.isCover])).toEqual([['c', true], ['a', false], ['b', false]]);
    });
  });
});
