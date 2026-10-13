import { Module } from '@nestjs/common';
import { CatalogCoreModule } from '../catalog-core/catalog-core.module';
import { FileParserModule } from '../file-parser/file-parser.module';
import { ProductionModule } from '../production/production.module';
import { SliceModule } from '../slice/slice.module';
import { SlicerProfilesModule } from '../slicer-profiles/slicer-profiles.module';
import { OrderNeedsService } from './order-needs.service';
import { OrderPlateJobsService } from './order-plate-jobs.service';
import { OrderPlateSlicer } from './order-plate-slicer';
import { OrderPlatesController } from './order-plates.controller';
import { OrderPlatesService } from './order-plates.service';

/**
 * Print files for a whole order (v2.19.0). Reads the order's production plan
 * from ProductionModule, the resolver, planner and stock ledger from
 * CatalogCoreModule, and shares SliceModule's queue and sidecar client: the
 * slicer registers itself with the slice processor on start, so nothing in
 * SliceModule imports this module. EventsGateway comes from the @Global
 * GatewayModule.
 */
@Module({
  imports: [CatalogCoreModule, ProductionModule, SliceModule, SlicerProfilesModule, FileParserModule],
  controllers: [OrderPlatesController],
  providers: [OrderNeedsService, OrderPlatesService, OrderPlateSlicer, OrderPlateJobsService],
})
export class OrderPlatesModule {}
