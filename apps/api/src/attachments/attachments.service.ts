import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import * as path from 'path';
import * as fs from 'fs/promises';

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads';

@Injectable()
export class AttachmentsService {
  constructor(private prisma: PrismaService) {}

  async upload(file: Express.Multer.File, entityType: string, entityId: string, uploadedById?: string) {
    const dateDir = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    const storagePath = path.join(dateDir, `${Date.now()}-${file.originalname}`);
    const fullPath = path.join(UPLOAD_DIR, storagePath);

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, file.buffer);

    return this.prisma.attachment.create({
      data: {
        filename: `${Date.now()}-${file.originalname}`,
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
