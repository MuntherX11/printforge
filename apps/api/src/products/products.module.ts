import { Module } from '@nestjs/common';
import { ChunkUploadsModule } from '../chunk-uploads/chunk-uploads.module';
import { ProductsService } from './products.service';
import { ProductCostingService } from './product-costing.service';
import { ProductOnboardingService } from './product-onboarding.service';
import { ProductsController } from './products.controller';
import { CostingModule } from '../costing/costing.module';
import { FileParserModule } from '../file-parser/file-parser.module';
import { PartsModule } from '../parts/parts.module';

@Module({
  imports: [CostingModule, FileParserModule, PartsModule, ChunkUploadsModule],
  controllers: [ProductsController],
  providers: [ProductsService, ProductCostingService, ProductOnboardingService],
  exports: [ProductsService, ProductCostingService],
})
export class ProductsModule {}
