import { Module } from '@nestjs/common';
import { CatalogCoreModule } from '../catalog-core/catalog-core.module';
import { ChunkUploadsModule } from '../chunk-uploads/chunk-uploads.module';
import { CostingModule } from '../costing/costing.module';
import { FileParserModule } from '../file-parser/file-parser.module';
import { PartsModule } from '../parts/parts.module';
import { ColourSlotsController } from './colour-slots.controller';
import { ColourSlotsService } from './colour-slots.service';
import { ProductComponentsService } from './product-components.service';
import { ProductImageBackfillService } from './product-image-backfill.service';
import { ProductImagesController } from './product-images.controller';
import { ProductImagesService } from './product-images.service';
import { ProductImportsController } from './product-imports.controller';
import { PlateLayoutsController } from './plate-layouts.controller';
import { PlateLayoutsService } from './plate-layouts.service';
import { ProductOnboardingService } from './product-onboarding.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { VariantsController } from './variants.controller';
import { VariantsService } from './variants.service';

@Module({
  imports: [CostingModule, FileParserModule, PartsModule, ChunkUploadsModule, CatalogCoreModule],
  controllers: [ProductsController, ProductImagesController, VariantsController, ColourSlotsController, ProductImportsController, PlateLayoutsController],
  providers: [
    ProductsService, ProductComponentsService, VariantsService, ColourSlotsService,
    ProductOnboardingService, ProductImagesService, ProductImageBackfillService, PlateLayoutsService,
  ],
  exports: [ProductsService, ProductImagesService],
})
export class ProductsModule {}
