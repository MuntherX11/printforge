import { Module } from '@nestjs/common';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';
import { QuotesScheduler } from './quotes.scheduler';
import { OrdersModule } from '../orders/orders.module';
import { WebSocketModule } from '../websocket/websocket.module';

@Module({
  imports: [OrdersModule, WebSocketModule],
  controllers: [QuotesController],
  providers: [QuotesService, QuotesScheduler],
  exports: [QuotesService],
})
export class QuotesModule {}
