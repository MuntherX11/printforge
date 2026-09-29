import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateSpoolDto, UpdateSpoolDto, AdjustSpoolWeightDto } from '@printforge/types';
import { allowedBody, optionalNumber, optionalText, requiredNumber } from '../common/utils/validate-number';

/** Physical bounds for a filament spool, in grams. */
const W = { min: 0, max: 100_000 };
import * as QRCode from 'qrcode';
import JSZip from 'jszip';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit');

/** The only keys PATCH /spools/:id writes. */
const SPOOL_PATCH_KEYS: readonly string[] = [
  'currentWeight', 'initialWeight', 'spoolWeight', 'purchasePrice', 'isActive', 'locationId', 'lotNumber', 'purchaseDate',
];

/**
 * The Prisma data for PATCH /spools/:id, built key by key from the allowlist.
 * UpdateSpoolDto is an interface, so the global ValidationPipe never strips
 * extra keys: passing the body through let `jobMaterials: { deleteMany: {} }`
 * erase a spool's job history, `material: { update: … }` rename or reprice its
 * filament (getting round the material bounds), and `printforgeId` or
 * `materialId` change the spool's QR identity or cost basis. Any other key →
 * 400. Weights are grams, purchasePrice OMR, all bounded; a negative
 * currentWeight was once stored live (-50 g).
 */
export function spoolPatchData(raw: unknown): Prisma.SpoolUncheckedUpdateInput {
  const body = allowedBody(raw, SPOOL_PATCH_KEYS);
  const data: Prisma.SpoolUncheckedUpdateInput = {};

  const currentWeight = optionalNumber(body.currentWeight, 'currentWeight', W);
  if (currentWeight !== undefined) data.currentWeight = currentWeight;
  const initialWeight = optionalNumber(body.initialWeight, 'initialWeight', { min: 1, max: W.max });
  if (initialWeight !== undefined) data.initialWeight = initialWeight;
  const spoolWeight = optionalNumber(body.spoolWeight, 'spoolWeight', { min: 0, max: 10_000 });
  if (spoolWeight !== undefined) data.spoolWeight = spoolWeight;
  const purchasePrice = optionalNumber(body.purchasePrice, 'purchasePrice', { min: 0, max: 100_000 });
  if (purchasePrice !== undefined) data.purchasePrice = purchasePrice;

  const { isActive, locationId } = body;
  if (isActive !== undefined) {
    if (typeof isActive !== 'boolean') throw new BadRequestException('"isActive" must be true or false');
    data.isActive = isActive;
  }
  if (locationId !== undefined) {
    if (locationId !== null && typeof locationId !== 'string') {
      throw new BadRequestException('"locationId" must be a location id or null');
    }
    data.locationId = locationId?.trim() || null;
  }
  const lotNumber = optionalText(body.lotNumber, 'lotNumber', 100);
  if (lotNumber !== undefined) data.lotNumber = lotNumber;
  if (body.purchaseDate !== undefined) data.purchaseDate = optionalDate(body.purchaseDate, 'purchaseDate');
  return data;
}

/** A date from an ISO string (null or '' clears it); anything unparseable → 400. */
function optionalDate(raw: unknown, field: string): Date | null {
  if (raw === null || raw === '') return null;
  const date = typeof raw === 'string' ? new Date(raw) : null;
  if (!date || !Number.isFinite(date.getTime())) throw new BadRequestException(`"${field}" must be a date`);
  return date;
}

@Injectable()
export class SpoolsService {
  constructor(private prisma: PrismaService) {}

  private async generatePrintforgeId(): Promise<string> {
    const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0, 1, O, I
    for (let attempt = 0; attempt < 10; attempt++) {
      let code = 'PF-';
      for (let i = 0; i < 4; i++) {
        code += charset[Math.floor(Math.random() * charset.length)];
      }
      const existing = await this.prisma.spool.findUnique({ where: { printforgeId: code } });
      if (!existing) return code;
    }
    throw new BadRequestException('Failed to generate unique PrintForge ID');
  }

  async create(dto: CreateSpoolDto) {
    // Verify material exists
    const material = await this.prisma.material.findUnique({ where: { id: dto.materialId } });
    if (!material) throw new NotFoundException('Material not found');

    // Bound every weight/price: a mistyped spool weight silently skews stock
    // levels, low-stock alerts and job costing.
    const initialWeight = requiredNumber(dto.initialWeight, 'initialWeight', { min: 1, max: W.max });
    const currentWeight = optionalNumber(dto.currentWeight, 'currentWeight', W) ?? initialWeight;
    const spoolWeight = optionalNumber(dto.spoolWeight, 'spoolWeight', { min: 0, max: 10_000 }) ?? 200;
    const purchasePrice = optionalNumber(dto.purchasePrice, 'purchasePrice', { min: 0, max: 100_000 });

    const printforgeId = await this.generatePrintforgeId();

    return this.prisma.spool.create({
      data: {
        printforgeId,
        materialId: dto.materialId,
        initialWeight,
        currentWeight,
        spoolWeight,
        lotNumber: dto.lotNumber,
        purchasePrice,
        purchaseDate: dto.purchaseDate ? new Date(dto.purchaseDate) : undefined,
        locationId: dto.locationId || undefined,
      },
      include: { material: true, location: true },
    });
  }

