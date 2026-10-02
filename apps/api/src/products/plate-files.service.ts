import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { PlateFileResult, Problem } from '@printforge/types';
import { PricingService } from '../catalog-core/pricing.service';
import { ChunkUploadsService } from '../chunk-uploads/chunk-uploads.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { GcodeParserService } from '../file-parser/gcode-parser.service';
import { matchPrinter, noMatchingPrinter } from '../file-parser/printer-match';
import { adoptDefaultPrinter, fileInUseError, openJobUsingFiles } from './plate-file-rules';
import { plateLabelWarnings, STORE_FAILED } from './plate-layouts.service';
import { TX_OPTS, unlinkAfterCommit, unreferencedAttachments } from './product-locks';
import { slicerAttachmentData, unlinkWritten, writeUploadFile, type StoredFile } from './slicer-files';
import { parseFileAttach } from './slicer-import-input';

/**
 * The print file of one plate (owner spec 2026-10-02 items 3 and 5): a plate
 * entered by hand gets a G-code uploaded onto it, and a plate's file can be
 * deleted. A plate is a layout (`layoutId`) or the component's own single unit
 * (`layoutId` null, the component's file).
 *
 * Uploading never changes the plate's typed numbers; the file's object labels
 * are compared with the plate's units and a difference is a warning. Deleting
 * refuses while an open job prints the file (409 naming it), and unlinks it
 * inside UPLOAD_DIR only after the commit.
 */

const MAX_GCODE_BYTES = 200 * 1024 * 1024;
export const HAS_FILE = 'This plate already has a file — delete it first';
export const NO_FILE = 'This plate has no file';

interface Target {
  component: { id: string; productId: string; description: string; attachmentId: string | null };
  layout: { id: string; unitsPerPlate: number; attachmentId: string | null } | null;
}

@Injectable()
export class PlateFilesService {
  private readonly logger = new Logger(PlateFilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gcodeParser: GcodeParserService,
    private readonly chunkUploads: ChunkUploadsService,
    @Optional() private readonly pricing?: PricingService,
  ) {}

  /** 404 unless the component is the product's and the layout the component's. */
  private async target(db: any, productId: string, componentId: string, layoutId: string | null): Promise<Target> {
    const component = await db.productComponent.findUnique({
      where: { id: componentId },
      select: { id: true, productId: true, description: true, attachmentId: true },
    });
    if (!component || component.productId !== productId) throw new NotFoundException('Component not found');
    if (!layoutId) return { component, layout: null };
    const layout = await db.plateLayout.findUnique({ where: { id: layoutId }, select: { id: true, componentId: true, unitsPerPlate: true, attachmentId: true } });
    if (!layout || layout.componentId !== componentId) throw new NotFoundException('Layout not found');
    return { component, layout };
  }

  private async reprice(productId: string) {
    if (!this.pricing) return;
    try {
      await this.pricing.recalcPricing(productId);
    } catch (e) {
      this.logger.warn(`Repricing ${productId} after a plate file change failed: ${(e as Error)?.message}`);
    }
  }

