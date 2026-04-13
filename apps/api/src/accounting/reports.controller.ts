import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('reports')
@UseGuards(JwtAuthGuard, StaffGuard, RolesGuard)
export class ReportsController {
  constructor(private reportsService: ReportsService) {}

  @Get('pnl')
  @Roles('ADMIN', 'VIEWER')
  getProfitAndLoss(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.reportsService.getProfitAndLoss(startDate, endDate);
  }

  @Get('monthly-trend')
  @Roles('ADMIN', 'VIEWER')
  getMonthlyTrend(@Query('months') months?: string) {
    return this.reportsService.getMonthlyTrend(months ? parseInt(months) : 6);
  }

  @Get('product-margins')
  @Roles('ADMIN', 'VIEWER')
  getProductMargins() {
    return this.reportsService.getProductMargins();
  }

  @Get('dashboard')
  @Roles('ADMIN', 'VIEWER')
  getDashboardKPIs() {
    return this.reportsService.getDashboardKPIs();
  }
}
