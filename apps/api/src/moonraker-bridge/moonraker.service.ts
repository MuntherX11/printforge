import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { isLocalUrl } from '../common/utils/is-local-url';
import { JobCompletionService } from '../stock-ledger/job-completion.service';

/**
 * The job a printer's completion event belongs to (§3.6): this printer, this
 * file, IN_PROGRESS before QUEUED, then the oldest. Shared by both bridges.
 */
export async function findJobForCompletion(
  prisma: Pick<PrismaService, 'productionJob'>,
  printerId: string,
  filename: string,
): Promise<{ id: string } | null> {
  for (const status of ['IN_PROGRESS', 'QUEUED'] as const) {
    const job = await prisma.productionJob.findFirst({
      where: { printerId, status, gcodeFilename: filename },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    }).catch(() => null);
    if (job) return job;
  }
  return null;
}

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

  // INF-03: per-printer failure tracking for exponential backoff
  private readonly failureCounts = new Map<string, number>();
  private readonly skipUntil = new Map<string, number>();

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private completion: JobCompletionService,
  ) {}

  /**
   * Fetch printer status from a Moonraker instance.
   */
  async fetchStatus(moonrakerUrl: string): Promise<MoonrakerSnapshot | null> {
    if (!isLocalUrl(moonrakerUrl)) {
      this.logger.warn(`Blocked SSRF attempt to non-local URL: ${moonrakerUrl}`);
      return null;
    }
    const base = moonrakerUrl.replace(/\/+$/, '');

    try {
      // Fetch printer.info and objects query in parallel
      // printer.info is a separate endpoint, NOT a valid objects/query object
      const [infoRes, objectsRes] = await Promise.all([
        fetch(`${base}/printer/info`, { signal: AbortSignal.timeout(5000) }),
        fetch(`${base}/printer/objects/query?print_stats&display_status&heater_bed&extruder`, {
          signal: AbortSignal.timeout(5000),
        }),
      ]);

      if (!objectsRes.ok) return null;

      const objectsData: any = await objectsRes.json();
      const status = objectsData?.result?.status || {};

      // Extract printer state from /printer/info (separate endpoint)
      let klippyState = 'unknown';
      if (infoRes.ok) {
        const infoData: any = await infoRes.json();
        klippyState = infoData?.result?.state || 'unknown';
      }

      return {
        hostname: base,
        printerState: klippyState !== 'unknown' ? klippyState : (status.print_stats?.state || 'unknown'),
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
        // INF-03: skip printers in backoff window
        const skipTs = this.skipUntil.get(printer.id) ?? 0;
        if (skipTs > Date.now()) return;

        const snapshot = await this.fetchStatus(printer.moonrakerUrl!);

        if (!snapshot) {
          // INF-03: increment failure count and compute backoff
          const failures = (this.failureCounts.get(printer.id) ?? 0) + 1;
          this.failureCounts.set(printer.id, failures);
          const backoffMs = Math.min(300_000, 10_000 * Math.pow(2, Math.floor(failures / 3)));
          this.skipUntil.set(printer.id, Date.now() + backoffMs);

          // Mark offline if we can't reach it
          if (printer.status !== 'OFFLINE') {
            await this.prisma.printer.update({
              where: { id: printer.id },
              data: { status: 'OFFLINE', lastSeen: new Date() },
            });
          }
          return;
        }

        // INF-03: reset failure tracking on success
        this.failureCounts.set(printer.id, 0);
        this.skipUntil.delete(printer.id);

        const newStatus = this.mapState(snapshot.printStats?.state || snapshot.printerState);
        const prevStatus = printer.status;

        // API-02: only write to DB when status changed or lastSeen is stale (>30s)
        const lastSeenStale = !printer.lastSeen || (Date.now() - new Date(printer.lastSeen).getTime()) > 30_000;
        if (newStatus !== prevStatus || lastSeenStale) {
          await this.prisma.printer.update({
            where: { id: printer.id },
            data: {
              status: newStatus as any,
              lastSeen: new Date(),
            },
          });
        }

        // Detect job start: printer transitions into PRINTING with a matching QUEUED job
        if (prevStatus !== 'PRINTING' && newStatus === 'PRINTING') {
          await this.handleJobStarted(printer.id, snapshot);
        }

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
   * When a Moonraker printer starts printing, flip ONE matching job to
   * IN_PROGRESS: the oldest QUEUED job on this printer with that file (§3.6).
   * Multi-plate jobs have gcodeFilename null, so they never match.
   */
  async handleJobStarted(printerId: string, snapshot: MoonrakerSnapshot) {
    const filename = snapshot.printStats?.filename;
    if (!filename) return;

    const job = await this.prisma.productionJob.findFirst({
      where: { printerId, status: 'QUEUED', gcodeFilename: filename },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    }).catch(() => null);
    if (!job) return;

    const updated = await this.prisma.productionJob.updateMany({
      where: { id: job.id, status: 'QUEUED' },
      data: { status: 'IN_PROGRESS', startedAt: new Date() },
    }).catch(() => ({ count: 0 }));

    if (updated.count > 0) {
      this.logger.log(`Job ${job.id} auto-started for printer ${printerId}: gcode "${filename}"`);
    }
  }

  /**
   * When a Moonraker print completes, complete the matching job through the
   * shared JobCompletionService (spool deduction, parts, printer hours, stock
   * credit: one guarded transaction). Only the machine cost and the
   * notification stay here, after commit. The lookup prefers IN_PROGRESS over
   * QUEUED, then the oldest; multi-plate jobs (gcodeFilename null) never match.
   */
  async handleJobCompleted(printerId: string, snapshot: MoonrakerSnapshot) {
    const stats = snapshot.printStats;
    if (!stats?.filename) return;

    const job = await findJobForCompletion(this.prisma, printerId, stats.filename);
    if (!job) {
      this.logger.log(`Completed print "${stats.filename}" on printer ${printerId} — no matching job found`);
      return;
    }

    const filamentMm = stats.filament_used || 0;
    const result = await this.completion.complete(job.id, {
      source: 'MOONRAKER',
      printDurationSec: stats.print_duration,
      filamentUsedMm: filamentMm,
    }).catch((err) => {
      this.logger.warn(`Completion failed for job ${job.id}: ${err.message}`);
      return null;
    });
    if (!result) {
      this.logger.log(`Job ${job.id} already completed — skipping duplicate completion`);
      return;
    }

    // BIZ-13: machine cost = print hours × printer hourly rate (after commit).
    const printHours = (stats.print_duration || 0) / 3600;
    const machineCost = printHours * (result.job.printer?.hourlyRate ?? 0);
    await this.prisma.productionJob.update({ where: { id: job.id }, data: { machineCost } })
      .catch((err) => this.logger.warn(`BIZ-13 post-completion update failed for job ${job.id}: ${err.message}`));

    // WARN-22: use material density if available, fall back to PLA
    const density = result.job.materials?.[0]?.material?.density ?? 1.24;
    // Calculate filament grams from mm (1.75mm filament diameter)
    const filamentGrams = filamentMm > 0
      ? (Math.PI * Math.pow(0.0875, 2) * filamentMm * density) / 1000
      : 0;

    await this.notifications.create({
      type: 'JOB_COMPLETED',
      title: 'Print Job Completed',
      message: `"${result.job.name}" finished on ${result.job.printer?.name || 'printer'}. Duration: ${Math.round((stats.print_duration || 0) / 60)}min, Filament: ${filamentGrams.toFixed(1)}g`,
      entityType: 'job',
      entityId: job.id,
    }).catch(() => {});
  }

  /**
   * Send a G-code command to a Moonraker instance.
   */
  async sendGcode(moonrakerUrl: string, gcode: string): Promise<boolean> {
    if (!isLocalUrl(moonrakerUrl)) return false;
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
    if (!isLocalUrl(moonrakerUrl)) return false;
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
    if (!isLocalUrl(moonrakerUrl)) return false;
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
