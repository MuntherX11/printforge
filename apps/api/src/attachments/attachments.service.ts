import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import * as path from 'path';
import * as fs from 'fs/promises';

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads';

const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'model/stl',
  'application/octet-stream',
  'text/plain',
  'application/zip',
];

const BLOCKED_EXTENSIONS = ['.html', '.htm', '.js', '.jsx', '.ts', '.tsx', '.php', '.exe', '.sh', '.bat'];

@Injectable()
export class AttachmentsService {
  constructor(private prisma: PrismaService) {}

  async upload(file: Express.Multer.File, entityType: string, entityId: string, uploadedById?: string) {
    // MIME type allowlist check
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException('File type not allowed');
    }
    // Extension denylist check
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_EXTENSIONS.includes(ext)) {
      throw new BadRequestException('File type not allowed');
    }

    const safeOriginal = file.originalname
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 100);
    const dateDir = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    const storagePath = path.join(dateDir, `${Date.now()}-${safeOriginal}`);
    const fullPath = path.join(UPLOAD_DIR, storagePath);

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, file.buffer);

    return this.prisma.attachment.create({
      data: {
        filename: `${Date.now()}-${safeOriginal}`,
        originalName: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        storagePath,
        entityType,
        entityId,
        uploadedById,
      },
    });
  }

  async findByEntity(entityType: string, entityId: string) {
    return this.prisma.attachment.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const attachment = await this.prisma.attachment.findUnique({ where: { id } });
    if (!attachment) throw new NotFoundException('Attachment not found');
    return attachment;
  }

  /**
   * Attachment ids are guessable enough that "logged in" is not authorisation.
   * Staff see everything. A customer only sees files hanging off something they
   * own — never product, job, printer or material files, which are internal
   * print data.
   *
   * Ownership resolves through entityType/entityId, not the orderId/quoteId/
   * designProjectId columns on Attachment: nothing writes those, so a check
   * against them would deny every customer, including for their own files.
   * Anything not listed here is internal and denied by default, so a new
   * entityType has to be opted in deliberately rather than leaking by omission.
   */
  async assertCanRead(id: string, user: any) {
    const attachment = await this.findOne(id);
    if (user?.userType === 'staff') return attachment;
    if (user?.userType !== 'customer') throw new ForbiddenException('Not allowed');

    const owns = await this.customerOwns(attachment, user.id);
    if (!owns) throw new ForbiddenException('Not allowed');
    return attachment;
  }

  private async customerOwns(
    attachment: { entityType: string; entityId: string },
    customerId: string,
  ): Promise<boolean> {
    const type = (attachment.entityType || '').toLowerCase();
    const entityId = attachment.entityId;
    if (!entityId) return false;

    switch (type) {
      case 'order':
        return !!(await this.prisma.order.findFirst({
          where: { id: entityId, customerId }, select: { id: true },
        }));
      case 'quote':
        return !!(await this.prisma.quote.findFirst({
          where: { id: entityId, customerId }, select: { id: true },
        }));
      case 'designproject':
      case 'design_project':
        return !!(await this.prisma.designProject.findFirst({
          where: { id: entityId, customerId }, select: { id: true },
        }));
      case 'invoice':
        // Invoices hang off an order rather than the customer directly.
        return !!(await this.prisma.invoice.findFirst({
          where: { id: entityId, order: { customerId } }, select: { id: true },
        }));
      default:
        return false;
    }
  }

  async getFilePath(id: string): Promise<string> {
    const attachment = await this.findOne(id);
    return path.join(UPLOAD_DIR, attachment.storagePath);
  }

  async remove(id: string) {
    const attachment = await this.findOne(id);
    const fullPath = path.join(UPLOAD_DIR, attachment.storagePath);

    try {
      await fs.unlink(fullPath);
    } catch {}

    return this.prisma.attachment.delete({ where: { id } });
  }
}
