import { Body, Controller, Delete, Param, Post, UseGuards } from '@nestjs/common';
import type { SourceModelUploadResult } from '@printforge/types';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ProductSourcesService } from './product-sources.service';

/**
 * The source model of a part (slicer plan WP4). ADMIN only until the owner has
 * run the slicer end to end on live (plan "Staging"). The file arrives through
 * the chunk uploader (`{ assembledUploadId }`, 200 MB), like `onboard-3mf`.
 */
@Controller('products')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class ProductSourcesController {
  constructor(private readonly sources: ProductSourcesService) {}

  @Post(':id/components/:cid/source')
  upload(@Param('id') id: string, @Param('cid') cid: string, @Body() body: unknown): Promise<SourceModelUploadResult> {
    return this.sources.upload(id, cid, body);
  }

  @Delete(':id/components/:cid/source')
  remove(@Param('id') id: string, @Param('cid') cid: string): Promise<{ deleted: true }> {
    return this.sources.remove(id, cid);
  }
}
