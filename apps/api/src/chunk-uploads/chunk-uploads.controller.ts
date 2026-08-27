import { Controller, Post, Put, Param, Body, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import { ChunkUploadsService } from './chunk-uploads.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * Staging area for uploads too big for one request through Cloudflare.
 * Staff-only: every endpoint that redeems an assembled upload is staff-side.
 * Throttling is skipped on parts — a 300 MB file is six 50 MB requests in
 * quick succession, which is exactly what rate limiting would misread.
 */
@Controller('chunk-uploads')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'OPERATOR')
export class ChunkUploadsController {
  constructor(private chunks: ChunkUploadsService) {}

  @Post()
  init(@Body() body: { filename?: string }) {
    return this.chunks.init(body?.filename);
  }

  @Put(':id/parts/:index')
  @SkipThrottle({ short: true, medium: true, long: true })
  @UseInterceptors(FileInterceptor('part', { limits: { fileSize: 50 * 1024 * 1024 } }))
  putPart(
    @Param('id') id: string,
    @Param('index') index: string,
    @UploadedFile() part: Express.Multer.File,
  ) {
    return this.chunks.putPart(id, Number(index), part);
  }

  @Post(':id/complete')
  complete(@Param('id') id: string, @Body() body: { totalParts?: number }) {
    return this.chunks.complete(id, Number(body?.totalParts));
  }
}
