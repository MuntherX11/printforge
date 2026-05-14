import { Module, OnModuleInit } from '@nestjs/common';
import { EventsGateway } from './events.gateway';
import { GatewayModule } from './gateway.module';
import { BridgeModule } from '../moonraker-bridge/bridge.module';
import { MoonrakerScheduler } from '../moonraker-bridge/moonraker.scheduler';

@Module({
  imports: [
    GatewayModule,
    BridgeModule,
  ],
  // EventsGateway is provided + exported by GatewayModule (@Global)
})
export class WebSocketModule implements OnModuleInit {
  constructor(
    private gateway: EventsGateway,
    private scheduler: MoonrakerScheduler,
  ) {}

  onModuleInit() {
    // Wire up the gateway as the broadcaster for printer status updates
    this.scheduler.setBroadcaster(this.gateway);
  }
}
