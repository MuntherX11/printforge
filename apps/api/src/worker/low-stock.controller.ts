import { Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { LowStockProcessor } from './low-stock.processor';

@Controller('low-stock')
@UseGuards(JwtAuthGuard, StaffGuard)
export class LowStockController {
  constructor(private processor: LowStockProcessor) {}

  /**
   * Manually trigger a low-stock check. It writes notifications, so ADMIN or
   * OPERATOR, the roles that manage filament and parts stock; the scheduled
   * check runs on its own.
   */
  @Post('check')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  check() {
    return this.processor.checkLowStock();
  }
}
