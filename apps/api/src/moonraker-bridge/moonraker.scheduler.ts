import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MoonrakerService } from './moonraker.service';

/**
 * Interface so the scheduler can broadcast without a hard dep on WebSocketModule.
 * The EventsGateway implements this when running in the main API process.
 * In the standalone bridge process, no broadcaster is provided.
 */
export interface PrinterBroadcaster {
  broadcastPrinterStatus(data: any[]): void;
}

export const PRINTER_BROADCASTER = 'PRINTER_BROADCASTER';

@Injectable()
export class MoonrakerScheduler {
  private readonly logger = new Logger(MoonrakerScheduler.name);
  private polling = false;

  constructor(
    private moonraker: MoonrakerService,
    @Optional() @Inject(PRINTER_BROADCASTER) private broadcaster?: PrinterBroadcaster,
  ) {}

  setBroadcaster(b: PrinterBroadcaster) {
    this.broadcaster = b;
  }

  /**
   * Poll all Moonraker printers every 10 seconds.
   */
  @Cron(CronExpression.EVERY_10_SECONDS)
  async pollPrinters() {
    if (this.polling) return; // prevent overlap
    this.polling = true;

    try {
      const results = await this.moonraker.pollAllPrinters();
      if (results.length > 0) {
        this.logger.debug(`Polled ${results.length} printer(s)`);
        this.broadcaster?.broadcastPrinterStatus(results);
      }
    } catch (err: any) {
      this.logger.error(`Poll error: ${err.message}`);
    } finally {
      this.polling = false;
    }
  }
}
