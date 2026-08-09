import { Module } from '@nestjs/common';
import { MaterialsController } from './materials.controller';
import { MaterialsService } from './materials.service';
import { SpoolsController } from './spools.controller';
import { SpoolsService } from './spools.service';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';
import { FilamentCatalogController } from './filament-catalog.controller';
import { FilamentCatalogService } from './filament-catalog.service';

@Module({
  controllers: [MaterialsController, SpoolsController, LocationsController, FilamentCatalogController],
  providers: [MaterialsService, SpoolsService, LocationsService, FilamentCatalogService],
  exports: [MaterialsService, SpoolsService, LocationsService, FilamentCatalogService],
})
export class InventoryModule {}
