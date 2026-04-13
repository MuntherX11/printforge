import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { MoonrakerService, MoonrakerSnapshot } from '../moonraker-bridge/moonraker.service';

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/ws',
  path: '/api/socket.io/',
})
export class EventsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(EventsGateway.name);

  constructor(private moonraker: MoonrakerService) {}

  afterInit() {
    this.logger.log('WebSocket gateway initialized');
  }

  handleConnection(client: Socket) {
    this.logger.debug(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  /**
   * Client requests a one-time printer status refresh.
   */
  @SubscribeMessage('requestPrinterStatus')
  async handlePrinterStatusRequest(client: Socket) {
    const results = await this.moonraker.pollAllPrinters();
    client.emit('printerStatus', results.map(r => ({
      printerId: r.printerId,
      ...r.snapshot,
    })));
  }

  /**
   * Broadcast printer status to all connected clients.
   * Called from the Moonraker scheduler after each poll cycle.
   */
  broadcastPrinterStatus(data: Array<{ printerId: string; snapshot: MoonrakerSnapshot }>) {
    this.server?.emit('printerStatus', data.map(r => ({
      printerId: r.printerId,
      ...r.snapshot,
    })));
  }

  /**
   * Broadcast a job progress update.
   */
  broadcastJobProgress(jobId: string, progress: number, status: string) {
    this.server?.emit('jobProgress', { jobId, progress, status });
  }

  /**
   * Broadcast a notification to all clients.
   */
  broadcastNotification(notification: { type: string; title: string; message: string }) {
    this.server?.emit('notification', notification);
  }
}
