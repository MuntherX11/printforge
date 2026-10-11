import { Module } from '@nestjs/common';
import { SlicerProfilesController } from './slicer-profiles.controller';
import { SlicerProfilesService } from './slicer-profiles.service';
import { SidecarClient } from './sidecar.client';

@Module({
  controllers: [SlicerProfilesController],
  providers: [SlicerProfilesService, SidecarClient],
  exports: [SlicerProfilesService, SidecarClient],
})
export class SlicerProfilesModule {}
