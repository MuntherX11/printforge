import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

interface MoonrakerPrinterStatus {
  state: string;                       // ready, printing, paused, error, shutdown, startup
  state_message: string;
}

interface MoonrakerPrintStats {
  filename: string;
  total_duration: number;              // seconds
  print_duration: number;              // seconds
  filament_used: number;               // mm
  state: string;                       // standby, printing, paused, complete, cancelled, error
  message: string;
}

interface MoonrakerDisplayStatus {
  progress: number;                    // 0.0 - 1.0
}

export interface MoonrakerSnapshot {
  hostname: string;
  printerState: string;
  printStats: MoonrakerPrintStats | null;
  progress: number;
  heaterBed: { temperature: number; target: number } | null;
  extruder: { temperature: number; target: number } | null;
}

@Injectable()
export class MoonrakerService {
  private readonly logger = new Logger(MoonrakerService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  /**
   * Fetch printer status from a Moonraker instance.
   */
  async fetchStatus(moonrakerUrl: string): Promise<MoonrakerSnapshot | null> {
    const base = moonrakerUrl.replace(/\/+$/, '');
    const query = 'printer.info&print_stats&display_status&heater_bed&extruder';
    const url = `${base}/printer/objects/query?${query}`;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;

      const data = await res.json();
      const status = data?.result?.status || {};

      return {
        hostname: base,
        printerState: status['printer.info']?.state || status.print_stats?.state || 'unknown',
        printStats: status.print_stats || null,
        progress: status.display_status?.progress || 0,
        heaterBed: status.heater_bed || null,
        extruder: status.extruder || null,
      };
    } catch (err: any) {
      this.logger.warn(`Failed to reach ${base}: ${err.message}`);
      return null;
    }
  }

  /**
   * Map Moonraker state to our PrinterStatus enum.
   */
  private mapState(moonState: string): string {
    switch (moonState) {
      case 'ready':
      case 'standby':
      case 'complete':
        return 'IDLE';
      case 'printing':
        return 'PRINTING';
      case 'paused':
        return 'PAUSED';
      case 'error':
      case 'shutdown':
        return 'ERROR';
      default:
        return 'OFFLINE';
    }
  }

  /**
   * Poll all Moonraker-connected printers, update DB status.
   * Returns snapshots for WebSocket broadcasting.
   */
  async pollAllPrinters(): Promise<Array<{ printerId: string; snapshot: MoonrakerSnapshot }>> {
    const printers = await this.prisma.printer.findMany({
      where: { connectionType: 'MOONRAKER', isActive: true, moonrakerUrl: { not: null } },
    });

    const results: Array<{ printerId: string; snapshot: MoonrakerSnapshot }> = [];

    await Promise.all(
      printers.map(async (printer) => {
        const snapshot = await this.fetchStatus(printer.moonrakerUrl!);

        if (!snapshot) {
          // Mark offline if we can't reach it
          if (printer.status !== 'OFFLINE') {
            await this.prisma.printer.update({
              where: { id: printer.id },
              data: { status: 'OFFLINE', lastSeen: new Date() },
            });
          }
          return;
        }

        const newStatus = this.mapState(snapshot.printStats?.state || snapshot.printerState);
        const prevStatus = printer.status;

        // Update printer status
        await this.prisma.printer.update({
          where: { id: printer.id },
          data: {
            status: newStatus as any,
            lastSeen: new Date(),
          },
        });

        // Detect job completion: was PRINTING, now IDLE/complete
        if (prevStatus === 'PRINTING' && (newStatus === 'IDLE') && snapshot.printStats?.state === 'complete') {
          await this.handleJobCompleted(printer.id, snapshot);
        }

        // Detect error
        if (newStatus === 'ERROR' && prevStatus !== 'ERROR') {
          await this.notifications.create({
            type: 'JOB_FAILED',
            title: `Printer Error: ${printer.name}`,
            message: snapshot.printStats?.message || 'Printer entered error state',
            entityType: 'printer',
            entityId: printer.id,
          });
        }

        results.push({ printerId: printer.id, snapshot });
      }),
    );

    return results;
  }

  /**
   * When a Moonraker job completes, sync the data back:
   * - Find matching production job by gcodeFilename
   * - Update duration and filament used
   * - Auto-deduct spool weight
   */
  private async handleJobCompleted(printerId: string, snapshot: MoonrakerSnapshot) {
    const stats = snapshot.printStats;
    if (!stats?.filename) return;

    // Find active job for this printer matching the filename
    const job = await this.prisma.productionJob.findFirst({
      where: {
        printerId,
        status: { in: ['IN_PROGRESS', 'QUEUED'] },
        gcodeFilename: stats.filename,
      },
      include: { materials: { include: { spool: true } }, printer: true },
    });

    if (!job) {
      this.logger.log(`Completed print "${stats.filename}" on printer ${printerId} — no matching job found`);
      return;
    }

    // Calculate filament grams from mm (PLA 1.75mm default)
    const filamentMm = stats.filament_used || 0;
    const filamentGrams = filamentMm > 0
      ? (Math.PI * Math.pow(0.0875, 2) * filamentMm * 1.24) / 1000 // density 1.24 g/cm³
      : 0;

    // Update job with actual print data
    await this.prisma.productionJob.update({
      where: { id: job.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        printDuration: stats.print_duration,
        filamentUsedMm: filamentMm,
      },
    });

    // Auto-deduct spool weight for each job material that has a spool assigned
    for (const jm of job.materials) {
      if (!jm.spoolId || !jm.spool) continue;

      const deduction = jm.gramsUsed;
      const newWeight = Math.max(0, jm.spool.currentWeight - deduction);

      await this.prisma.spool.update({
        where: { id: jm.spoolId },
        data: { currentWeight: newWeight },
      });

      this.logger.log(`Deducted ${deduction}g from spool ${jm.spoolId} (now ${newWeight}g)`);
    }

    // Create completion notification
    await this.notifications.create({
      type: 'JOB_COMPLETED',
      title: 'Print Job Completed',
      message: `"${job.name}" finished on ${job.printer?.name || 'printer'}. Duration: ${Math.round((stats.print_duration || 0) / 60)}min, Filament: ${filamentGrams.toFixed(1)}g`,
      entityType: 'job',
      entityId: job.id,
    });
  }

  /**
   * Send a G-code command to a Moonraker instance.
   */
  async sendGcode(moonrakerUrl: string, gcode: string): Promise<boolean> {
    const base = moonrakerUrl.replace(/\/+$/, '');
    try {
      const res = await fetch(`${base}/printer/gcode/script?script=${encodeURIComponent(gcode)}`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Start a print job on a Moonraker printer.
   */
  async startPrint(moonrakerUrl: string, filename: string): Promise<boolean> {
    const base = moonrakerUrl.replace(/\/+$/, '');
    try {
      const res = await fetch(`${base}/printer/print/start?filename=${encodeURIComponent(filename)}`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Pause/resume/cancel current print.
   */
  async controlPrint(moonrakerUrl: string, action: 'pause' | 'resume' | 'cancel'): Promise<boolean> {
    const base = moonrakerUrl.replace(/\/+$/, '');
    try {
      const res = await fetch(`${base}/printer/print/${action}`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
