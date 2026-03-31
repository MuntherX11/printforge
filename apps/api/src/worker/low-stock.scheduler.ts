import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LowStockProcessor } from './low-stock.processor';

@Injectable()
export class LowStockScheduler {
  private readonly logger = new Logger(LowStockScheduler.name);

  constructor(private processor: LowStockProcessor) {}

  /**
   * Run low-stock check every hour.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async check() {
    this.logger.log('Running scheduled low-stock check...');
    const result = await this.processor.checkLowStock();
    this.logger.log(`Low-stock check complete: ${result.checked} materials, ${result.alerts} new alerts`);
  }
}
