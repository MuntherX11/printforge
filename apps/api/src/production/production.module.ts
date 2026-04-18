import { Module } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { JobMaterialsService } from './job-materials.service';
import { JobPlanningService } from './job-planning.service';
import { JobSchedulingService } from './job-scheduling.service';
import { CostingModule } from '../costing/costing.module';
import { WebSocketModule } from '../websocket/websocket.module';
import { CommunicationsModule } from '../communications/communications.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [CostingModule, WebSocketModule, CommunicationsModule, SettingsModule],
  controllers: [JobsController],
  providers: [JobsService, JobMaterialsService, JobPlanningService, JobSchedulingService],
  exports: [JobsService, JobMaterialsService, JobPlanningService, JobSchedulingService],
})
export class ProductionModule {}
