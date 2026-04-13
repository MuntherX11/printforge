import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { QuotesService } from './quotes.service';

@Injectable()
export class QuotesScheduler {
  private readonly logger = new Logger(QuotesScheduler.name);

  constructor(private quotesService: QuotesService) {}

  /**
   * Expire overdue quotes every day at midnight.
   * Moves any DRAFT or SENT quote past its validUntil date to EXPIRED.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async expireQuotes() {
    const count = await this.quotesService.expireOldQuotes();
    if (count > 0) {
      this.logger.log(`Expired ${count} overdue quote${count !== 1 ? 's' : ''}`);
    }
  }
}
