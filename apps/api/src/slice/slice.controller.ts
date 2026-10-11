import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import type { SliceRunDto } from '@printforge/types';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SliceService } from './slice.service';

/**
 * Slice runs (slicer plan WP5). Queueing and cancelling are OPERATOR/ADMIN;
 * the run list is readable by every staff role but VIEWER.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class SliceController {
  constructor(private readonly slice: SliceService) {}

  @Post('products/:id/components/:cid/slice')
  @Roles('ADMIN', 'OPERATOR')
  create(@Param('id') id: string, @Param('cid') cid: string, @Body() body: unknown): Promise<SliceRunDto> {
    return this.slice.create(id, cid, body);
  }

  @Get('products/:id/components/:cid/slice-runs')
  @Roles('ADMIN', 'OPERATOR', 'ACCOUNTING')
  list(@Param('id') id: string, @Param('cid') cid: string): Promise<SliceRunDto[]> {
    return this.slice.list(id, cid);
  }

  @Delete('slice-runs/:id')
  @Roles('ADMIN', 'OPERATOR')
  cancel(@Param('id') id: string): Promise<{ deleted: true }> {
    return this.slice.cancel(id);
  }
}
