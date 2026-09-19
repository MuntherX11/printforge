import { Injectable, BadRequestException, NotFoundException, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads';
const CHUNK_DIR = path.join(UPLOAD_DIR, 'chunk-tmp');

// A part must fit comfortably under Cloudflare's 100 MB request cap with
// multipart overhead to spare; the assembled cap is a backstop only — every
// consuming endpoint enforces its own limit again at consume().
const MAX_PART_BYTES = 50 * 1024 * 1024;
const MAX_PARTS = 100;
const MAX_ASSEMBLED_BYTES = 500 * 1024 * 1024;
// Abandoned uploads are junk on disk, nothing more — sweep them daily.
const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Staged multi-request uploads, to get big files past Cloudflare's 100 MB
 * per-request limit on the free tier.
 *
 * The frontend slices a large file into parts, PUTs each one (every request
 * well under the cap), then calls complete. The consuming endpoint — 3MF
 * onboarding, addon install — receives an `assembledUploadId` instead of a
 * multipart file and redeems it here for the reassembled bytes, exactly once.
 *
 * Ids are server-generated, so a client never chooses a path component.
 */
@Injectable()
export class ChunkUploadsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChunkUploadsService.name);
  private sweeper?: NodeJS.Timeout;

  async onModuleInit() {
    await fs.mkdir(CHUNK_DIR, { recursive: true }).catch(() => {});
    this.sweep().catch(() => {});
    this.sweeper = setInterval(() => this.sweep().catch(() => {}), 60 * 60 * 1000);
    this.sweeper.unref?.();
  }

  onModuleDestroy() {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  private dirFor(id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      throw new BadRequestException('Invalid upload id');
    }
    return path.join(CHUNK_DIR, id);
  }

  async init(filename?: string) {
    const id = randomUUID();
    const dir = this.dirFor(id);
    await fs.mkdir(dir, { recursive: true });
    const safeName = (filename || 'upload.bin').replace(/[^\w\s.\-()]/g, '_').slice(0, 150);
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ filename: safeName, createdAt: Date.now() }));
    return { id, maxPartBytes: MAX_PART_BYTES, maxParts: MAX_PARTS };
  }

  async putPart(id: string, index: number, part?: { buffer: Buffer; size: number }) {
    const dir = this.dirFor(id);
    await fs.access(path.join(dir, 'meta.json')).catch(() => {
      throw new NotFoundException('Unknown or expired upload — start again');
    });
    if (!part?.buffer?.length) throw new BadRequestException('Empty part');
    if (!Number.isInteger(index) || index < 0 || index >= MAX_PARTS) {
      throw new BadRequestException(`Part index must be 0-${MAX_PARTS - 1}`);
    }
    if (part.buffer.length > MAX_PART_BYTES) {
      throw new BadRequestException(`Part exceeds ${MAX_PART_BYTES / 1024 / 1024} MB`);
    }
    await fs.writeFile(path.join(dir, `${index}.part`), part.buffer);
    return { id, index, bytes: part.buffer.length };
  }

  async complete(id: string, totalParts: number) {
    const dir = this.dirFor(id);
    if (!Number.isInteger(totalParts) || totalParts < 1 || totalParts > MAX_PARTS) {
      throw new BadRequestException('totalParts out of range');
    }
    // Every part must be present and contiguous — a silently missing slice
    // would corrupt the file in a way nothing downstream could detect.
    let total = 0;
    for (let i = 0; i < totalParts; i++) {
      const st = await fs.stat(path.join(dir, `${i}.part`)).catch(() => null);
      if (!st) throw new BadRequestException(`Missing part ${i} of ${totalParts}`);
      total += st.size;
    }
    if (total > MAX_ASSEMBLED_BYTES) {
      throw new BadRequestException('Assembled file exceeds the server-side limit');
    }

    const outPath = path.join(dir, 'assembled.bin');
    const handle = await fs.open(outPath, 'w');
    try {
      for (let i = 0; i < totalParts; i++) {
        const buf = await fs.readFile(path.join(dir, `${i}.part`));
        await handle.write(buf);
        await fs.unlink(path.join(dir, `${i}.part`)).catch(() => {});
      }
    } finally {
      await handle.close();
    }
    return { id, size: total };
  }

  /**
   * Redeem an assembled upload as a Multer-shaped file, once. `maxBytes` is the
   * consuming endpoint's own limit — chunking must never smuggle a file past
   * the cap the endpoint would have enforced on a direct upload.
   */
  async consume(id: string, maxBytes: number, opts?: { keep?: boolean }): Promise<Express.Multer.File> {
    const dir = this.dirFor(id);
    const metaRaw = await fs.readFile(path.join(dir, 'meta.json'), 'utf-8').catch(() => {
      throw new NotFoundException('Unknown or expired upload — start again');
    });
    const meta = JSON.parse(metaRaw);
    const outPath = path.join(dir, 'assembled.bin');
    const st = await fs.stat(outPath).catch(() => {
      throw new BadRequestException('Upload was never completed');
    });
    if (st.size > maxBytes) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw new BadRequestException(`File exceeds this endpoint's ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
    }
    const buffer = await fs.readFile(outPath);
    // keep=true lets a preflight (analyze) read the bytes while the staged file
    // stays put for the step that actually commits them, so a big file is
    // uploaded once, not once per step.
    if (!opts?.keep) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }

    return {
      fieldname: 'file',
      originalname: meta.filename,
      encoding: '7bit',
      mimetype: 'application/octet-stream',
      size: buffer.length,
      buffer,
    } as Express.Multer.File;
  }

  /**
   * Remove a staged upload (spec §4.3). Imports consume with `{ keep: true }`
   * and call this only after their transaction commits, so a failed or
   * rejected first attempt leaves a large staged file in place for a retry.
   * Validates the id format; a missing directory is not an error.
   */
  async discard(id: string): Promise<void> {
    const dir = this.dirFor(String(id ?? ''));
    await fs.rm(dir, { recursive: true, force: true }).catch((e) => {
      this.logger.warn(`Could not discard staged upload ${id}: ${(e as Error)?.message}`);
    });
  }

  private async sweep() {
    const entries = await fs.readdir(CHUNK_DIR).catch(() => [] as string[]);
    const cutoff = Date.now() - STALE_MS;
    for (const name of entries) {
      const dir = path.join(CHUNK_DIR, name);
      const st = await fs.stat(dir).catch(() => null);
      if (st && st.mtimeMs < cutoff) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        this.logger.log(`Swept stale chunk upload ${name}`);
      }
    }
  }
}
