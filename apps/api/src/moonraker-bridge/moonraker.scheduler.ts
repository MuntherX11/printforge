import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MoonrakerService } from './moonraker.service';
import { CrealityWsService } from './creality-ws.service';

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
    private crealityWs: CrealityWsService,
    @Optional() @Inject(PRINTER_BROADCASTER) private broadcaster?: PrinterBroadcaster,
  ) {}

  setBroadcaster(b: PrinterBroadcaster) {
    this.broadcaster = b;
  }

  /**
   * Poll all Moonraker printers every 10 seconds, and broadcast
   * the latest Creality WS snapshots (pushed by persistent connections).
   */
  @Cron(CronExpression.EVERY_10_SECONDS)
  async pollPrinters() {
    if (this.polling) return; // prevent overlap
    this.polling = true;

    try {
      // Moonraker: active HTTP poll
      const moonrakerResults = await this.moonraker.pollAllPrinters();

      // Creality WS: already pushed — just read cached snapshots
      const crealitySnapshots = this.crealityWs.getSnapshots().map(s => ({
        printerId: s.printerId,
        snapshot: {
          hostname: s.printerName,
          printerState: s.state,
          printStats: s.fileName
            ? { filename: s.fileName, state: s.state, print_duration: s.printJobTime,
                total_duration: s.printJobTime, filament_used: 0, message: '' }
            : null,
          progress: s.progress / 100,
          heaterBed: { temperature: s.bedTemp, target: s.targetBedTemp },
          extruder: { temperature: s.nozzleTemp, target: s.targetNozzleTemp },
        },
      }));

      const allResults = [...moonrakerResults, ...crealitySnapshots];
      if (allResults.length > 0) {
        this.logger.debug(
          `Broadcasting ${moonrakerResults.length} Moonraker + ${crealitySnapshots.length} Creality printer(s)`,
        );
        this.broadcaster?.broadcastPrinterStatus(allResults);
      }
    } catch (err: any) {
      this.logger.error(`Poll error: ${err.message}`);
    } finally {
      this.polling = false;
    }
  }
}
