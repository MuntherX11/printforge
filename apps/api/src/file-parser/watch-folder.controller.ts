import { Controller, Get, Post, Param, Body, UseGuards, NotFoundException } from '@nestjs/common';
import { WatchFolderService } from './watch-folder.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * Importing a file creates a product, and dismissing one hides it from the
 * people who would import it, so both are ADMIN or OPERATOR like every other
 * product write. VIEWER and ACCOUNTING could do both before (StaffGuard only).
 * The pending list stays readable by every staff role.
 */
export const WATCH_FOLDER_WRITE_ROLES = ['ADMIN', 'OPERATOR'] as const;

@Controller('watch-folder')
@UseGuards(JwtAuthGuard, StaffGuard)
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
  @UseGuards(RolesGuard)
  @Roles(...WATCH_FOLDER_WRITE_ROLES)
  dismiss(@Param('id') id: string) {
    const ok = this.watchFolder.dismiss(id);
    if (!ok) throw new NotFoundException('Import not found');
    return { success: true };
  }

  /**
   * Import a watched file as a product with auto-BOM. The body is parsed by
   * parseWatchImport (name, sku, materialId only).
   */
  @Post(':id/import')
  @UseGuards(RolesGuard)
  @Roles(...WATCH_FOLDER_WRITE_ROLES)
  async importAsProduct(@Param('id') id: string, @Body() body: unknown) {
    const product = await this.watchFolder.importAsProduct(id, body);
    if (!product) throw new NotFoundException('Import not found or already processed');
    return product;
  }
}
