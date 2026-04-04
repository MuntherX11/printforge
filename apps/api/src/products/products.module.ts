import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { CostingModule } from '../costing/costing.module';
import { FileParserModule } from '../file-parser/file-parser.module';

@Module({
  imports: [CostingModule, FileParserModule],
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
