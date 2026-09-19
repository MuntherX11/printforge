import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { sanitizeImageName, uploadDir } from './product-images.service';

/**
 * Disk half of storing a slicer file or plate render (spec §3.12, §3.4). Files
 * are written BEFORE the import/layout transaction; the Attachment row is then
 * created inside it, and the caller unlinks what it wrote if the transaction
 * fails. The on-disk name is always server-generated; the client's file name is
 * only ever the display `originalName`.
 */

export interface StoredFile {
  abs: string;
  /** relative to UPLOAD_DIR, as Attachment.storagePath */
  storagePath: string;
  filename: string;
  sizeBytes: number;
}

export async function writeUploadFile(buffer: Buffer, ext: 'gcode' | 'png', filename?: string): Promise<StoredFile> {
  const root = uploadDir();
  const now = new Date();
  const dateDir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
  const name = filename ?? `${randomBytes(12).toString('hex')}.${ext}`;
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) throw new Error('unsafe stored file name');
  const storagePath = path.posix.join(dateDir, name);
  const abs = path.resolve(root, storagePath);
  if (!abs.startsWith(root + path.sep)) throw new Error('stored file escapes the upload directory');
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buffer, { flag: 'wx' });
  return { abs, storagePath, filename: name, sizeBytes: buffer.length };
}

/** Attachment data for a stored slicer file: server-set mime, never the multipart type. */
export function slicerAttachmentData(productId: string, f: StoredFile, originalName: unknown) {
  return {
    entityType: 'product',
    entityId: productId,
    filename: f.filename,
    originalName: sanitizeImageName(originalName).slice(0, 200) || 'model.gcode',
    mimeType: 'application/octet-stream',
    sizeBytes: f.sizeBytes,
    storagePath: f.storagePath,
  };
}

/** Attachment data for a 3MF plate render: PNG (sniffed by the caller), pre-marked so BF-2 never considers it. */
export function thumbnailAttachmentData(productId: string, f: StoredFile, plateIndex: number) {
  return {
    entityType: 'product',
    entityId: productId,
    filename: f.filename,
    originalName: `Plate ${plateIndex} thumbnail`,
    mimeType: 'image/png',
    sizeBytes: f.sizeBytes,
    storagePath: f.storagePath,
    photoMigratedAt: new Date(),
  };
}

/** Unlink files written before a transaction that then failed (ENOENT ignored). */
export async function unlinkWritten(files: StoredFile[]): Promise<void> {
  for (const f of files) await fs.unlink(f.abs).catch(() => undefined);
}
