import { Body, Controller, Delete, Param, Post, UseGuards } from '@nestjs/common';
import type { ComponentFromModelResult, ModelInspectResult, SourceModelUploadResult } from '@printforge/types';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ComponentFromModelService } from './component-from-model.service';
import { ProductSourcesService } from './product-sources.service';

/**
 * The source model of a part (slicer plan WP4). ADMIN only until the owner has
 * run the slicer end to end on live (plan "Staging"). The file arrives through
 * the chunk uploader (`{ assembledUploadId }`, 200 MB), like `onboard-3mf`.
 *
 * A part can also be made from the model alone: `model-inspect` says what a
 * staged file is (kind, slots, printer) and `components/from-model` creates
 * the part with its source and queues the validation slice that measures it.
 */
@Controller('products')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class ProductSourcesController {
  constructor(
    private readonly sources: ProductSourcesService,
    private readonly fromModel: ComponentFromModelService,
  ) {}

  @Post(':id/model-inspect')
  inspect(@Param('id') id: string, @Body() body: unknown): Promise<ModelInspectResult> {
    return this.sources.inspect(id, body);
  }

  /** Static segment: declared before the `:cid` routes (no POST `:id/components/:cid` exists to shadow it, and none may be added above). */
  @Post(':id/components/from-model')
  createFromModel(@Param('id') id: string, @Body() body: unknown): Promise<ComponentFromModelResult> {
    return this.fromModel.create(id, body);
  }

  @Post(':id/components/:cid/source')
  upload(@Param('id') id: string, @Param('cid') cid: string, @Body() body: unknown): Promise<SourceModelUploadResult> {
    return this.sources.upload(id, cid, body);
  }

  @Delete(':id/components/:cid/source')
  remove(@Param('id') id: string, @Param('cid') cid: string): Promise<{ deleted: true }> {
    return this.sources.remove(id, cid);
  }
}
