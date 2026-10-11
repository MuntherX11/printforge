import { BadRequestException, forwardRef, HttpException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ComponentSourceModel, SliceRunDto, SourceModelKind, SourceModelUploadResult } from '@printforge/types';
import JSZip from 'jszip';
import { ChunkUploadsService } from '../chunk-uploads/chunk-uploads.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { SliceService } from '../slice/slice.service';
import { STORE_FAILED } from './plate-layouts.service';
import { containedUploadPath, sanitizeImageName } from './product-images.service';
import { TX_OPTS, unlinkAfterCommit } from './product-locks';
import {
  hasPlateSection, isCurrentProjectVersion, NOT_A_SOURCE_FILE, OLD_PROJECT_FORMAT_MESSAGE, projectSourceMeta, SOURCE_MIME, sniffSourceKind,
  sourceModelOf, type SourceMeta,
} from './product-sources';
import { MATERIAL_SNAPSHOT } from './slicer-materials';
import { parseFileAttach } from './slicer-import-input';
import { StoredFile, unlinkWritten, writeUploadFile } from './slicer-files';

/**
 * The source model on a part (slicer plan WP4, ADMIN only): the STL or
 * OrcaSlicer project the slicer container slices from. Uploading stores the
 * file as a product Attachment (mime sniffed, never the multipart type), reads
 * a project's slots and printer once into the attachment's metadata, and
 * queues the 1-unit validation slice — or says why it could not (no printer,
 * no profile, no filament). Replacing or removing a source deactivates the
 * part's SLICED layouts: they were cut from the old geometry.
 */

const MAX_SOURCE_BYTES = 200 * 1024 * 1024;
export const NO_SOURCE_MODEL = 'This part has no source model';

@Injectable()
export class ProductSourcesService {
  private readonly logger = new Logger(ProductSourcesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chunkUploads: ChunkUploadsService,
    @Inject(forwardRef(() => SliceService)) private readonly slice: SliceService,
  ) {}

  private async owned(db: any, productId: string, componentId: string) {
    const c = await db.productComponent.findUnique({
      where: { id: componentId },
      select: { id: true, productId: true, description: true, sourceAttachmentId: true, sourceKind: true, product: { select: { defaultPrinterId: true } } },
    });
    if (!c || c.productId !== productId) throw new NotFoundException('Component not found');
    return c;
  }

