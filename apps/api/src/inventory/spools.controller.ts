import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards, Res, StreamableFile } from '@nestjs/common';
import { Response } from 'express';
import { SpoolsService } from './spools.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateSpoolDto, UpdateSpoolDto, AdjustSpoolWeightDto } from '@printforge/types';

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
