import { Module } from '@nestjs/common';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  controllers: [ExpensesController, ReportsController],
  providers: [ExpensesService, ReportsService],
  exports: [ExpensesService, ReportsService],
})
export class AccountingModule {}
