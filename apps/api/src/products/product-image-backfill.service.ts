import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../common/prisma/prisma.service';
import { BackfillCounts, runBackfill } from '../common/utils/backfill-runner';
import { MAX_IMAGE_SIDE, readImageHeader, sniffImage, stripImageMetadata } from '../common/utils/image-sniff';
import {
  containedUploadPath,
  imagePathForKey,
  MAX_PHOTO_BYTES,
  newStorageKey,
  PRODUCT_IMAGE_DIR,
  sanitizeImageName,
  uploadDir,
} from './product-images.service';

export const BF2_KEY = 'product-photos-v1';
export const BF2_CUTOFF_SETTING = 'backfill:product-photos-v1:cutoff';
/** "Not yet normalised" marker for migrated photos (§2.4). */
export const LEGACY_SORT_MARKER = 1_000_000;

const BATCH = 50;
/** Head read for files too big to be a photo. */
const HEAD_BYTES = 64 * 1024;
const TX_OPTS = { timeout: 30_000, maxWait: 10_000 };

class Skip extends Error {}

interface LegacyAttachment {
  id: string;
  filename: string;
  originalName: string;
  storagePath: string;
  entityId: string;
  uploadedById: string | null;
  createdAt: Date;
}

/**
 * BF-2 (§2.4): turns legacy product-photo Attachments into ProductImage rows,
 * links legacy 3MF plate renders to their component, and marks everything else.
 *
 * One-shot over rows created before the stored cutoff, idempotent, resumable and
 * safe on every boot:
 * - every item claims itself with a guarded `photoMigratedAt` update;
 * - a missing file (ENOENT) and I/O errors leave the row UNMARKED so the next
 *   boot retries it (a mis-mounted volume must not skip photos forever);
 * - the first batch aborts the run when more than half its files are missing;
 * - what a file is comes from its bytes and references, never its stored mimeType.
 */
