import { Module } from '@nestjs/common';
import { MaterialsController } from './materials.controller';
import { MaterialsService } from './materials.service';
import { SpoolsController } from './spools.controller';
import { SpoolsService } from './spools.service';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';
import { FilamentCatalogController } from './filament-catalog.controller';
import { FilamentCatalogService } from './filament-catalog.service';
import { MaterialMergeController } from './material-merge.controller';
import { MaterialMergeService } from './material-merge.service';
import { CatalogCoreModule } from '../catalog-core/catalog-core.module';

@Module({
  // CatalogCoreModule: PricingService, to reprice the products a filament merge touches.
  imports: [CatalogCoreModule],
  controllers: [MaterialsController, MaterialMergeController, SpoolsController, LocationsController, FilamentCatalogController],
  providers: [MaterialsService, MaterialMergeService, SpoolsService, LocationsService, FilamentCatalogService],
  exports: [MaterialsService, SpoolsService, LocationsService, FilamentCatalogService],
})
export class InventoryModule {}
