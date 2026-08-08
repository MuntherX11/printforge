import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards, Res, StreamableFile } from '@nestjs/common';
import { Response } from 'express';
import { SpoolsService } from './spools.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateSpoolDto, UpdateSpoolDto, AdjustSpoolWeightDto } from '@printforge/types';
import { Public } from '../auth/decorators/public.decorator';

@Controller('spools')
@UseGuards(JwtAuthGuard)
export class SpoolsController {
  constructor(private spoolsService: SpoolsService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  create(@Body() dto: CreateSpoolDto) {
    return this.spoolsService.create(dto);
  }

  @Get()
  findAll(@Query('materialId') materialId?: string) {
    return this.spoolsService.findAll(materialId);
  }

  @Public()
  @Get('by-pfid/:pfid')
  findByPfid(@Param('pfid') pfid: string) {
    return this.spoolsService.findByPfid(pfid);
  }

  @Post('qr-labels')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  async generateQrLabels(@Body() body: { spoolIds: string[] }, @Res() res: Response) {
    const pdfBuffer = await this.spoolsService.generateQrLabelsPdf(body.spoolIds);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="spool-qr-labels.pdf"',
      'Content-Length': pdfBuffer.length,
    });
    res.end(pdfBuffer);
  }

  /** Every selected spool's QR as its own PNG, delivered as a zip. */
  @Post('qr-images')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  async generateQrImages(
    @Body() body: { spoolIds: string[]; size?: number },
    @Res() res: Response,
  ) {
    const { buffer, count } = await this.spoolsService.generateQrImagesZip(body.spoolIds, {
      size: body.size,
    });
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="spool-qr-images-${count}.zip"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  /** A single spool's QR as a standalone PNG. */
  @Get(':id/qr.png')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  async generateQrPng(
    @Param('id') id: string,
    @Query('size') size: string | undefined,
    @Res() res: Response,
  ) {
    const { png, filename } = await this.spoolsService.generateQrPng(id, size ? Number(size) : 600);
    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': png.length,
    });
    res.end(png);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.spoolsService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  update(@Param('id') id: string, @Body() dto: UpdateSpoolDto) {
    return this.spoolsService.update(id, dto);
  }

  @Post(':id/adjust')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  adjustWeight(@Param('id') id: string, @Body() dto: AdjustSpoolWeightDto) {
    return this.spoolsService.adjustWeight(id, dto);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  remove(@Param('id') id: string) {
    return this.spoolsService.remove(id);
  }
}
