import { Module } from '@nestjs/common';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';

@Module({
  controllers: [ExpensesController, ReportsController, AccountsController],
  providers: [ExpensesService, ReportsService, AccountsService],
  exports: [ExpensesService, ReportsService, AccountsService],
})
export class AccountingModule {}
