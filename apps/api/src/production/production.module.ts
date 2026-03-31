import { Module } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { JobMaterialsService } from './job-materials.service';
import { CostingModule } from '../costing/costing.module';

@Module({
  imports: [CostingModule],
  controllers: [JobsController],
  providers: [JobsService, JobMaterialsService],
  exports: [JobsService, JobMaterialsService],
})
export class ProductionModule {}
