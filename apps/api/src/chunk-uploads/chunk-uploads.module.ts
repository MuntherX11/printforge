import { Module } from '@nestjs/common';
import { ChunkUploadsController } from './chunk-uploads.controller';
import { ChunkUploadsService } from './chunk-uploads.service';

@Module({
  controllers: [ChunkUploadsController],
  providers: [ChunkUploadsService],
  exports: [ChunkUploadsService],
})
export class ChunkUploadsModule {}
