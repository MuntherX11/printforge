import { Module } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { JobMaterialsService } from './job-materials.service';
import { JobPlanningService } from './job-planning.service';
import { JobSchedulingService } from './job-scheduling.service';
import { CatalogCoreModule } from '../catalog-core/catalog-core.module';
import { CostingModule } from '../costing/costing.module';
import { WebSocketModule } from '../websocket/websocket.module';
import { CommunicationsModule } from '../communications/communications.module';
import { SettingsModule } from '../settings/settings.module';

/**
 * Production jobs (WP6). CatalogCoreModule brings the resolver, planner and the
 * stock ledger (ProductStockService, JobCompletionService). Imports neither
 * orders nor quotes, so QuotesModule can import this one without a cycle.
 */
@Module({
  imports: [CatalogCoreModule, CostingModule, WebSocketModule, CommunicationsModule, SettingsModule],
  controllers: [JobsController],
  providers: [JobsService, JobMaterialsService, JobPlanningService, JobSchedulingService],
  exports: [JobsService, JobMaterialsService, JobPlanningService, JobSchedulingService],
})
export class ProductionModule {}
