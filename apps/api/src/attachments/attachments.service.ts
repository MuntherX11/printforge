import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
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
