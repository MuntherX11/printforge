import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PricingPreviewController } from './pricing-preview.controller';
import { CommunicationsModule } from '../communications/communications.module';
import { SettingsModule } from '../settings/settings.module';
import { CatalogCoreModule } from '../catalog-core/catalog-core.module';

/** CatalogCoreModule brings pricing, the resolver, the planner and the stock ledger. */
@Module({
  imports: [CommunicationsModule, SettingsModule, CatalogCoreModule],
  controllers: [OrdersController, PricingPreviewController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
