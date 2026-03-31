import { Module } from '@nestjs/common';
import { CostingService } from './costing.service';
import { CostingController } from './costing.controller';

@Module({
  controllers: [CostingController],
  providers: [CostingService],
  exports: [CostingService],
})
export class CostingModule {}
