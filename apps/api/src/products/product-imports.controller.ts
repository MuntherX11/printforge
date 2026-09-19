import { Controller, Post, Body, Param, UseGuards, UseInterceptors, UploadedFile, UploadedFiles, BadRequestException } from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';

import { ProductsService } from './products.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ChunkUploadsService } from '../chunk-uploads/chunk-uploads.service';

/**
 * Slicer imports (spec §4.3 M1, M2). Moved verbatim from ProductsController by
 * WP4 — same paths, guards and bodies. WP5 owns every behavioural change.
 */
@Controller('products')
@UseGuards(JwtAuthGuard)
export class ProductImportsController {
  constructor(
    private productsService: ProductsService,
    private chunkUploads: ChunkUploadsService,
  ) {}

  @Post(':id/onboard-gcode')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  @UseInterceptors(FilesInterceptor('files', 20, { limits: { fileSize: 200 * 1024 * 1024 } }))
  async onboardGcode(
    @Param('id') id: string,
    @UploadedFiles() files: any[],
    @Body('assembledUploadIds') assembledIdsRaw?: string,
  ) {
    // Files above Cloudflare's per-request cap arrive pre-staged via
    // /chunk-uploads; both forms can mix in one call.
    if (assembledIdsRaw) {
      let ids: string[];
      try { ids = JSON.parse(assembledIdsRaw); } catch { throw new BadRequestException('assembledUploadIds must be JSON'); }
      if (!Array.isArray(ids)) throw new BadRequestException('assembledUploadIds must be an array');
      files = [...(files ?? [])];
      for (const cid of ids) files.push(await this.chunkUploads.consume(String(cid), 200 * 1024 * 1024));
    }
    if (!files?.length) throw new BadRequestException('No files uploaded');
    return this.productsService.onboardFromGcode(id, files);
  }

  @Post(':id/onboard-3mf')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 200 * 1024 * 1024 } }))
  async onboardThreeMf(
    @Param('id') id: string,
    @UploadedFile() file: any,
    @Body('selectedPlates') selectedPlatesRaw: string,
    @Body('plateNames') plateNamesRaw?: string,
    @Body('assembledUploadId') assembledId?: string,
  ) {
    if (!file && assembledId) file = await this.chunkUploads.consume(assembledId, 200 * 1024 * 1024);
    if (!file) throw new BadRequestException('No file uploaded');
    if (!file.originalname?.toLowerCase().endsWith('.3mf')) {
      throw new BadRequestException('File must be a .3mf');
    }
    let selectedPlates: number[];
    let plateNames: Record<string, string>;
    try {
      selectedPlates = JSON.parse(selectedPlatesRaw || '[]');
      plateNames = plateNamesRaw ? JSON.parse(plateNamesRaw) : {};
    } catch {
      throw new BadRequestException('selectedPlates and plateNames must be valid JSON');
    }
    if (!Array.isArray(selectedPlates) || !selectedPlates.every((n) => typeof n === 'number')) {
      throw new BadRequestException('selectedPlates must be an array of numbers');
    }
    if (!selectedPlates.length) throw new BadRequestException('No plates selected');
    return this.productsService.onboardFromThreeMf(id, file.buffer, { selectedPlates, plateNames });
  }
}
