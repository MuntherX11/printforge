import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MoonrakerService } from './moonraker.service';
import { MoonrakerScheduler } from './moonraker.scheduler';
import { MoonrakerController } from './moonraker.controller';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
  ],
  controllers: [MoonrakerController],
  providers: [MoonrakerService, MoonrakerScheduler],
  exports: [MoonrakerService, MoonrakerScheduler],
})
export class BridgeModule {}
