import { Module } from '@nestjs/common';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';
import { QuotesScheduler } from './quotes.scheduler';
import { OrdersModule } from '../orders/orders.module';
import { WebSocketModule } from '../websocket/websocket.module';
import { CommunicationsModule } from '../communications/communications.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [OrdersModule, WebSocketModule, CommunicationsModule, SettingsModule],
  controllers: [QuotesController],
  providers: [QuotesService, QuotesScheduler],
  exports: [QuotesService],
})
export class QuotesModule {}