  /** A project's slots and printer; 400 for a pre-2.3 project or a 3MF that is not an OrcaSlicer project. */
  private async projectMeta(buffer: Buffer): Promise<SourceMeta> {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(buffer);
    } catch {
      throw new BadRequestException('Invalid or corrupt .3mf file — could not unzip');
    }
    const settings = await zip.file('Metadata/project_settings.config')?.async('string');
    const model = (await zip.file('Metadata/model_settings.config')?.async('string')) ?? null;
    if (!settings) throw new BadRequestException(OLD_PROJECT_FORMAT_MESSAGE);
    let version: unknown = null;
    try {
      version = (JSON.parse(settings) as Record<string, unknown>).version;
    } catch {
      throw new BadRequestException(OLD_PROJECT_FORMAT_MESSAGE);
    }
    if (!isCurrentProjectVersion(version) || !hasPlateSection(model)) throw new BadRequestException(OLD_PROJECT_FORMAT_MESSAGE);
    const [materials, printers] = await Promise.all([
      this.prisma.material.findMany(MATERIAL_SNAPSHOT as any),
      this.prisma.printer.findMany({ where: { isActive: true }, select: { id: true, name: true, model: true, isActive: true } }),
    ]);
    return projectSourceMeta(settings, materials as any, printers as any);
  }

  /** POST /products/:id/components/:cid/source */
  async upload(productId: string, componentId: string, body: unknown): Promise<SourceModelUploadResult> {
    const { assembledUploadId } = parseFileAttach(body);
    const comp = await this.owned(this.prisma, productId, componentId);
    const file = await this.chunkUploads.consume(assembledUploadId, MAX_SOURCE_BYTES, { keep: true });
    const name = String(file.originalname || '');
    const kind = sniffSourceKind(file.buffer, name);
    if (!kind) throw new BadRequestException(NOT_A_SOURCE_FILE);
    const meta: SourceMeta = kind === 'THREEMF' ? await this.projectMeta(file.buffer) : { printerModel: null, printerId: null, slots: [] };

    let stored: StoredFile;
    try {
      stored = await writeUploadFile(file.buffer, kind === 'STL' ? 'stl' : '3mf');
    } catch (e) {
      this.logger.error(`Storing a source model for component ${componentId} failed: ${(e as Error)?.message}`, (e as Error)?.stack);
      throw new BadRequestException(STORE_FAILED);
    }

    let out: { attachment: any; unlink: string[] };
    try {
      out = await this.prisma.$transaction(async (tx: any) => {
        const again = await this.owned(tx, productId, componentId);
        const attachment = await tx.attachment.create({
          data: {
            entityType: 'product', entityId: productId, filename: stored.filename,
            originalName: sanitizeImageName(name).slice(0, 200) || (kind === 'STL' ? 'model.stl' : 'project.3mf'),
            mimeType: SOURCE_MIME[kind], sizeBytes: stored.sizeBytes, storagePath: stored.storagePath, parsedMetadata: meta as any,
          },
        });
        await tx.productComponent.update({ where: { id: componentId }, data: { sourceAttachmentId: attachment.id, sourceKind: kind } });
        const unlink = again.sourceAttachmentId ? await this.dropOldSource(tx, componentId, again.sourceAttachmentId) : [];
        return { attachment, unlink };
      }, TX_OPTS);
    } catch (e) {
      await unlinkWritten([stored]);
      throw e;
    }
    await this.chunkUploads.discard(assembledUploadId);
    await unlinkAfterCommit(out.unlink);

    const source = sourceModelOf({ sourceAttachmentId: out.attachment.id, sourceKind: kind }, out.attachment)!;
    const validation = await this.queueValidation(productId, componentId, kind, comp.product?.defaultPrinterId ?? null);
    return { source, ...validation };
  }

  /** The replaced source's SLICED layouts are deactivated and its file goes; returns the paths to unlink after commit. */
  private async dropOldSource(tx: any, componentId: string, attachmentId: string): Promise<string[]> {
    await tx.plateLayout.updateMany({ where: { componentId, source: 'SLICED', isActive: true }, data: { isActive: false } });
    const att = await tx.attachment.findUnique({ where: { id: attachmentId }, select: { id: true, storagePath: true } });
    if (!att) return [];
    await tx.attachment.delete({ where: { id: att.id } });
    const abs = containedUploadPath(att.storagePath);
    return abs ? [abs] : [];
  }

  /** The 1-unit validation slice, or the reason it could not be queued (the Settings > Slicer page explains it). */
  private async queueValidation(productId: string, componentId: string, kind: SourceModelKind, defaultPrinterId: string | null): Promise<{ validationRun: SliceRunDto | null; notice: string | null }> {
    try {
      const run = await this.slice.create(productId, componentId, { ...(kind === 'STL' && defaultPrinterId ? { printerId: defaultPrinterId } : {}), materials: {}, units: 1 }, true);
      return { validationRun: run, notice: null };
    } catch (e) {
      if (e instanceof HttpException) return { validationRun: null, notice: String((e.getResponse() as any)?.message ?? e.message) };
      throw e;
    }
  }

  /** DELETE /products/:id/components/:cid/source */
  async remove(productId: string, componentId: string): Promise<{ deleted: true }> {
    const unlink = await this.prisma.$transaction(async (tx: any) => {
      const c = await this.owned(tx, productId, componentId);
      if (!c.sourceAttachmentId) throw new NotFoundException(NO_SOURCE_MODEL);
      await tx.productComponent.update({ where: { id: componentId }, data: { sourceAttachmentId: null, sourceKind: null } });
      return this.dropOldSource(tx, componentId, c.sourceAttachmentId);
    }, TX_OPTS);
    await unlinkAfterCommit(unlink);
    return { deleted: true };
  }

  /** GET helper for the product page: the part's source, or null. */
  async sourceOf(componentId: string): Promise<ComponentSourceModel | null> {
    const c = await this.prisma.productComponent.findUnique({ where: { id: componentId }, select: { sourceAttachmentId: true, sourceKind: true } });
    if (!c?.sourceAttachmentId) return null;
    const att = await this.prisma.attachment.findUnique({
      where: { id: c.sourceAttachmentId }, select: { id: true, originalName: true, filename: true, sizeBytes: true, parsedMetadata: true },
    });
    return sourceModelOf(c, att);
  }
}
