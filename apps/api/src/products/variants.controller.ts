import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { OptionConversionService, type ConversionActor } from './option-conversion.service';
import { flag } from './product-input';
import { VariantsService } from './variants.service';

/**
 * Sizes and colours (spec §4.2 O1–O7). O1, O2, O4 and O6 reuse the paths of the
 * pre-release variant routes, which ProductsController no longer serves; the
 * variant `onboard-gcode` route is gone. O8a/O8 convert a legacy "N per plate"
 * option into a plate layout.
 */
@Controller('products')
@UseGuards(JwtAuthGuard)
export class VariantsController {
  constructor(
    private readonly variants: VariantsService,
    private readonly conversion: OptionConversionService,
  ) {}

  /** O1 */
  @Post(':id/variants')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  create(@Param('id') id: string, @Body() body: unknown) {
    return this.variants.create(id, body);
  }

  /** O2 */
  @Patch(':id/variants/:variantId')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  update(@Param('id') id: string, @Param('variantId') variantId: string, @Body() body: unknown) {
    return this.variants.update(id, variantId, body);
  }

  /** O3 */
  @Get(':id/variants/:variantId/history')
  @UseGuards(StaffGuard)
  history(@Param('id') id: string, @Param('variantId') variantId: string) {
    return this.variants.history(id, variantId);
  }

  /** O4 */
  @Delete(':id/variants/:variantId')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  remove(@Param('id') id: string, @Param('variantId') variantId: string) {
    return this.variants.remove(id, variantId);
  }

  /** O5 */
  @Put(':id/variants/:variantId/colour-slots')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  setAssignments(@Param('id') id: string, @Param('variantId') variantId: string, @Body() body: unknown, @Query('dryRun') dryRun?: string) {
    return this.variants.setAssignments(id, variantId, body, flag(dryRun));
  }

  /** O6 */
  @Post(':id/variants/:variantId/calculate')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  calculate(@Param('id') id: string, @Param('variantId') variantId: string) {
    return this.variants.calculate(id, variantId);
  }

  /** O7 */
  @Put(':id/option-kinds')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  setKinds(@Param('id') id: string, @Body() body: unknown) {
    return this.variants.setKinds(id, body);
  }

  /** O8a: what Convert to plate would create and change (a read; not audited). */
  @Get(':id/variants/:variantId/convert-to-layout')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  previewConversion(@Param('id') id: string, @Param('variantId') variantId: string, @Query() query: Record<string, unknown>) {
    return this.conversion.preview(id, variantId, query);
  }

  /** O8: the option becomes a plate layout on one part and is switched off. */
  @Post(':id/variants/:variantId/convert-to-layout')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  convertToLayout(@Param('id') id: string, @Param('variantId') variantId: string, @Body() body: unknown, @CurrentUser() user: ConversionActor) {
    return this.conversion.convert(id, variantId, body, user);
  }
}
