import { Controller, Get, Post, Patch, Param, Body, UseGuards } from '@nestjs/common';
import { PrintersService } from './printers.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreatePrinterDto, UpdatePrinterDto } from '@printforge/types';

@Controller('printers')
@UseGuards(JwtAuthGuard)
export class PrintersController {
  constructor(private printersService: PrintersService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  create(@Body() dto: CreatePrinterDto) {
    return this.printersService.create(dto);
  }

  @Get()
  findAll() {
    return this.printersService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.printersService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdatePrinterDto) {
    return this.printersService.update(id, dto);
  }
}
