import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  IMAGE_MIME_BY_EXT,
  ImageExt,
  isHeic,
  MAX_IMAGE_SIDE,
  readImageHeader,
  sniffImage,
  stripImageMetadata,
} from '../common/utils/image-sniff';

/** §3.11 limits. */
export const MAX_PHOTOS_PER_PRODUCT = 30;
export const MAX_PHOTOS_PER_REQUEST = 10;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Sub-directory of UPLOAD_DIR that holds product photos. */
export const PRODUCT_IMAGE_DIR = 'product-images';

/** The only shape a stored photo key may have. The path is built from this and nothing else. */
export const STORAGE_KEY_RE = /^[a-z0-9]{20,40}\.(jpg|png|webp)$/;

/** Same body for every "you can't see this image" case, so nothing leaks through status or text. */
export const IMAGE_NOT_FOUND = 'Image not found';

export function uploadDir(): string {
  return path.resolve(process.env.UPLOAD_DIR || '/app/uploads');
}

/** Server-generated opaque key: 32 lowercase hex chars + sniffed extension. */
export function newStorageKey(ext: ImageExt): string {
  return `${randomBytes(16).toString('hex')}.${ext}`;
}

/**
 * Absolute path of a stored photo, or null when the key isn't a well-formed
 * opaque key or escapes the photo directory. Never built from client input or
 * from the legacy product image-URL column.
 */
export function imagePathForKey(storageKey: string): string | null {
  if (typeof storageKey !== 'string' || !STORAGE_KEY_RE.test(storageKey)) return null;
  const root = path.join(uploadDir(), PRODUCT_IMAGE_DIR);
  const abs = path.resolve(root, storageKey);
  return abs.startsWith(root + path.sep) ? abs : null;
}

/** Resolves a legacy attachment's storagePath inside UPLOAD_DIR, or null if it escapes. */
export function containedUploadPath(storagePath: string | null | undefined): string | null {
  if (typeof storagePath !== 'string' || !storagePath) return null;
  const root = uploadDir();
  const abs = path.resolve(root, storagePath);
  return abs.startsWith(root + path.sep) ? abs : null;
}

/**
 * Display-only file name (§3.11): multer hands over the name as latin1, so a
 * UTF-8 name (Arabic, emoji) arrives mangled; decode it back when that yields
 * valid UTF-8. Control characters and path separators are removed and the
 * result is trimmed to 120 characters. Never used in a path.
 */
export function sanitizeImageName(raw: unknown): string {
  let name = typeof raw === 'string' ? raw : '';
  if (name && /^[\x00-\xff]*$/.test(name)) {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    if (!decoded.includes(String.fromCharCode(0xfffd))) name = decoded;
  }
  name = Array.from(name)
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return !(c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || ch === '/' || ch === String.fromCharCode(0x5c));
    })
    .join('')
    .trim();
  const chars = Array.from(name);
  if (chars.length > 120) name = chars.slice(0, 120).join('').trim();
  return name || 'photo';
}

export interface ImageRow {
  id: string;
  productId: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  originalName: string;
  sortOrder: number;
  createdAt: Date;
  legacyAttachmentId?: string | null;
}

/** Cover rule (§3.11): lowest sortOrder, then createdAt, then id. */
export function compareImages(a: ImageRow, b: ImageRow): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  const t = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  if (t !== 0) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface UploadedPhoto {
  originalname: string;
  buffer: Buffer;
  size?: number;
}

export interface ServableImage {
  absPath: string;
  mime: string;
  ext: ImageExt;
}

interface RequestUser {
  userType?: string;
  isApproved?: boolean;
}

const TX_OPTS = { timeout: 30_000, maxWait: 10_000 };

@Injectable()
export class ProductImagesService {
  private readonly logger = new Logger(ProductImagesService.name);

  constructor(private prisma: PrismaService) {}

  toDto(img: ImageRow, isCover: boolean) {
    return {
      id: img.id,
      url: `/api/products/${img.productId}/images/${img.id}`,
      originalName: img.originalName,
      mimeType: img.mimeType,
      width: img.width,
      height: img.height,
      sizeBytes: img.sizeBytes,
      sortOrder: img.sortOrder,
      isCover,
    };
  }

