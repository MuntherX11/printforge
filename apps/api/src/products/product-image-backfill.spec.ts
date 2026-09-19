import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as imageSniff from '../common/utils/image-sniff';
import { makeJpeg, makePng } from '../common/utils/__fixtures__/test-images';
import { photoPrisma, PhotoPrisma } from './__fixtures__/photo-prisma';
import {
  BF2_CUTOFF_SETTING,
  LEGACY_SORT_MARKER,
  ProductImageBackfillService,
} from './product-image-backfill.service';
import { imagePathForKey } from './product-images.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fsp = require('fs/promises');

const T0 = new Date('2025-06-01T10:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const has = (buf: Buffer, s: string) => buf.includes(Buffer.from(s, 'latin1'));

describe('ProductImageBackfillService (BF-2)', () => {
  let tmp: string;
  let prisma: PhotoPrisma;
  let svc: ProductImageBackfillService;
  const oldDir = process.env.UPLOAD_DIR;
  let minute = 0;

  const photoFiles = () => {
    const dir = path.join(tmp, 'product-images');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };

  /** Writes a legacy file (unless `content` is null) and its Attachment row. */
  async function legacy(opts: {
    productId?: string;
    name?: string;
    content?: Buffer | null;
    storagePath?: string;
    mimeType?: string;
    originalName?: string;
    createdAt?: Date;
  }) {
    const name = opts.name ?? `${1700000000000 + minute}-photo.jpg`;
    const storagePath = opts.storagePath ?? path.join('2025', '06', '01', name);
    if (opts.content !== null) {
      const abs = path.join(tmp, storagePath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, opts.content ?? makeJpeg({ width: 30, height: 20, exif: true, orientation: 6 }));
    }
    return prisma.attachment.create({
      data: {
        entityType: 'product',
        entityId: opts.productId ?? 'p1',
        filename: name,
        originalName: opts.originalName ?? name,
        mimeType: opts.mimeType ?? 'image/jpeg',
        sizeBytes: 1,
        storagePath,
        uploadedById: 'u1',
        createdAt: opts.createdAt ?? at(minute++),
      },
    });
  }

  const marked = (id: string) => prisma.attachment.rows.find((a) => a.id === id)!.photoMigratedAt != null;

  beforeEach(async () => {
    minute = 0;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-bf2-'));
    process.env.UPLOAD_DIR = tmp;
    prisma = photoPrisma();
    await prisma.product.create({ data: { id: 'p1', isActive: true, imageUrl: null } });
    // Cutoff after every legacy row in these tests.
    await prisma.systemSetting.create({ data: { key: BF2_CUTOFF_SETTING, value: at(10_000).toISOString() } });
    svc = new ProductImageBackfillService(prisma as any);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env.UPLOAD_DIR = oldDir;
  });

  it('creates images, stripped of GPS, with the legacy cover (imageUrl) first', async () => {
    const a = await legacy({});
    const b = await legacy({});
    const c = await legacy({});
    prisma.product.rows[0].imageUrl = b.storagePath;

    const counts = await svc.run();
    expect(counts).toEqual({ created: 3, skipped: 0, failed: 0 });
    const imgs = [...prisma.productImage.rows].sort((x, y) => x.sortOrder - y.sortOrder);
    expect(imgs.map((i) => i.legacyAttachmentId)).toEqual([b.id, a.id, c.id]);
    expect(imgs.map((i) => i.sortOrder)).toEqual([0, 1, 2]);
    for (const i of imgs) {
      const stored = fs.readFileSync(imagePathForKey(i.storageKey)!);
      expect(has(stored, 'GPS')).toBe(false);
      expect(i.sizeBytes).toBe(stored.length);
      expect(i).toMatchObject({ productId: 'p1', mimeType: 'image/jpeg', width: 30, height: 20, uploadedById: 'u1' });
    }
    expect([a, b, c].every((x) => marked(x.id))).toBe(true);
    // Legacy rows and files stay for rollback.
    expect(prisma.attachment.rows).toHaveLength(3);
    expect(fs.existsSync(path.join(tmp, a.storagePath))).toBe(true);
  });

  it('links a plate thumbnail to the component with the matching sortOrder, never a ProductImage', async () => {
    const t = at(5);
    const comp1 = await prisma.productComponent.create({ data: { productId: 'p1', variantId: null, sortOrder: 1, createdAt: at(4) } });
    const comp2 = await prisma.productComponent.create({ data: { productId: 'p1', variantId: null, sortOrder: 2, createdAt: at(4) } });
    const thumb = await legacy({
      name: 'plate-2-1717236000000.png',
      originalName: 'Plate 2 thumbnail',
      mimeType: 'image/png',
      content: makePng({ width: 64, height: 64 }),
      createdAt: t,
    });

    await svc.run();
    expect(prisma.productImage.rows).toHaveLength(0);
    expect(marked(thumb.id)).toBe(true);
    expect(prisma.productComponent.rows.find((c) => c.id === comp2.id)!.thumbnailAttachmentId).toBe(thumb.id);
    expect(prisma.productComponent.rows.find((c) => c.id === comp1.id)!.thumbnailAttachmentId).toBeNull();
  });

  it('skips (marks) a traversal storagePath without touching it', async () => {
    const a = await legacy({ storagePath: '../../etc/passwd', content: null });
    const counts = await svc.run();
    expect(marked(a.id)).toBe(true);
    expect(counts.created).toBe(0);
    expect(prisma.productImage.rows).toHaveLength(0);
  });

  it('skips (marks) SVG and GIF even when stored as image/*', async () => {
    const svg = await legacy({ name: 'x.svg', mimeType: 'image/svg+xml', content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
    const gif = await legacy({ name: 'x.gif', mimeType: 'image/gif', content: Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00', 'latin1') });
    const counts = await svc.run();
    expect(marked(svg.id) && marked(gif.id)).toBe(true);
    expect(counts).toEqual({ created: 0, skipped: 2, failed: 0 });
    expect(photoFiles()).toHaveLength(0);
  });

  it('migrates a legacy photo stored as application/octet-stream that sniffs as JPEG', async () => {
    const a = await legacy({ mimeType: 'application/octet-stream' });
    const sniff = jest.spyOn(imageSniff, 'readImageHeader');
    await svc.run();
    expect(sniff).toHaveBeenCalled(); // decided from the bytes (and proves the spy binds)
    expect(prisma.productImage.rows).toHaveLength(1);
    expect(prisma.productImage.rows[0]).toMatchObject({ legacyAttachmentId: a.id, mimeType: 'image/jpeg' });
  });

  it('marks an attachment referenced by ProductComponent.attachmentId without sniffing it', async () => {
    const a = await legacy({});
    await prisma.productComponent.create({ data: { productId: 'p1', attachmentId: a.id } });
    const sniff = jest.spyOn(imageSniff, 'readImageHeader');
    const stat = jest.spyOn(fsp, 'stat');
    await svc.run();
    expect(marked(a.id)).toBe(true);
    expect(sniff).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    expect(prisma.productImage.rows).toHaveLength(0);
  });

  it('also treats PlateLayout and JobPlate references as slicer files', async () => {
    const a = await legacy({});
    const b = await legacy({});
    await prisma.plateLayout.create({ data: { attachmentId: a.id } });
    await prisma.jobPlate.create({ data: { attachmentId: b.id } });
    await svc.run();
    expect(marked(a.id) && marked(b.id)).toBe(true);
    expect(prisma.productImage.rows).toHaveLength(0);
  });

  it('never considers an attachment created after the cutoff', async () => {
    const late = await legacy({ createdAt: at(20_000) });
    const counts = await svc.run();
    expect(counts).toEqual({ created: 0, skipped: 0, failed: 0 });
    expect(marked(late.id)).toBe(false);
  });

  it('creates the cutoff on the first run and keeps it', async () => {
    prisma.systemSetting.rows = [];
    await svc.run();
    const first = prisma.systemSetting.rows.find((s) => s.key === BF2_CUTOFF_SETTING)!.value;
    expect(new Date(first).getTime()).not.toBeNaN();
    await svc.run();
    expect(prisma.systemSetting.rows.filter((s) => s.key === BF2_CUTOFF_SETTING)).toHaveLength(1);
    expect(prisma.systemSetting.rows.find((s) => s.key === BF2_CUTOFF_SETTING)!.value).toBe(first);
  });

  it('marks an orphan (product missing), writes nothing, and carries on past it', async () => {
    const orphan = await legacy({ productId: 'gone' });
    const ok = await legacy({});
    const counts = await svc.run();
    expect(marked(orphan.id)).toBe(true);
    expect(counts).toEqual({ created: 1, skipped: 1, failed: 0 });
    expect(prisma.productImage.rows.map((i) => i.legacyAttachmentId)).toEqual([ok.id]);
    expect(photoFiles()).toHaveLength(1);
  });

  it('EACCES on one file: left unmarked, failed++, later rows still processed, nothing written for it', async () => {
    const denied = await legacy({});
    const ok = await legacy({});
    const realStat = fsp.stat;
    jest.spyOn(fsp, 'stat').mockImplementation(async (...args: any[]) => {
      if (String(args[0]).endsWith(path.basename(denied.storagePath))) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return realStat(...args);
    });
    const counts = await svc.run();
    expect(counts).toEqual({ created: 1, skipped: 0, failed: 1 });
    expect(marked(denied.id)).toBe(false);
    expect(marked(ok.id)).toBe(true);
    expect(photoFiles()).toHaveLength(1);
  });

  it('a ProductImage.create failure (P2003 or a thrown error) unlinks the written file and leaves the row unmarked', async () => {
    const a = await legacy({});
    const b = await legacy({});
    prisma.productImage.failCreate = (d) =>
      d.legacyAttachmentId === a.id
        ? Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003' })
        : new Error('boom');
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const counts = await svc.run();
    expect(counts).toEqual({ created: 0, skipped: 0, failed: 2 });
    expect(photoFiles()).toHaveLength(0);
    expect(marked(a.id) || marked(b.id)).toBe(false);

    prisma.productImage.failCreate = null;
    expect((await svc.run()).created).toBe(2); // retried on the next boot
  });

  it('missing volume: 10 of 10 files ENOENT in the first batch aborts with an error; no row marked', async () => {
    const rows = [];
    for (let i = 0; i < 10; i++) rows.push(await legacy({ content: null }));
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const counts = await svc.run();
    expect(counts.created).toBe(0);
    expect(rows.some((r) => marked(r.id))).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('is the uploads volume mounted?'));
  });

  it('a single missing file is not marked (retried next boot) and does not abort', async () => {
    const gone = await legacy({ content: null });
    const ok = await legacy({});
    const counts = await svc.run();
    expect(marked(gone.id)).toBe(false);
    expect(marked(ok.id)).toBe(true);
    expect(counts.created).toBe(1);
  });

  it('crash before normalisation: marker rows are normalised on the next run, cover from imageUrl', async () => {
    const a = await legacy({});
    const b = await legacy({});
    // State left by a run that created the images and then crashed.
    for (const [att, min] of [[a, 1], [b, 2]] as const) {
      prisma.attachment.rows.find((x) => x.id === att.id)!.photoMigratedAt = new Date();
      await prisma.productImage.create({
        data: {
          productId: 'p1', storageKey: `${String(min).repeat(32)}.jpg`, mimeType: 'image/jpeg', sizeBytes: 1, width: 1, height: 1,
          originalName: 'x', sortOrder: LEGACY_SORT_MARKER, legacyAttachmentId: att.id, createdAt: at(min),
        },
      });
    }
    prisma.product.rows[0].imageUrl = b.storagePath;
    const counts = await svc.run();
    expect(counts.created).toBe(0);
    const order = [...prisma.productImage.rows].sort((x, y) => x.sortOrder - y.sortOrder);
    expect(order.map((i) => [i.legacyAttachmentId, i.sortOrder])).toEqual([[b.id, 0], [a.id, 1]]);
  });

  it('a second run creates 0', async () => {
    await legacy({});
    await legacy({});
    expect((await svc.run()).created).toBe(2);
    expect(await svc.run()).toEqual({ created: 0, skipped: 0, failed: 0 });
    expect(prisma.productImage.rows).toHaveLength(2);
    expect(photoFiles()).toHaveLength(2);
  });

  it('a deleted ProductImage is not re-imported', async () => {
    await legacy({});
    await svc.run();
    prisma.productImage.rows = [];
    expect((await svc.run()).created).toBe(0);
    expect(prisma.productImage.rows).toHaveLength(0);
  });

  it("the owner's reorder survives a re-run", async () => {
    await legacy({});
    await legacy({});
    await legacy({});
    await svc.run();
    const imgs = prisma.productImage.rows;
    const wanted = [imgs[2].id, imgs[0].id, imgs[1].id];
    wanted.forEach((id, i) => (imgs.find((x) => x.id === id)!.sortOrder = i));
    await svc.run();
    const now = [...prisma.productImage.rows].sort((x, y) => x.sortOrder - y.sortOrder).map((x) => x.id);
    expect(now).toEqual(wanted);
  });

  it('continues past a batch of 50 (keyset pagination) without re-reading marked rows', async () => {
    for (let i = 0; i < 55; i++) await legacy({ content: Buffer.from('not an image') });
    const counts = await svc.run();
    expect(counts).toEqual({ created: 0, skipped: 55, failed: 0 });
  });

  it('boot hook never rejects even when the DB is down', async () => {
    prisma.$queryRaw = async () => {
      throw new Error('db down');
    };
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    svc.onApplicationBootstrap();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 10));
    expect(error).toHaveBeenCalled();
  });
});
