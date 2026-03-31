import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './common/prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { CustomersModule } from './customers/customers.module';
import { InventoryModule } from './inventory/inventory.module';
import { ProductsModule } from './products/products.module';
import { PrintersModule } from './printers/printers.module';
import { ProductionModule } from './production/production.module';
import { CostingModule } from './costing/costing.module';
import { QuotesModule } from './quotes/quotes.module';
import { OrdersModule } from './orders/orders.module';
import { InvoicesModule } from './invoices/invoices.module';
import { AccountingModule } from './accounting/accounting.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SettingsModule } from './settings/settings.module';
import { AuditModule } from './audit/audit.module';
import { CommunicationsModule } from './communications/communications.module';
import { FileParserModule } from './file-parser/file-parser.module';
import { BridgeModule } from './moonraker-bridge/bridge.module';
import { WebSocketModule } from './websocket/websocket.module';
import { ScheduleModule } from '@nestjs/schedule';
import { LowStockProcessor } from './worker/low-stock.processor';
import { LowStockScheduler } from './worker/low-stock.scheduler';
import { LowStockController } from './worker/low-stock.controller';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    UsersModule,
    CustomersModule,
    InventoryModule,
    ProductsModule,
    PrintersModule,
    ProductionModule,
    CostingModule,
    QuotesModule,
    OrdersModule,
    InvoicesModule,
    AccountingModule,
    AttachmentsModule,
    NotificationsModule,
    SettingsModule,
    AuditModule,
    CommunicationsModule,
    FileParserModule,
    BridgeModule,
    WebSocketModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [HealthController, LowStockController],
  providers: [LowStockProcessor, LowStockScheduler],
})
export class AppModule {}
