import { Controller, Get, Post, Param, Body, UseGuards, NotFoundException } from '@nestjs/common';
import { WatchFolderService } from './watch-folder.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('watch-folder')
@UseGuards(JwtAuthGuard)
export class WatchFolderController {
  constructor(private watchFolder: WatchFolderService) {}

  /**
   * Get all pending file imports from the watch folder.
   */
  @Get('pending')
  getPending() {
    return this.watchFolder.getPending();
  }

  /**
   * Get all imports (including imported/dismissed).
   */
  @Get()
  getAll() {
    return this.watchFolder.getAll();
  }

  /**
   * Dismiss a pending import.
   */
  @Post(':id/dismiss')
  dismiss(@Param('id') id: string) {
    const ok = this.watchFolder.dismiss(id);
    if (!ok) throw new NotFoundException('Import not found');
    return { success: true };
  }

  /**
   * Import a watched file as a product with auto-BOM.
   */
  @Post(':id/import')
  async importAsProduct(
    @Param('id') id: string,
    @Body() body: { name: string; sku?: string; materialId?: string },
  ) {
    const product = await this.watchFolder.importAsProduct(id, body);
    if (!product) throw new NotFoundException('Import not found or already processed');
    return product;
  }
}
