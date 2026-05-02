import { Module, OnModuleInit } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventsGateway } from './events.gateway';
import { BridgeModule } from '../moonraker-bridge/bridge.module';
import { MoonrakerScheduler } from '../moonraker-bridge/moonraker.scheduler';

@Module({
  imports: [
    BridgeModule,
    // EventsGateway.afterInit() calls jwtService.verify() for WS auth — must match AuthModule config
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('SECRET_KEY'),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRY', '7d') },
      }),
    }),
  ],
  providers: [EventsGateway],
  exports: [EventsGateway],
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
