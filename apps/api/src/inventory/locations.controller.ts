import { Controller, Get, Post, Patch, Put, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { LocationsService } from './locations.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateStorageLocationDto, UpdateStorageLocationDto } from '@printforge/types';

@Controller('locations')
@UseGuards(JwtAuthGuard)
export class LocationsController {
  constructor(private locationsService: LocationsService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  create(@Body() dto: CreateStorageLocationDto) {
    return this.locationsService.create(dto);
  }

  @Get()
  findAll() {
    return this.locationsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.locationsService.findOne(id);
  }

  /** Spools that can be placed here (unassigned + already here). */
  @Get(':id/assignable-spools')
  assignableSpools(@Param('id') id: string) {
    return this.locationsService.assignableSpools(id);
  }

  /** Replace the set of spools stored in this location. */
  @Put(':id/spools')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  setSpools(@Param('id') id: string, @Body() body: { spoolIds: string[] }) {
    return this.locationsService.setSpools(id, body?.spoolIds ?? []);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  update(@Param('id') id: string, @Body() dto: UpdateStorageLocationDto) {
    return this.locationsService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  remove(@Param('id') id: string) {
    return this.locationsService.remove(id);
  }
}