  /** Upload a G-code onto a plate that has no file. */
  async attach(productId: string, componentId: string, layoutId: string | null, body: unknown): Promise<PlateFileResult> {
    const { assembledUploadId } = parseFileAttach(body);
    const t = await this.target(this.prisma, productId, componentId, layoutId);
    if (t.layout ? t.layout.attachmentId : t.component.attachmentId) throw new ConflictException(HAS_FILE);

    const file = await this.chunkUploads.consume(assembledUploadId, MAX_GCODE_BYTES, { keep: true });
    const name = String(file.originalname || '');
    if (!/\.(gcode|gco|g)$/i.test(name)) throw new BadRequestException('File must be a G-code file (.gcode, .gco, .g)');
    const a = this.gcodeParser.parseHeader(file.buffer);
    const units = t.layout ? t.layout.unitsPerPlate : 1;
    const label = `${t.component.description} ×${units}`;
    const warnings: Problem[] = plateLabelWarnings(label, a, null);
    if (a.objectCount !== null && a.objectCount !== units) {
      warnings.push({ code: 'UNITS_DIFFER_FROM_LABELS', message: `"${label}": the file holds ${a.objectCount} units — check it is the right file` });
    }

    let stored: StoredFile;
    try {
      stored = await writeUploadFile(file.buffer, 'gcode');
    } catch (e) {
      this.logger.error(`Storing a plate G-code for component ${componentId} failed: ${(e as Error)?.message}`, (e as Error)?.stack);
      throw new BadRequestException(STORE_FAILED);
    }

    let out: { attachmentId: string; printer: { id: string; name: string } | null };
    try {
      out = await this.prisma.$transaction(async (tx: any) => {
        const again = await this.target(tx, productId, componentId, layoutId);
        if (again.layout ? again.layout.attachmentId : again.component.attachmentId) throw new ConflictException(HAS_FILE);
        const att = await tx.attachment.create({ data: slicerAttachmentData(productId, stored, name, a.printerModel), select: { id: true } });
        const gcodeFilename = (name || 'plate.gcode').slice(0, 200);
        if (again.layout) {
          await tx.plateLayout.update({ where: { id: again.layout.id }, data: { attachmentId: att.id, gcodeFilename, objectCount: a.objectCount } });
        } else {
          await tx.productComponent.update({ where: { id: componentId }, data: { attachmentId: att.id, gcodeFilename } });
        }
        const printer = await adoptDefaultPrinter(tx, productId, [a.printerModel]);
        return { attachmentId: att.id, printer };
      }, TX_OPTS);
    } catch (e) {
      await unlinkWritten([stored]);
      throw e;
    }
    await this.chunkUploads.discard(assembledUploadId);
    // A component file makes its grams slicer grams (no manual purge), and a new
    // pricing printer changes the price: both reprice (spec §3.8 triggers).
    if (!t.layout || out.printer) await this.reprice(productId);

    const printers = await this.prisma.printer.findMany({ where: { isActive: true }, select: { id: true, name: true, model: true, isActive: true } });
    const matched = matchPrinter(a.printerModel, printers);
    if (a.printerModel && !matched) warnings.push({ code: 'PRINTER_NOT_MATCHED', message: noMatchingPrinter(a.printerModel) });
    return {
      file: { attachmentId: out.attachmentId, filename: name, sizeBytes: stored.sizeBytes, downloadUrl: `/api/attachments/${out.attachmentId}/download` },
      slicedFor: a.printerModel,
      printer: matched ? { id: matched.id, name: matched.name } : null,
      warnings,
    };
  }

  /** Delete a plate's file (row and disk) unless an open job prints it. */
  async remove(productId: string, componentId: string, layoutId: string | null): Promise<{ deleted: true }> {
    const unlink = await this.prisma.$transaction(async (tx: any) => {
      const t = await this.target(tx, productId, componentId, layoutId);
      const attachmentId = t.layout ? t.layout.attachmentId : t.component.attachmentId;
      if (!attachmentId) throw new NotFoundException(NO_FILE);
      const open = await openJobUsingFiles(tx, [attachmentId]);
      if (open) throw fileInUseError(open);
      if (t.layout) await tx.plateLayout.update({ where: { id: t.layout.id }, data: { attachmentId: null, gcodeFilename: null } });
      else await tx.productComponent.update({ where: { id: componentId }, data: { attachmentId: null, gcodeFilename: null } });
      const orphans = await unreferencedAttachments(tx, [attachmentId]);
      for (const o of orphans) await tx.attachment.delete({ where: { id: o.id } });
      return orphans.map((o) => o.abs);
    }, TX_OPTS);
    await unlinkAfterCommit(unlink);
    if (!layoutId) await this.reprice(productId);
    return { deleted: true };
  }
}