  private async assertProduct(productId: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!product) throw new NotFoundException('Product not found');
  }

  /** G1: every photo of a product, cover first. */
  async list(productId: string) {
    await this.assertProduct(productId);
    const rows = (await this.prisma.productImage.findMany({ where: { productId } })) as ImageRow[];
    return rows.sort(compareImages).map((r, i) => this.toDto(r, i === 0));
  }

  /**
   * G2: sniff, strip, write, then create every row in one transaction. Any
   * failure after writing unlinks every file this request wrote.
   */
  async upload(productId: string, files: UploadedPhoto[], uploadedById?: string | null) {
    if (!Array.isArray(files) || files.length === 0) throw new BadRequestException('No files uploaded');
    if (files.length > MAX_PHOTOS_PER_REQUEST) {
      throw new BadRequestException(`Upload at most ${MAX_PHOTOS_PER_REQUEST} photos at a time`);
    }
    await this.assertProduct(productId);

    const existing = await this.prisma.productImage.count({ where: { productId } });
    if (existing + files.length > MAX_PHOTOS_PER_PRODUCT) {
      throw new BadRequestException(`A product can have at most ${MAX_PHOTOS_PER_PRODUCT} photos`);
    }

    // Validate and strip everything before touching the disk.
    const prepared = files.map((f) => {
      const name = sanitizeImageName(f?.originalname);
      const buf = f?.buffer;
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        throw new BadRequestException(`"${name}" is not a JPG, PNG or WebP image`);
      }
      if (buf.length > MAX_PHOTO_BYTES) throw new BadRequestException(`"${name}" is over 10 MB`);
      if (isHeic(buf)) throw new BadRequestException('HEIC photos are not supported — export as JPG');
      const header = readImageHeader(buf);
      if (!header) throw new BadRequestException(`"${name}" is not a JPG, PNG or WebP image`);
      if (header.width > MAX_IMAGE_SIDE || header.height > MAX_IMAGE_SIDE) {
        throw new BadRequestException(`"${name}" is larger than ${MAX_IMAGE_SIDE} px`);
      }
      const sniff = sniffImage(buf);
      if (!sniff) throw new BadRequestException(`"${name}" is not a JPG, PNG or WebP image`);
      const clean = stripImageMetadata(buf, sniff);
      if (!clean) throw new BadRequestException(`"${name}" couldn't be processed`);
      return { name, sniff, clean, key: newStorageKey(sniff.ext) };
    });

    const dir = path.join(uploadDir(), PRODUCT_IMAGE_DIR);
    const written: string[] = [];
    let created: ImageRow[];
    try {
      await fs.mkdir(dir, { recursive: true });
      for (const p of prepared) {
        const abs = imagePathForKey(p.key);
        if (!abs) throw new BadRequestException(`"${p.name}" couldn't be processed`);
        await fs.writeFile(abs, p.clean, { flag: 'wx' });
        written.push(abs);
      }

      created = await this.prisma.$transaction(async (tx) => {
        // Re-count inside the transaction: two concurrent uploads must not pass 30 together.
        const count = await tx.productImage.count({ where: { productId } });
        if (count + prepared.length > MAX_PHOTOS_PER_PRODUCT) {
          throw new BadRequestException(`A product can have at most ${MAX_PHOTOS_PER_PRODUCT} photos`);
        }
        const agg = await tx.productImage.aggregate({ where: { productId }, _max: { sortOrder: true } });
        const base = count === 0 ? 0 : (agg._max.sortOrder ?? -1) + 1;
        const rows: ImageRow[] = [];
        for (let i = 0; i < prepared.length; i++) {
          const p = prepared[i];
          rows.push(
            (await tx.productImage.create({
              data: {
                productId,
                storageKey: p.key,
                mimeType: p.sniff.mime,
                sizeBytes: p.clean.length,
                width: p.sniff.width,
                height: p.sniff.height,
                originalName: p.name,
                sortOrder: base + i,
                uploadedById: uploadedById ?? null,
              },
            })) as ImageRow,
          );
        }
        return rows;
      }, TX_OPTS);
    } catch (e) {
      await Promise.all(written.map((abs) => this.unlinkQuietly(abs)));
      throw e;
    }

    const all = await this.list(productId);
    const coverId = all[0]?.id;
    return created.map((r) => this.toDto(r, r.id === coverId));
  }

  /** G3: `imageIds` must be exactly the product's image id set; index becomes sortOrder. */
  async reorder(productId: string, body: unknown) {
    const imageIds = (body as { imageIds?: unknown } | null)?.imageIds;
    const bad = () =>
      new BadRequestException('imageIds must list every photo of this product exactly once');
    if (!Array.isArray(imageIds) || imageIds.length > MAX_PHOTOS_PER_PRODUCT * 4) throw bad();
    if (!imageIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)) throw bad();
    await this.assertProduct(productId);

    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.productImage.findMany({ where: { productId }, select: { id: true } });
      const current = new Set(rows.map((r) => r.id));
      const sent = new Set(imageIds as string[]);
      if (sent.size !== imageIds.length || sent.size !== current.size) throw bad();
      for (const id of sent) if (!current.has(id)) throw bad();
      for (let i = 0; i < imageIds.length; i++) {
        await tx.productImage.update({ where: { id: imageIds[i] as string }, data: { sortOrder: i } });
      }
    }, TX_OPTS);
    return this.list(productId);
  }

  /**
   * G4: one transaction deletes the photo and, for a migrated photo, its legacy
   * Attachment row. Files are unlinked only after commit.
   */
  async remove(productId: string, imageId: string) {
    const img = (await this.prisma.productImage.findFirst({ where: { id: imageId, productId } })) as ImageRow | null;
    if (!img) throw new NotFoundException(IMAGE_NOT_FOUND);

    let legacyPath: string | null = null;
    await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.productImage.deleteMany({ where: { id: img.id, productId } });
      if (deleted.count !== 1) throw new NotFoundException(IMAGE_NOT_FOUND);
      if (img.legacyAttachmentId) {
        const att = await tx.attachment.findUnique({
          where: { id: img.legacyAttachmentId },
          select: { id: true, storagePath: true },
        });
        if (att) {
          await tx.attachment.delete({ where: { id: att.id } });
          legacyPath = containedUploadPath(att.storagePath);
        }
      }
    }, TX_OPTS);

    const abs = imagePathForKey(img.storageKey);
    if (abs) await this.unlinkQuietly(abs);
    if (legacyPath) await this.unlinkQuietly(legacyPath);
    return { deleted: true };
  }

  /**
   * G5 authorisation (§4.6 matrix). Runs on every request, including
   * revalidations, before any byte is sent.
   *
   * - no user → 401
   * - staff → any photo of this product
   * - approved customer → photos of ACTIVE products only
   * - anyone else, an unknown id or an image of another product → 404 (same body)
   */
  async resolveForServe(productId: string, imageId: string, user: RequestUser | null | undefined): Promise<ServableImage> {
    if (!user) throw new UnauthorizedException();
    const notFound = () => new NotFoundException(IMAGE_NOT_FOUND);
    const isStaff = user.userType === 'staff';
    const isApprovedCustomer = user.userType === 'customer' && user.isApproved === true;
    if (!isStaff && !isApprovedCustomer) throw notFound();
    if (typeof productId !== 'string' || typeof imageId !== 'string') throw notFound();

    const img = await this.prisma.productImage.findFirst({
      where: { id: imageId, productId },
      select: { storageKey: true, mimeType: true, product: { select: { isActive: true } } },
    });
    if (!img) throw notFound();
    if (!isStaff && !img.product?.isActive) throw notFound();

    const abs = imagePathForKey(img.storageKey);
    if (!abs) throw notFound();
    const ext = img.storageKey.slice(img.storageKey.lastIndexOf('.') + 1) as ImageExt;
    if (IMAGE_MIME_BY_EXT[ext] !== img.mimeType) throw notFound();
    return { absPath: abs, mime: img.mimeType, ext };
  }

  /**
   * P15 support (the route itself belongs to WP4, staff only): the plate render
   * of a component, 404 unless the component belongs to the product, has a
   * thumbnail attachment of THIS product, whose file resolves inside UPLOAD_DIR
   * and sniffs as PNG.
   */
  async resolveComponentThumbnail(productId: string, componentId: string): Promise<ServableImage> {
    const notFound = () => new NotFoundException(IMAGE_NOT_FOUND);
    const comp = await this.prisma.productComponent.findFirst({
      where: { id: componentId, productId },
      select: { thumbnailAttachmentId: true },
    });
    if (!comp?.thumbnailAttachmentId) throw notFound();
    const att = await this.prisma.attachment.findUnique({
      where: { id: comp.thumbnailAttachmentId },
      select: { entityType: true, entityId: true, storagePath: true },
    });
    if (!att || (att.entityType || '').toLowerCase() !== 'product' || att.entityId !== productId) throw notFound();
    const abs = containedUploadPath(att.storagePath);
    if (!abs) throw notFound();
    const head = await this.readHead(abs, 64 * 1024);
    const s = head ? sniffImage(head) : null;
    if (!s || s.ext !== 'png') throw notFound();
    return { absPath: abs, mime: 'image/png', ext: 'png' };
  }

  private async readHead(abs: string, bytes: number): Promise<Buffer | null> {
    let fh: fs.FileHandle | undefined;
    try {
      fh = await fs.open(abs, 'r');
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await fh.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead);
    } catch {
      return null;
    } finally {
      await fh?.close().catch(() => undefined);
    }
  }

  private async unlinkQuietly(abs: string) {
    try {
      await fs.unlink(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.logger.warn(`Could not delete ${path.basename(abs)}: ${(e as Error)?.message}`);
      }
    }
  }
}
