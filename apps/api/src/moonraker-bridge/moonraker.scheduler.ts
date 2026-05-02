import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MoonrakerService } from './moonraker.service';
import { CrealityWsService } from './creality-ws.service';
import { PrismaService } from '../common/prisma/prisma.service';

/**
 * Interface so the scheduler can broadcast without a hard dep on WebSocketModule.
 * The EventsGateway implements this when running in the main API process.
 * In the standalone bridge process, no broadcaster is provided.
 */
export interface PrinterBroadcaster {
  broadcastPrinterStatus(data: any[]): void;
  broadcastJobProgress(jobId: string, progress: number, status: string): void;
}

export const PRINTER_BROADCASTER = 'PRINTER_BROADCASTER';

@Injectable()
export class MoonrakerScheduler {
  private readonly logger = new Logger(MoonrakerScheduler.name);
  private polling = false;

  constructor(
    private moonraker: MoonrakerService,
    private crealityWs: CrealityWsService,
    private prisma: PrismaService,
    @Optional() @Inject(PRINTER_BROADCASTER) private broadcaster?: PrinterBroadcaster,
  ) {}

  setBroadcaster(b: PrinterBroadcaster) {
    this.broadcaster = b;
  }

  /**
   * For each printer currently printing, find the matching IN_PROGRESS production
   * job and push a live progress event (0–100) to all connected clients.
   */
  private async broadcastActiveJobProgress(
    results: Array<{ printerId: string; snapshot: { progress: number; printStats?: { state?: string } | null; printerState?: string } }>,
  ) {
    const printingResults = results.filter(r =>
      r.snapshot.printStats?.state === 'printing' ||
      r.snapshot.printerState === 'printing',
    );
    if (printingResults.length === 0) return;

    const jobs = await this.prisma.productionJob.findMany({
      where: {
        printerId: { in: printingResults.map(p => p.printerId) },
        status: 'IN_PROGRESS',
      },
      select: { id: true, printerId: true },
    }).catch(() => [] as Array<{ id: string; printerId: string | null }>);

    for (const job of jobs) {
      const pr = printingResults.find(p => p.printerId === job.printerId);
      if (!pr) continue;
      // progress is normalised 0–1 (Creality divided by 100 in the scheduler above)
      const pct = Math.min(100, Math.max(0, Math.round((pr.snapshot.progress ?? 0) * 100)));
      this.broadcaster!.broadcastJobProgress(job.id, pct, 'IN_PROGRESS');
    }
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

        // Broadcast live job progress for any IN_PROGRESS jobs on printing printers
        if (this.broadcaster) {
          await this.broadcastActiveJobProgress(allResults);
        }
      }
    } catch (err: any) {
      this.logger.error(`Poll error: ${err.message}`);
    } finally {
      this.polling = false;
    }
  }
}
