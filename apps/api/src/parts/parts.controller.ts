import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { PartsService } from './parts.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreatePartDto, UpdatePartDto, AdjustPartStockDto } from '@printforge/types';
import { PaginationDto } from '../common/dto/pagination.dto';

@Controller('parts')
@UseGuards(JwtAuthGuard)
export class PartsController {
  constructor(private partsService: PartsService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  create(@Body() dto: CreatePartDto) {
    return this.partsService.create(dto);
  }

  @Get()
  findAll(
    @Query() pagination: PaginationDto,
    @Query('page') rawPage?: string,
    @Query('category') category?: string,
  ) {
    return this.partsService.findAll(pagination, rawPage !== undefined, category);
  }

  @Get('low-stock')
  @UseGuards(StaffGuard)
  getLowStock() {
    return this.partsService.getLowStock();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.partsService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  update(@Param('id') id: string, @Body() dto: UpdatePartDto) {
    return this.partsService.update(id, dto);
  }

  @Post(':id/adjust-stock')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  adjustStock(@Param('id') id: string, @Body() dto: AdjustPartStockDto) {
    return this.partsService.adjustStock(id, Number(dto.delta));
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  remove(@Param('id') id: string) {
    return this.partsService.remove(id);
  }
}
