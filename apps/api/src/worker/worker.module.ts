import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../common/prisma/prisma.module';
import { CostingModule } from '../costing/costing.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { LowStockProcessor } from './low-stock.processor';
import { LowStockScheduler } from './low-stock.scheduler';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    CostingModule,
    NotificationsModule,
  ],
  providers: [LowStockProcessor, LowStockScheduler],
  exports: [LowStockProcessor],
})
export class WorkerModule {}
