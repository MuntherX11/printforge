import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private reportsService: ReportsService) {}

  @Get('pnl')
  getProfitAndLoss(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.reportsService.getProfitAndLoss(startDate, endDate);
  }

  @Get('dashboard')
  getDashboardKPIs() {
    return this.reportsService.getDashboardKPIs();
  }
}