@Injectable()
export class ProductImageBackfillService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ProductImageBackfillService.name);

  constructor(private prisma: PrismaService) {}

  onApplicationBootstrap() {
    setImmediate(() => {
      runBackfill(this.prisma, this.logger, BF2_KEY, (renew) => this.run(renew)).catch((e) =>
        this.logger.error(e?.message, e?.stack),
      );
    });
  }

  async run(renewLease: () => Promise<void> = async () => undefined): Promise<BackfillCounts> {
    const counts: BackfillCounts = { created: 0, skipped: 0, failed: 0 };
    const cutoff = await this.getCutoff();
    const referenced = await this.loadReferenced();
    const root = uploadDir();

    let last: { createdAt: Date; id: string } | null = null;
    let firstBatch = true;
    for (;;) {
      await renewLease();
      // Keyset pagination on (createdAt, id). Marked rows drop out of the filter,
      // so a Prisma `cursor` + `skip: 1` could skip a live row; the keyset can't.
      const rows = (await this.prisma.attachment.findMany({
        where: {
          entityType: 'product',
          photoMigratedAt: null,
          createdAt: { lt: cutoff },
          ...(last
            ? { OR: [{ createdAt: { gt: last.createdAt } }, { createdAt: last.createdAt, id: { gt: last.id } }] }
            : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: BATCH,
        select: {
          id: true, filename: true, originalName: true, storagePath: true,
          entityId: true, uploadedById: true, createdAt: true,
        },
      })) as LegacyAttachment[];
      if (rows.length === 0) break;
      last = { createdAt: rows[rows.length - 1].createdAt, id: rows[rows.length - 1].id };

      let missing = 0;
      for (const a of rows) {
        try {
          const r = await this.processOne(a, referenced, root);
          if (r === 'created') counts.created++;
          else if (r === 'missing') missing++;
          else if (r === 'failed') counts.failed++;
          else counts.skipped++;
        } catch (e) {
          counts.failed++;
          this.logger.error(`${BF2_KEY}: attachment ${a.id} failed: ${(e as Error)?.message}`, (e as Error)?.stack);
        }
      }

      if (firstBatch && rows.length >= 10 && missing / rows.length > 0.5) {
        this.logger.error(
          `${BF2_KEY}: ${missing} of ${rows.length} legacy files are missing — is the uploads volume mounted? Aborting; nothing was marked as missing.`,
        );
        return counts;
      }
      firstBatch = false;
    }

    await this.normalise();
    return counts;
  }

  private async processOne(
    a: LegacyAttachment,
    referenced: Set<string>,
    root: string,
  ): Promise<'created' | 'skipped' | 'missing' | 'failed'> {
    if (referenced.has(a.id)) return this.mark(a, 'slicer file or plate render');

    const product = await this.prisma.product.findUnique({ where: { id: a.entityId }, select: { id: true } });
    if (!product) return this.mark(a, `orphan: product ${a.entityId} not found`);

    const abs = containedUploadPath(a.storagePath);
    if (!abs || !abs.startsWith(root + path.sep)) return this.mark(a, 'unsafe path');

    const plate = /^plate-(\d+)-\d+\.png$/.exec(a.filename || '');
    if (plate && /^Plate \d+ thumbnail$/.test(a.originalName || '')) {
      await this.linkPlateThumbnail(a, Number(plate[1]));
      return 'skipped';
    }

    let size: number;
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) {
        this.logger.warn(`${BF2_KEY}: attachment ${a.id}: not a regular file — will retry next boot`);
        return 'failed';
      }
      size = st.size;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        this.logger.warn(`${BF2_KEY}: attachment ${a.id}: missing file — will retry next boot`);
        return 'missing';
      }
      this.logger.warn(`${BF2_KEY}: attachment ${a.id}: ${code || (e as Error)?.message} — will retry next boot`);
      return 'failed';
    }

    // A photo-sized file is read whole (its SOF may sit behind a large Exif
    // block); anything bigger is only sniffed from its head to name the reason.
    let bytes: Buffer;
    try {
      bytes = size <= MAX_PHOTO_BYTES ? await fs.readFile(abs) : await this.readHead(abs);
    } catch (e) {
      this.logger.warn(`${BF2_KEY}: attachment ${a.id}: ${(e as Error)?.message} — will retry next boot`);
      return 'failed';
    }
    const header = readImageHeader(bytes);
    if (!header) return this.mark(a, 'not jpg/png/webp');
    const sniff = sniffImage(bytes);
    if (!sniff || size > MAX_PHOTO_BYTES || header.width > MAX_IMAGE_SIDE || header.height > MAX_IMAGE_SIDE) {
      return this.mark(a, 'too large');
    }
    const clean = stripImageMetadata(bytes, sniff);
    if (!clean) return this.mark(a, 'unprocessable');

    const key = newStorageKey(sniff.ext);
    const dest = imagePathForKey(key);
    if (!dest) return 'failed';
    try {
      await fs.mkdir(path.join(root, PRODUCT_IMAGE_DIR), { recursive: true });
      await fs.writeFile(dest, clean, { flag: 'wx' });
    } catch (e) {
      await fs.unlink(dest).catch(() => undefined);
      this.logger.error(`${BF2_KEY}: attachment ${a.id}: could not write the photo: ${(e as Error)?.message}`);
      return 'failed';
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.attachment.updateMany({
          where: { id: a.id, photoMigratedAt: null },
          data: { photoMigratedAt: new Date() },
        });
        if (claimed.count !== 1) throw new Skip('claimed by another runner');
        await tx.productImage.create({
          data: {
            productId: a.entityId,
            storageKey: key,
            mimeType: sniff.mime,
            sizeBytes: clean.length,
            width: sniff.width,
            height: sniff.height,
            originalName: sanitizeImageName(a.originalName),
            sortOrder: LEGACY_SORT_MARKER,
            legacyAttachmentId: a.id,
            uploadedById: a.uploadedById ?? null,
          },
        });
      }, TX_OPTS);
      return 'created';
    } catch (e) {
      await fs.unlink(dest).catch(() => undefined);
      if (e instanceof Skip || (e as { code?: string })?.code === 'P2002') {
        this.logger.log(`${BF2_KEY}: attachment ${a.id}: skipped (${(e as Error).message})`);
        return 'skipped';
      }
      this.logger.error(`${BF2_KEY}: attachment ${a.id}: could not create the photo: ${(e as Error)?.message}`);
      return 'failed';
    }
  }

  /** Legacy 3MF plate render: link to the matching standard component, never a photo. */
  private async linkPlateThumbnail(a: LegacyAttachment, plateIndex: number) {
    const t = new Date(a.createdAt).getTime();
    const window = 10 * 60 * 1000;
    const candidates = await this.prisma.productComponent.findMany({
      where: {
        productId: a.entityId,
        variantId: null,
        sortOrder: plateIndex,
        thumbnailAttachmentId: null,
        createdAt: { gte: new Date(t - window), lte: new Date(t + window) },
      },
      select: { id: true },
    });
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.attachment.updateMany({
        where: { id: a.id, photoMigratedAt: null },
        data: { photoMigratedAt: new Date() },
      });
      if (claimed.count !== 1) return;
      if (candidates.length === 1) {
        await tx.productComponent.updateMany({
          where: { id: candidates[0].id, thumbnailAttachmentId: null },
          data: { thumbnailAttachmentId: a.id },
        });
      }
    }, TX_OPTS);
    this.logger.log(
      `${BF2_KEY}: attachment ${a.id}: plate ${plateIndex} render ${
        candidates.length === 1 ? `linked to component ${candidates[0].id}` : `not linked (${candidates.length} candidates)`
      }`,
    );
  }

  private async mark(a: LegacyAttachment, reason: string): Promise<'skipped'> {
    await this.prisma.attachment.updateMany({
      where: { id: a.id, photoMigratedAt: null },
      data: { photoMigratedAt: new Date() },
    });
    this.logger.log(`${BF2_KEY}: attachment ${a.id}: ${reason}`);
    return 'skipped';
  }

  private async getCutoff(): Promise<Date> {
    const read = () => this.prisma.systemSetting.findUnique({ where: { key: BF2_CUTOFF_SETTING } });
    let row = await read();
    if (!row) {
      try {
        row = await this.prisma.systemSetting.create({
          data: { key: BF2_CUTOFF_SETTING, value: new Date().toISOString() },
        });
      } catch (e) {
        if ((e as { code?: string })?.code !== 'P2002') throw e;
        row = await read();
      }
    }
    const cutoff = new Date(row?.value ?? '');
    if (Number.isNaN(cutoff.getTime())) throw new Error(`${BF2_CUTOFF_SETTING} is not a date: ${row?.value}`);
    return cutoff;
  }

  private async loadReferenced(): Promise<Set<string>> {
    const [components, layouts, plates] = await Promise.all([
      this.prisma.productComponent.findMany({
        where: { OR: [{ attachmentId: { not: null } }, { thumbnailAttachmentId: { not: null } }] },
        select: { attachmentId: true, thumbnailAttachmentId: true },
      }),
      this.prisma.plateLayout.findMany({ where: { attachmentId: { not: null } }, select: { attachmentId: true } }),
      this.prisma.jobPlate.findMany({ where: { attachmentId: { not: null } }, select: { attachmentId: true } }),
    ]);
    const ids = new Set<string>();
    for (const c of components) {
      if (c.attachmentId) ids.add(c.attachmentId);
      if (c.thumbnailAttachmentId) ids.add(c.thumbnailAttachmentId);
    }
    for (const r of [...layouts, ...plates]) if (r.attachmentId) ids.add(r.attachmentId);
    return ids;
  }

  private async readHead(abs: string): Promise<Buffer> {
    const fh = await fs.open(abs, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close().catch(() => undefined);
    }
  }

  /**
   * Gives migrated photos real positions: the legacy cover (`imageUrl`) first,
   * then the other legacy photos by age, then photos added since. Reads the DB,
   * so a crash before this step is repaired on the next boot, and only touches
   * products that still have marker rows, so the owner's reordering survives.
   */
  async normalise(): Promise<void> {
    const pending = await this.prisma.productImage.findMany({
      where: { sortOrder: LEGACY_SORT_MARKER },
      distinct: ['productId'],
      select: { productId: true },
    });
    for (const { productId } of pending) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const imgs = await tx.productImage.findMany({
            where: { productId },
            select: { id: true, sortOrder: true, createdAt: true, legacyAttachmentId: true },
          });
          const product = await tx.product.findUnique({ where: { id: productId }, select: { imageUrl: true } });
          const legacy = imgs.filter((i) => i.legacyAttachmentId && i.sortOrder === LEGACY_SORT_MARKER);
          const others = imgs.filter((i) => !legacy.includes(i));
          const atts = legacy.length
            ? await tx.attachment.findMany({
                where: { id: { in: legacy.map((i) => i.legacyAttachmentId as string) } },
                select: { id: true, storagePath: true },
              })
            : [];
          const norm = (p: string | null | undefined) => (p ?? '').replace(/\\/g, '/');
          const coverAtt = product?.imageUrl
            ? atts.find((x) => norm(x.storagePath) === norm(product.imageUrl))
            : undefined;
          const cover = coverAtt ? legacy.find((i) => i.legacyAttachmentId === coverAtt.id) : undefined;
          const byAge = (x: { createdAt: Date; id: string }, y: { createdAt: Date; id: string }) =>
            new Date(x.createdAt).getTime() - new Date(y.createdAt).getTime() || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
          const ordered = [
            ...(cover ? [cover] : []),
            ...legacy.filter((i) => i !== cover).sort(byAge),
            ...others.sort((x, y) => x.sortOrder - y.sortOrder || byAge(x, y)),
          ];
          for (let i = 0; i < ordered.length; i++) {
            if (ordered[i].sortOrder !== i) {
              await tx.productImage.update({ where: { id: ordered[i].id }, data: { sortOrder: i } });
            }
          }
        }, TX_OPTS);
      } catch (e) {
        this.logger.error(`${BF2_KEY}: could not order photos of product ${productId}: ${(e as Error)?.message}`);
      }
    }
  }
}
