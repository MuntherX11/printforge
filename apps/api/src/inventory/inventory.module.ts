import { Module } from '@nestjs/common';
import { MaterialsController } from './materials.controller';
import { MaterialsService } from './materials.service';
import { SpoolsController } from './spools.controller';
import { SpoolsService } from './spools.service';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';

@Module({
  controllers: [MaterialsController, SpoolsController, LocationsController],
  providers: [MaterialsService, SpoolsService, LocationsService],
  exports: [MaterialsService, SpoolsService, LocationsService],
})
export class InventoryModule {}
