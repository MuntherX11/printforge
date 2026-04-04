import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateSpoolDto, UpdateSpoolDto, AdjustSpoolWeightDto } from '@printforge/types';
import * as QRCode from 'qrcode';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit');

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

    const printforgeId = await this.generatePrintforgeId();

    return this.prisma.spool.create({
      data: {
        printforgeId,
        materialId: dto.materialId,
        initialWeight: dto.initialWeight,
        currentWeight: dto.currentWeight ?? dto.initialWeight,
        spoolWeight: dto.spoolWeight ?? 200,
        lotNumber: dto.lotNumber,
        purchasePrice: dto.purchasePrice,
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
    await this.findOne(id);
    return this.prisma.spool.update({
      where: { id },
      data: dto,
      include: { material: true },
    });
  }

  async adjustWeight(id: string, dto: AdjustSpoolWeightDto) {
    const spool = await this.findOne(id);
    const newWeight = spool.currentWeight + dto.adjustment;

    if (newWeight < 0) throw new BadRequestException('Weight cannot be negative');

    return this.prisma.spool.update({
      where: { id },
      data: { currentWeight: newWeight },
      include: { material: true },
    });
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
    const spool = await this.prisma.spool.findUnique({
      where: { printforgeId: pfid },
      include: { material: true, location: true },
    });
    if (!spool) throw new NotFoundException('Spool not found');
    return spool;
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
        const qrUrl = `/inventory/spool/${spool.printforgeId}`;
        const qrBuffer = await QRCode.toBuffer(qrUrl, {
          type: 'png',
          width: qrSize * 2,
          margin: 1,
        });

        // Draw QR centered horizontally in cell
        const qrX = x + (cellW - qrSize) / 2;
        const qrY = y + 10;
        doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });

        // PF-ID text bold, centered below QR
        const pfidText = spool.printforgeId || 'N/A';
        doc.font('Helvetica-Bold').fontSize(10);
        const pfidWidth = doc.widthOfString(pfidText);
        doc.text(pfidText, x + (cellW - pfidWidth) / 2, qrY + qrSize + 6);

        // Material name + color in small text
        const materialColor = spool.material.color ? ` ${spool.material.color}` : '';
        const detailText = `${spool.material.name}${materialColor}`;
        doc.font('Helvetica').fontSize(7);
        const detailWidth = doc.widthOfString(detailText);
        doc.text(detailText, x + (cellW - detailWidth) / 2, qrY + qrSize + 20);
      }

      doc.end();
    });
  }
}
