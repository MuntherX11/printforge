import { Module } from '@nestjs/common';
import { AddonsController } from './addons.controller';
import { AddonsService } from './addons.service';
import { ChunkUploadsModule } from '../chunk-uploads/chunk-uploads.module';

@Module({
  imports: [ChunkUploadsModule],
  controllers: [AddonsController],
  providers: [AddonsService],
  exports: [AddonsService],
})
export class AddonsModule {}
