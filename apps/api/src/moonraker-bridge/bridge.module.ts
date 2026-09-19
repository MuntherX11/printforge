import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StockLedgerModule } from '../stock-ledger/stock-ledger.module';
import { MoonrakerService } from './moonraker.service';
import { MoonrakerScheduler } from './moonraker.scheduler';
import { MoonrakerController } from './moonraker.controller';
import { CrealityWsService } from './creality-ws.service';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    StockLedgerModule,
  ],
  controllers: [MoonrakerController],
  providers: [MoonrakerService, CrealityWsService, MoonrakerScheduler],
  exports: [MoonrakerService, CrealityWsService, MoonrakerScheduler],
})
export class BridgeModule {}
