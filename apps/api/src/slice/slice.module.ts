import { forwardRef, Module } from '@nestjs/common';
import { FileParserModule } from '../file-parser/file-parser.module';
import { ProductsModule } from '../products/products.module';
import { SlicerProfilesModule } from '../slicer-profiles/slicer-profiles.module';
import { SidecarSliceClient } from './sidecar-slice.client';
import { SliceController } from './slice.controller';
import { SliceProcessor } from './slice.processor';
import { SliceService } from './slice.service';

/**
 * Slice runs (slicer plan WP5). Imports ProductsModule for the plate services
 * it writes through, and is imported back by it (forwardRef) so a source
 * upload can queue its validation run. EventsGateway comes from the @Global
 * GatewayModule; ScheduleModule.forRoot() in AppModule drives the processor.
 */
@Module({
  imports: [forwardRef(() => ProductsModule), SlicerProfilesModule, FileParserModule],
  controllers: [SliceController],
  providers: [SliceService, SliceProcessor, SidecarSliceClient],
  // The processor and the sidecar client are shared with the order-plates module (one slice queue).
  exports: [SliceService, SliceProcessor, SidecarSliceClient],
})
export class SliceModule {}
