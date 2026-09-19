import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { JobCompletionService } from './job-completion.service';
import { ProductStockService } from './product-stock.service';

/**
 * Printed-unit stock per physical colour key and its ledger (spec §3.6), and the
 * one job-completion path (WP6). Imports only Prisma so the standalone printer
 * bridge can use it too.
 */
@Module({
  imports: [PrismaModule],
  providers: [ProductStockService, JobCompletionService],
  exports: [ProductStockService, JobCompletionService],
})
export class StockLedgerModule {}
