import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
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
}
