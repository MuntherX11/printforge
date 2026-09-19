import { BadRequestException, Body, Controller, Param, Post, UploadedFile, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import type { ProductDetail, SlicerImportResult } from '@printforge/types';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ChunkUploadsService } from '../chunk-uploads/chunk-uploads.service';
import { ProductOnboardingService, type ImportFile } from './product-onboarding.service';
import { ProductsService } from './products.service';
import { MAX_IMPORT_FILES, parseGcodeImport, parseThreeMfImport } from './slicer-import-input';

const MAX_BYTES = 200 * 1024 * 1024;

/**
 * Slicer imports (spec §4.3 M1, M2, §3.12). Every field is validated first;
 * staged uploads are then read with `{ keep: true }` and discarded only after
 * the import commits, so a large staged file survives a failed or rejected
 * attempt and can be retried without uploading it again.
 */
@Controller('products')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'OPERATOR')
export class ProductImportsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly onboarding: ProductOnboardingService,
    private readonly chunkUploads: ChunkUploadsService,
  ) {}

  /** M1 */
  @Post(':id/onboard-gcode')
  @UseInterceptors(FilesInterceptor('files', MAX_IMPORT_FILES, { limits: { fileSize: MAX_BYTES } }))
  async onboardGcode(@Param('id') id: string, @UploadedFiles() uploaded: any[], @Body() body: unknown): Promise<SlicerImportResult<ProductDetail>> {
    const direct: ImportFile[] = uploaded ?? [];
    const input = parseGcodeImport(body, direct.length);
    const files: ImportFile[] = [...direct];
    for (const cid of input.assembledUploadIds) files.push(await this.chunkUploads.consume(cid, MAX_BYTES, { keep: true }));
    if (!files.length) throw new BadRequestException('No files uploaded');
    const out = await this.onboarding.onboardFromGcode(id, files, input);
    for (const cid of input.assembledUploadIds) await this.chunkUploads.discard(cid);
    return { ...out, product: await this.productsService.findOne(id) };
  }

  /** M2 */
  @Post(':id/onboard-3mf')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES } }))
  async onboardThreeMf(
    @Param('id') id: string,
    @UploadedFile() uploaded: any,
    @Body() body: unknown,
    @Body('assembledUploadId') assembledId?: string,
  ): Promise<SlicerImportResult<ProductDetail>> {
    const input = parseThreeMfImport(body);
    if (!uploaded && !assembledId) throw new BadRequestException('No file uploaded');
    const file: ImportFile = uploaded ?? (await this.chunkUploads.consume(String(assembledId), MAX_BYTES, { keep: true }));
    if (!String(file.originalname ?? '').toLowerCase().endsWith('.3mf')) throw new BadRequestException('File must be a .3mf');
    const out = await this.onboarding.onboardFromThreeMf(id, file.buffer, input);
    if (!uploaded && assembledId) await this.chunkUploads.discard(String(assembledId));
    return { ...out, product: await this.productsService.findOne(id) };
  }
}
