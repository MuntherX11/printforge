import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import WebSocket from 'ws';

// Heartbeat sent every 10s to keep the connection alive and receive fresh state
const HEARTBEAT_MSG = JSON.stringify({ method: 'get', params: { ReqPrinterPara: 1 } });
const HEARTBEAT_INTERVAL_MS = 10_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 120_000;
const RECONNECT_MULTIPLIER = 1.8;

export interface CrealitySnapshot {
  printerId: string;
  printerName: string;
  state: string;          // idle | printing | paused | stopped | completed | error
  progress: number;       // 0–100
  fileName: string | null;
  printLeftTime: number;  // seconds remaining
  printJobTime: number;   // seconds elapsed
  nozzleTemp: number;
  targetNozzleTemp: number;
  bedTemp: number;
  targetBedTemp: number;
  rawState: string;
}

interface Connection {
  ws: WebSocket | null;
  snapshot: CrealitySnapshot;
  heartbeatTimer: NodeJS.Timeout | null;
  reconnectTimer: NodeJS.Timeout | null;
  reconnectDelay: number;
  destroyed: boolean;
}

@Injectable()
export class CrealityWsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CrealityWsService.name);
  private connections = new Map<string, Connection>();

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  async onModuleInit() {
    const printers = await this.prisma.printer.findMany({
      where: { connectionType: 'CREALITY_WS', isActive: true, moonrakerUrl: { not: null } },
    });
    for (const printer of printers) {
      this.connect(printer.id, printer.name, printer.moonrakerUrl!);
    }
    this.logger.log(`CrealityWsService initialised — ${printers.length} printer(s) queued`);
  }

  onModuleDestroy() {
    for (const [, conn] of this.connections) {
      conn.destroyed = true;
      conn.heartbeatTimer && clearInterval(conn.heartbeatTimer);
      conn.reconnectTimer && clearTimeout(conn.reconnectTimer);
      conn.ws?.terminate();
    }
    this.connections.clear();
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /** Return all current snapshots for broadcasting. */
  getSnapshots(): CrealitySnapshot[] {
    return [...this.connections.values()].map(c => c.snapshot);
  }

  /** Send a pause/resume/cancel command to a Creality printer. */
  async control(printerId: string, action: 'pause' | 'resume' | 'cancel'): Promise<boolean> {
    const conn = this.connections.get(printerId);
    if (!conn?.ws || conn.ws.readyState !== WebSocket.OPEN) return false;

    // Creality WS command format from reverse-engineering
    const paramMap: Record<string, object> = {
      pause:  { pause: 1 },
      resume: { pause: 0 },
      cancel: { stop: 1 },
    };

    conn.ws.send(JSON.stringify({ method: 'set', params: paramMap[action] }));
    return true;
  }

  /** Re-connect a specific printer (e.g. after its IP is updated). */
  async reconnectPrinter(printerId: string) {
    const existing = this.connections.get(printerId);
    if (existing) {
      existing.destroyed = true;
      existing.heartbeatTimer && clearInterval(existing.heartbeatTimer);
      existing.reconnectTimer && clearTimeout(existing.reconnectTimer);
      existing.ws?.terminate();
      this.connections.delete(printerId);
    }

    const printer = await this.prisma.printer.findUnique({ where: { id: printerId } });
    if (printer?.connectionType === 'CREALITY_WS' && printer.isActive && printer.moonrakerUrl) {
      this.connect(printerId, printer.name, printer.moonrakerUrl);
    }
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private connect(printerId: string, printerName: string, ip: string) {
    const url = ip.startsWith('ws://') || ip.startsWith('wss://')
      ? ip
      : `ws://${ip}:9999`;

    const conn: Connection = {
      ws: null,
      snapshot: this.emptySnapshot(printerId, printerName),
      heartbeatTimer: null,
      reconnectTimer: null,
      reconnectDelay: RECONNECT_BASE_MS,
      destroyed: false,
    };
    this.connections.set(printerId, conn);
    this.openWs(printerId, printerName, url, conn);
  }

  private openWs(printerId: string, printerName: string, url: string, conn: Connection) {
    if (conn.destroyed) return;

    this.logger.log(`Connecting to Creality WS: ${url} (${printerName})`);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { handshakeTimeout: 5000 });
    } catch (err: any) {
      this.logger.warn(`Failed to create WS for ${printerName}: ${err.message}`);
      this.scheduleReconnect(printerId, printerName, url, conn);
      return;
    }

    conn.ws = ws;

    ws.on('open', () => {
      this.logger.log(`Connected to ${printerName} (${url})`);
      conn.reconnectDelay = RECONNECT_BASE_MS;

      // Start heartbeat
      conn.heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(HEARTBEAT_MSG);
        }
      }, HEARTBEAT_INTERVAL_MS);

      // Send initial heartbeat immediately
      ws.send(HEARTBEAT_MSG);
    });

    ws.on('message', (data) => {
      try {
        const json = JSON.parse(data.toString());
        this.handleMessage(printerId, printerName, conn, json);
      } catch {
        // Ignore malformed frames
      }
    });

    ws.on('close', (code) => {
      this.logger.warn(`${printerName} WS closed (code ${code})`);
      conn.heartbeatTimer && clearInterval(conn.heartbeatTimer);
      conn.heartbeatTimer = null;

      // Mark offline in DB
      this.prisma.printer.update({
        where: { id: printerId },
        data: { status: 'OFFLINE' },
      }).catch(() => {});

      this.scheduleReconnect(printerId, printerName, url, conn);
    });

    ws.on('error', (err) => {
      this.logger.warn(`${printerName} WS error: ${err.message}`);
      // 'close' will fire after error — reconnect handled there
    });
  }

  private scheduleReconnect(
    printerId: string,
    printerName: string,
    url: string,
    conn: Connection,
  ) {
    if (conn.destroyed) return;

    const delay = conn.reconnectDelay;
    conn.reconnectDelay = Math.min(delay * RECONNECT_MULTIPLIER, RECONNECT_MAX_MS);

    this.logger.log(`Reconnecting ${printerName} in ${Math.round(delay / 1000)}s…`);
    conn.reconnectTimer = setTimeout(() => {
      if (!conn.destroyed) this.openWs(printerId, printerName, url, conn);
    }, delay);
  }

  private async handleMessage(
    printerId: string,
    printerName: string,
    conn: Connection,
    json: any,
  ) {
    // Creality pushes either { result: { ... } } or the data directly
    const data = json?.result ?? json?.data ?? json;
    if (!data || typeof data !== 'object') return;

    const rawState: string = (data.deviceState ?? data.state ?? '').toLowerCase();
    const prevStatus = conn.snapshot.rawState;

    conn.snapshot = {
      printerId,
      printerName,
      state: this.mapState(rawState),
      progress: Number(data.printProgress ?? 0),
      fileName: data.printFileName ?? null,
      printLeftTime: Number(data.printLeftTime ?? 0),
      printJobTime: Number(data.printJobTime ?? 0),
      nozzleTemp: Number(data.nozzleTemp ?? 0),
      targetNozzleTemp: Number(data.targetNozzleTemp ?? 0),
      bedTemp: Number(data.bedTemp0 ?? data.bedTemp ?? 0),
      targetBedTemp: Number(data.targetBedTemp0 ?? data.targetBedTemp ?? 0),
      rawState,
    };

    const newDbStatus = this.mapDbStatus(rawState);

    // Update DB status (avoid hammering if unchanged)
    const printer = await this.prisma.printer.findUnique({
      where: { id: printerId },
      select: { status: true, lastSeen: true },
    }).catch(() => null);

    if (printer && printer.status !== newDbStatus) {
      await this.prisma.printer.update({
        where: { id: printerId },
        data: { status: newDbStatus as any, lastSeen: new Date() },
      }).catch(() => {});

      // Detect job completion
      if (rawState === 'completed' && prevStatus !== 'completed') {
        await this.handleJobCompleted(printerId, conn.snapshot);
      }

      // Detect new error
      if (newDbStatus === 'ERROR' && printer.status !== 'ERROR') {
        await this.notifications.create({
          type: 'JOB_FAILED',
          title: `Printer Error: ${printerName}`,
          message: data.err?.key ?? 'Printer entered error state',
          entityType: 'printer',
          entityId: printerId,
        }).catch(() => {});
      }
    } else if (printer) {
      // WARN-03: throttle lastSeen writes — only update if >30s stale
      const lastSeenStale = !printer.lastSeen || (Date.now() - new Date(printer.lastSeen).getTime()) > 30_000;
      if (lastSeenStale) {
        await this.prisma.printer.update({
          where: { id: printerId },
          data: { lastSeen: new Date() },
        }).catch(() => {});
      }
    }
  }

  private async handleJobCompleted(printerId: string, snapshot: CrealitySnapshot) {
    if (!snapshot.fileName) return;

    const job = await this.prisma.productionJob.findFirst({
      where: {
        printerId,
        status: { in: ['IN_PROGRESS', 'QUEUED'] },
        gcodeFilename: snapshot.fileName,
      },
      include: { materials: { include: { spool: true } }, printer: true },
    }).catch(() => null);

    if (!job) return;

    // BUG-02: idempotency guard — only update when job is still active
    const result = await this.prisma.productionJob.updateMany({
      where: { id: job.id, status: { in: ['IN_PROGRESS', 'QUEUED'] } },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        printDuration: snapshot.printJobTime,
      },
    }).catch(() => ({ count: 0 }));

    if (result.count === 0) {
      this.logger.log(`Job ${job.id} already completed — skipping duplicate completion`);
      return;
    }

    // BUG-04: fetch current spool weight before deducting to prevent negative values
    for (const jm of job.materials) {
      if (jm.spoolId && jm.gramsUsed > 0) {
        const currentSpool = await this.prisma.spool.findUnique({
          where: { id: jm.spoolId },
          select: { currentWeight: true },
        }).catch(() => null);
        const newWeight = Math.max(0, (currentSpool?.currentWeight ?? 0) - jm.gramsUsed);
        await this.prisma.spool.update({
          where: { id: jm.spoolId },
          data: { currentWeight: newWeight },
        }).catch(() => {});
      }
    }

    await this.notifications.create({
      type: 'JOB_COMPLETED',
      title: 'Print Job Completed',
      message: `"${job.name}" finished on ${snapshot.printerName}. Duration: ${Math.round(snapshot.printJobTime / 60)}min`,
      entityType: 'job',
      entityId: job.id,
    }).catch(() => {});
  }

  // ─── State mapping ────────────────────────────────────────────────────────

  private mapState(raw: string): string {
    switch (raw) {
      case 'printing': return 'printing';
      case 'paused':   return 'paused';
      case 'completed':
      case 'idle':
      case 'standby':  return 'idle';
      case 'error':    return 'error';
      case 'stopped':  return 'stopped';
      default:         return raw || 'unknown';
    }
  }

  private mapDbStatus(raw: string): string {
    switch (raw) {
      case 'printing':  return 'PRINTING';
      case 'paused':    return 'PAUSED';
      case 'idle':
      case 'standby':
      case 'completed': return 'IDLE';
      case 'error':     return 'ERROR';
      default:          return 'OFFLINE';
    }
  }

  private emptySnapshot(printerId: string, printerName: string): CrealitySnapshot {
    return {
      printerId,
      printerName,
      state: 'unknown',
      progress: 0,
      fileName: null,
      printLeftTime: 0,
      printJobTime: 0,
      nozzleTemp: 0,
      targetNozzleTemp: 0,
      bedTemp: 0,
      targetBedTemp: 0,
      rawState: '',
    };
  }
}
