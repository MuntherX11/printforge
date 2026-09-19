import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ColourSlotsService } from './colour-slots.service';
import { confirmOf, flag } from './product-input';

/** Colour slots and links (spec §4.1 C1–C5). None of these reprices. */
@Controller('products')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'OPERATOR')
export class ColourSlotsController {
  constructor(private readonly slots: ColourSlotsService) {}

  /** C1 */
  @Post(':id/colour-slots')
  create(@Param('id') id: string, @Body() body: unknown) {
    return this.slots.create(id, body);
  }

  /** C2 */
  @Patch(':id/colour-slots/:slotId')
  update(@Param('id') id: string, @Param('slotId') slotId: string, @Body() body: unknown) {
    return this.slots.update(id, slotId, body);
  }

  /** C3 */
  @Delete(':id/colour-slots/:slotId')
  remove(@Param('id') id: string, @Param('slotId') slotId: string, @Body() body: unknown, @Query('dryRun') dryRun?: string, @Query('confirm') confirm?: string) {
    return this.slots.remove(id, slotId, flag(dryRun), confirmOf(body, confirm));
  }

  /** C4 */
  @Put(':id/colour-links')
  saveLinks(@Param('id') id: string, @Body() body: unknown, @Query('dryRun') dryRun?: string) {
    return this.slots.saveLinks(id, body, flag(dryRun));
  }

  /** C5 (read-only, but Write-guarded: it feeds the edit dialog) */
  @Get(':id/colour-links/proposal')
  proposal(@Param('id') id: string) {
    return this.slots.proposal(id);
  }
}
