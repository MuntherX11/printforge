import { Module } from '@nestjs/common';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';
import { QuotesScheduler } from './quotes.scheduler';
import { WebSocketModule } from '../websocket/websocket.module';
import { CommunicationsModule } from '../communications/communications.module';
import { SettingsModule } from '../settings/settings.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { CatalogCoreModule } from '../catalog-core/catalog-core.module';
import { ProductionModule } from '../production/production.module';

/**
 * CatalogCoreModule prices and resolves lines; ProductionModule provides
 * JobPlanningService for conversion. ProductionModule imports neither orders nor
 * quotes, so there is no cycle.
 */
@Module({
  imports: [WebSocketModule, CommunicationsModule, SettingsModule, InvoicesModule, CatalogCoreModule, ProductionModule],
  controllers: [QuotesController],
  providers: [QuotesService, QuotesScheduler],
  exports: [QuotesService],
})
export class QuotesModule {}
