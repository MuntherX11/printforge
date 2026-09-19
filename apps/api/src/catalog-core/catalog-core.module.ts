import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { CostingModule } from '../costing/costing.module';
import { SettingsModule } from '../settings/settings.module';
import { StockLedgerModule } from '../stock-ledger/stock-ledger.module';
import { BomResolverService } from './bom-resolver.service';
import { OpenLinesImpactService } from './open-lines-impact.service';
import { PricingService } from './pricing.service';
import { ProductionPlannerService } from './production-planner.service';

/**
 * Catalog core domain (spec WP2): pair resolution, plate plans, costs, prices,
 * production plans and open-line impact. No controllers — the products, jobs,
 * orders and quotes packages call these services.
 */
@Module({
  imports: [PrismaModule, CostingModule, SettingsModule, StockLedgerModule],
  providers: [BomResolverService, PricingService, ProductionPlannerService, OpenLinesImpactService],
  exports: [BomResolverService, PricingService, ProductionPlannerService, OpenLinesImpactService, StockLedgerModule],
})
export class CatalogCoreModule {}
