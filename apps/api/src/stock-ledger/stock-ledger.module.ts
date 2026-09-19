import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { ProductStockService } from './product-stock.service';

/**
 * Printed-unit stock per physical colour key and its ledger (spec §3.6).
 * Imports only Prisma so the standalone printer bridge can use it too.
 */
@Module({
  imports: [PrismaModule],
  providers: [ProductStockService],
  exports: [ProductStockService],
})
export class StockLedgerModule {}
