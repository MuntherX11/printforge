import { Controller, Get, Post, Patch, Delete, Param, Body, Res, UseGuards, UseInterceptors, UploadedFile, BadRequestException, NotFoundException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { MaterialsService } from './materials.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StaffGuard } from '../auth/guards/staff.guard';
import { CreateMaterialDto, UpdateMaterialDto } from '@printforge/types';
import ExcelJS from 'exceljs';

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
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new BadRequestException('No worksheet found in file');
    const rows: any[] = [];
    let headers: string[] = [];
    sheet.eachRow((row, rowNumber) => {
      const values = (row.values as any[]).slice(1); // row.values is 1-indexed; index 0 is null
      if (rowNumber === 1) {
        headers = values.map((v: any) => String(v ?? '').trim());
      } else {
        const obj: any = {};
        headers.forEach((h, i) => { obj[h] = values[i] ?? null; });
        rows.push(obj);
      }
    });
    if (rows.length === 0) throw new BadRequestException('File is empty');
    return this.materialsService.bulkImport(rows);
  }

  @Get('template')
  async downloadTemplate(@Res() res: Response) {
    const headers = ['name', 'type', 'color', 'brand', 'costPerGram', 'density', 'reorderPoint'];
    const example = ['PLA White', 'PLA', 'White', 'eSUN', '0.009', '1.24', '500'];
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Materials');
    ws.addRow(headers);
    ws.addRow(example);
    const buf = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=materials-template.xlsx');
    res.send(Buffer.from(buf as ArrayBuffer));
  }

  @Get('low-stock')
  @UseGuards(StaffGuard)
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
