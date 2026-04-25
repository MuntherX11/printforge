import { Controller, Get, Post, Delete, Param, Query, Res, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import * as fs from 'fs/promises';
import { AttachmentsService } from './attachments.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('attachments')
@UseGuards(JwtAuthGuard)
export class AttachmentsController {
  constructor(private attachmentsService: AttachmentsService) {}

  @Post('upload')
  @UseGuards(StaffGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }))
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Query('entityType') entityType: string,
    @Query('entityId') entityId: string,
    @CurrentUser() user: any,
  ) {
    return this.attachmentsService.upload(file, entityType, entityId, user.id);
  }

  @Get()
  @UseGuards(StaffGuard)
  findByEntity(@Query('entityType') entityType: string, @Query('entityId') entityId: string) {
    return this.attachmentsService.findByEntity(entityType, entityId);
  }

  @Get(':id/download')
  async download(@Param('id') id: string, @Res() res: Response) {
    const attachment = await this.attachmentsService.findOne(id);
    const filePath = await this.attachmentsService.getFilePath(id);

    const fileBuffer = await fs.readFile(filePath);

    // L-2: Sanitize filename to prevent header injection
    const safeName = attachment.originalName.replace(/[^\w\s.\-]/g, '_').trim();

    // H-1: Force octet-stream for SVG to prevent XSS via script execution
    const contentType = attachment.mimeType.includes('svg')
      ? 'application/octet-stream'
      : attachment.mimeType;

    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Content-Length': fileBuffer.length,
    });
    res.end(fileBuffer);
  }

  @Delete(':id')
  @UseGuards(StaffGuard)
  remove(@Param('id') id: string) {
    return this.attachmentsService.remove(id);
  }
}
