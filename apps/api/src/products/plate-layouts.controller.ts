import { Body, Controller, Delete, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PlateLayoutsService } from './plate-layouts.service';

/** Plate layouts of a component (spec §4.3 M3–M5). Write-guarded. */
@Controller('products')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'OPERATOR')
export class PlateLayoutsController {
  constructor(private readonly layouts: PlateLayoutsService) {}

  /** M3 */
  @Post(':id/components/:componentId/plate-layouts')
  create(@Param('id') id: string, @Param('componentId') componentId: string, @Body() body: unknown) {
    return this.layouts.create(id, componentId, body);
  }

  /** M4 */
  @Patch(':id/components/:componentId/plate-layouts/:layoutId')
  update(@Param('id') id: string, @Param('componentId') componentId: string, @Param('layoutId') layoutId: string, @Body() body: unknown) {
    return this.layouts.update(id, componentId, layoutId, body);
  }

  /** M5 */
  @Delete(':id/components/:componentId/plate-layouts/:layoutId')
  remove(@Param('id') id: string, @Param('componentId') componentId: string, @Param('layoutId') layoutId: string) {
    return this.layouts.remove(id, componentId, layoutId);
  }
}
