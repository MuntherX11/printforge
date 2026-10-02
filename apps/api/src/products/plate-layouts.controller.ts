import { Body, Controller, Delete, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PlateFilesService } from './plate-files.service';
import { PlateLayoutsService } from './plate-layouts.service';

/** Plate layouts of a component (spec §4.3 M3–M5) and every plate's print file. Write-guarded. */
@Controller('products')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'OPERATOR')
export class PlateLayoutsController {
  constructor(
    private readonly layouts: PlateLayoutsService,
    private readonly files: PlateFilesService,
  ) {}

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

  /** Upload a G-code onto a layout that has no file. */
  @Post(':id/components/:componentId/plate-layouts/:layoutId/file')
  attachLayoutFile(@Param('id') id: string, @Param('componentId') componentId: string, @Param('layoutId') layoutId: string, @Body() body: unknown) {
    return this.files.attach(id, componentId, layoutId, body);
  }

  /** Delete a layout's file (409 while an open job prints it). */
  @Delete(':id/components/:componentId/plate-layouts/:layoutId/file')
  removeLayoutFile(@Param('id') id: string, @Param('componentId') componentId: string, @Param('layoutId') layoutId: string) {
    return this.files.remove(id, componentId, layoutId);
  }

  /** Upload a G-code onto the component's own single unit when it has none. */
  @Post(':id/components/:componentId/file')
  attachComponentFile(@Param('id') id: string, @Param('componentId') componentId: string, @Body() body: unknown) {
    return this.files.attach(id, componentId, null, body);
  }

  /** Delete the component's own file (409 while an open job prints it). */
  @Delete(':id/components/:componentId/file')
  removeComponentFile(@Param('id') id: string, @Param('componentId') componentId: string) {
    return this.files.remove(id, componentId, null);
  }
}
