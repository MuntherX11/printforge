import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { MoonrakerService, MoonrakerSnapshot } from '../moonraker-bridge/moonraker.service';
import { PrismaService } from '../common/prisma/prisma.service';

@WebSocketGateway({
  cors: {
    origin: process.env.CORS_ORIGIN || 'https://printforge.mctx.tech',
    credentials: true,
  },
  namespace: '/ws',
  path: '/api/socket.io/',
})
export class EventsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(EventsGateway.name);
  private lastBroadcastPayload = new Map<string, any>();

  constructor(
    private moonraker: MoonrakerService,
    private jwtService: JwtService,
    private prisma: PrismaService,
  ) {}

  afterInit(server: Server) {
    this.logger.log('WebSocket gateway initialized');

    server.use((socket, next) => {
      try {
        const cookieHeader = socket.handshake.headers.cookie || '';
        const match = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/);
        if (!match) {
          return next(new Error('Unauthorized'));
        }
        const token = decodeURIComponent(match[1]);
        this.jwtService.verify(token);
        next();
      } catch {
        next(new Error('Unauthorized'));
      }
    });
  }

  handleConnection(client: Socket) {
    this.logger.debug(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  /**
   * Client requests a one-time printer status refresh.
   * Returns last known DB state — does NOT trigger a live poll.
   */
  @SubscribeMessage('requestPrinterStatus')
  async handlePrinterStatusRequest(client: Socket) {
    const printers = await this.prisma.printer.findMany({
      where: { isActive: true },
      select: { id: true, name: true, status: true, lastSeen: true },
    });
    client.emit('printerStatus', printers);
  }

  /**
   * Broadcast printer status to all connected clients.
   * Called from the Moonraker scheduler after each poll cycle.
   * Only emits when the payload has changed since the last broadcast.
   */
  broadcastPrinterStatus(data: Array<{ printerId: string; snapshot: MoonrakerSnapshot }>) {
    for (const r of data) {
      const payload = { printerId: r.printerId, ...r.snapshot };
      const serialized = JSON.stringify(payload);
      if (this.lastBroadcastPayload.get(r.printerId) === serialized) {
        continue;
      }
      this.lastBroadcastPayload.set(r.printerId, serialized);
      this.server?.emit('printerStatus', [payload]);
    }
  }

  /**
   * Broadcast a job progress update.
   */
  broadcastJobProgress(jobId: string, progress: number, status: string, remainingSecs?: number) {
    this.server?.emit('jobProgress', { jobId, progress, status, remainingSecs });
  }

  /**
   * Broadcast a notification to all clients.
   */
  broadcastNotification(notification: { type: string; title: string; message: string }) {
    this.server?.emit('notification', notification);
  }
}