  async findAll(materialId?: string) {
    return this.prisma.spool.findMany({
      where: materialId ? { materialId } : undefined,
      include: { material: true, location: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const spool = await this.prisma.spool.findUnique({
      where: { id },
      include: {
        material: true,
        location: true,
        jobMaterials: {
          include: { job: { select: { id: true, name: true, status: true } } },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });
    if (!spool) throw new NotFoundException('Spool not found');
    return spool;
  }

  async update(id: string, dto: UpdateSpoolDto) {
    const data = spoolPatchData(dto);
    const spool = await this.prisma.spool.findUnique({ where: { id }, select: { id: true } });
    if (!spool) throw new NotFoundException('Spool not found');
    return this.prisma.spool.update({
      where: { id },
      data,
      include: { material: true },
    });
  }

  async adjustWeight(id: string, dto: AdjustSpoolWeightDto) {
    const spool = await this.findOne(id);
    // Reject NaN/Infinity before the arithmetic, or currentWeight becomes NaN
    // and every downstream stock total silently breaks.
    const adjustment = requiredNumber(dto.adjustment, 'adjustment', { min: -W.max, max: W.max });
    const newWeight = spool.currentWeight + adjustment;

    if (newWeight < 0) throw new BadRequestException('Weight cannot be negative');

    return this.prisma.spool.update({
      where: { id },
      data: { currentWeight: newWeight },
      include: { material: true },
    });
  }

  async remove(id: string) {
    await this.findOne(id);

    const activeJobMaterials = await this.prisma.jobMaterial.findFirst({
      where: {
        spoolId: id,
        job: { status: { in: ['QUEUED', 'IN_PROGRESS', 'PAUSED'] } },
      },
    });
    if (activeJobMaterials) {
      throw new BadRequestException('Cannot delete spool assigned to an active production job');
    }

    // Clear foreign key references first
    await this.prisma.jobMaterial.deleteMany({ where: { spoolId: id } });
    await this.prisma.spool.delete({ where: { id } });
    return { deleted: true };
  }

  async deductWeight(id: string, grams: number) {
    const spool = await this.prisma.spool.findUnique({ where: { id } });
    if (!spool) throw new NotFoundException('Spool not found');

    const newWeight = Math.max(0, spool.currentWeight - grams);
    return this.prisma.spool.update({
      where: { id },
      data: { currentWeight: newWeight },
    });
  }

  async findByPfid(pfid: string) {
    // Normalize: uppercase, ensure PF- prefix
    let normalized = pfid.toUpperCase().trim();
    if (!normalized.startsWith('PF-')) {
      normalized = `PF-${normalized}`;
    }

    const spool = await this.prisma.spool.findUnique({
      where: { printforgeId: normalized },
      include: {
        material: {
          select: { id: true, name: true, type: true, color: true, brand: true },
        },
        location: { select: { id: true, name: true } },
        jobMaterials: {
          include: { job: { select: { id: true, name: true, status: true, createdAt: true } } },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });
    if (!spool) throw new NotFoundException('Spool not found');

    // Strip internal fields for public access
    const { materialId, locationId, ...safe } = spool as any;
    return safe;
  }

  /** Filesystem-safe fragment built only from validated/known fields. */
  private safeFrag(s?: string | null): string {
    return String(s ?? '').trim().replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  /**
   * One PNG per spool, delivered as a zip.
   *
   * The PDF sheet is right for printing a whole page of labels at once; this is
   * for when you want the codes as individual images — dropping one into a
   * label printer, a document, or a product listing.
   *
   * Each file is named for the spool it belongs to (ID, material, colour,
   * brand) so the identity travels with the image, and the QR is rendered at
   * print resolution rather than the ~60pt used on the sheet.
   */
  async generateQrImagesZip(
    spoolIds: string[],
    opts: { size?: number } = {},
  ): Promise<{ buffer: Buffer; count: number }> {
    const spools = await this.prisma.spool.findMany({
      where: { id: { in: spoolIds } },
      include: { material: true },
    });
    if (spools.length === 0) throw new NotFoundException('No spools found');

    // 600 px is roughly 25 mm at 600 dpi — comfortable for a label printer.
    const size = Math.max(128, Math.min(2048, Math.floor(opts.size ?? 600)));
    const baseUrl = process.env.APP_BASE_URL || 'https://printforge.mctx.tech';

    const zip = new JSZip();
    const used = new Set<string>();

    for (const spool of spools) {
      const png = await QRCode.toBuffer(`${baseUrl}/inventory/spool/${spool.printforgeId}`, {
        type: 'png',
        width: size,
        margin: 2,
        errorCorrectionLevel: 'M',
      });

      const parts = [
        this.safeFrag(spool.printforgeId) || 'spool',
        this.safeFrag(spool.material?.type),
        this.safeFrag(spool.material?.color),
        this.safeFrag(spool.material?.brand),
      ].filter(Boolean);

      let name = `${parts.join('_')}.png`;
      // Two spools of the same filament would otherwise collide in the zip.
      let n = 2;
      while (used.has(name)) name = `${parts.join('_')}_${n++}.png`;
      used.add(name);

      zip.file(name, png);
    }

    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }); // PNG is already compressed
    return { buffer, count: spools.length };
  }

  /** A single spool's QR as a standalone PNG — handy for reprinting one label. */
  async generateQrPng(id: string, size = 600): Promise<{ png: Buffer; filename: string }> {
    const spool = await this.prisma.spool.findUnique({ where: { id }, include: { material: true } });
    if (!spool) throw new NotFoundException('Spool not found');
    const baseUrl = process.env.APP_BASE_URL || 'https://printforge.mctx.tech';
    const png = await QRCode.toBuffer(`${baseUrl}/inventory/spool/${spool.printforgeId}`, {
      type: 'png',
      width: Math.max(128, Math.min(2048, Math.floor(size))),
      margin: 2,
      errorCorrectionLevel: 'M',
    });
    const parts = [
      this.safeFrag(spool.printforgeId) || 'spool',
      this.safeFrag(spool.material?.type),
      this.safeFrag(spool.material?.color),
    ].filter(Boolean);
    return { png, filename: `${parts.join('_')}.png` };
  }

  async generateQrLabelsPdf(spoolIds: string[]): Promise<Buffer> {
    const spools = await this.prisma.spool.findMany({
      where: { id: { in: spoolIds } },
      include: { material: true },
    });

    if (spools.length === 0) throw new NotFoundException('No spools found');

    const pageW = 595.28;
    const pageH = 841.89;
    const cols = 4;
    const rows = 8;
    const cellW = pageW / cols;  // ~148.82
    const cellH = pageH / rows;  // ~105.24
    const qrSize = 60;

    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks: Buffer[] = [];

    return new Promise(async (resolve, reject) => {
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      for (let i = 0; i < spools.length; i++) {
        const spool = spools[i];
        const pageIndex = Math.floor(i / (cols * rows));
        const posOnPage = i % (cols * rows);

        if (pageIndex > 0 && posOnPage === 0) doc.addPage();

        const col = posOnPage % cols;
        const row = Math.floor(posOnPage / cols);
        const x = col * cellW;
        const y = row * cellH;

        // Generate QR code as PNG buffer
        const baseUrl = process.env.APP_BASE_URL || 'https://printforge.mctx.tech';
        const qrUrl = `${baseUrl}/inventory/spool/${spool.printforgeId}`;
        const qrBuffer = await QRCode.toBuffer(qrUrl, {
          type: 'png',
          width: qrSize * 2,
          margin: 1,
        });

        // Draw QR centered horizontally in cell
        const qrX = x + (cellW - qrSize) / 2;
        const qrY = y + 8;
        doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });

        // Line 1: Spool ID (bold, centered below QR)
        const pfidText = spool.printforgeId || 'N/A';
        doc.font('Helvetica-Bold').fontSize(10);
        const pfidWidth = doc.widthOfString(pfidText);
        doc.text(pfidText, x + (cellW - pfidWidth) / 2, qrY + qrSize + 4);

        // Line 2: Material type + color
        const colorPart = spool.material.color ? ` - ${spool.material.color}` : '';
        const typeColorText = `${spool.material.type}${colorPart}`;
        doc.font('Helvetica').fontSize(8);
        const typeColorWidth = doc.widthOfString(typeColorText);
        doc.text(typeColorText, x + (cellW - typeColorWidth) / 2, qrY + qrSize + 17);

        // Line 3: Vendor / brand
        const brandText = spool.material.brand || '';
        if (brandText) {
          doc.font('Helvetica').fontSize(7);
          const brandWidth = doc.widthOfString(brandText);
          doc.text(brandText, x + (cellW - brandWidth) / 2, qrY + qrSize + 28);
        }
      }

      doc.end();
    });
  }
}
