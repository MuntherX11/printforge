import { Controller, Get, Post, Patch, Delete, Param, Body, Res, UseGuards, UseInterceptors, UploadedFile, BadRequestException, NotFoundException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { MaterialsService } from './materials.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateMaterialDto, UpdateMaterialDto } from '@printforge/types';
import * as XLSX from 'xlsx';

@Controller('materials')
@UseGuards(JwtAuthGuard)
export class MaterialsController {
  constructor(private materialsService: MaterialsService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  create(@Body() dto: CreateMaterialDto) {
    return this.materialsService.create(dto);
  }

  @Get()
  findAll() {
    return this.materialsService.findAll();
  }

  @Post('bulk-upload')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  @UseInterceptors(FileInterceptor('file'))
  async bulkUpload(@UploadedFile() file: any) {
    if (!file) throw new BadRequestException('No file uploaded');
    const ext = file.originalname?.toLowerCase() || '';
    if (!ext.endsWith('.xlsx') && !ext.endsWith('.xls') && !ext.endsWith('.csv')) {
      throw new BadRequestException('File must be .xlsx, .xls, or .csv');
    }
    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet) as any[];
    if (rows.length === 0) throw new BadRequestException('File is empty');
    return this.materialsService.bulkImport(rows);
  }

  @Get('template')
  downloadTemplate(@Res() res: Response) {
    const headers = ['name', 'type', 'color', 'brand', 'costPerGram', 'density', 'reorderPoint'];
    const example = ['PLA White', 'PLA', 'White', 'eSUN', '0.009', '1.24', '500'];
    const ws = XLSX.utils.aoa_to_sheet([headers, example]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Materials');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=materials-template.xlsx');
    res.send(buf);
  }

  @Get('low-stock')
  getLowStock() {
    return this.materialsService.getLowStock();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.materialsService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  update(@Param('id') id: string, @Body() dto: UpdateMaterialDto) {
    return this.materialsService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  async remove(@Param('id') id: string) {
    return this.materialsService.remove(id);
  }
}
