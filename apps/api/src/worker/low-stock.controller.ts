import { Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { LowStockProcessor } from './low-stock.processor';

@Controller('low-stock')
@UseGuards(JwtAuthGuard)
export class LowStockController {
  constructor(private processor: LowStockProcessor) {}

  /**
   * Manually trigger a low-stock check.
   */
  @Post('check')
  check() {
    return this.processor.checkLowStock();
  }
}
