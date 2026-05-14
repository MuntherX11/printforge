import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventsGateway } from './events.gateway';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../common/prisma/prisma.module';

/**
 * @Global module that provides EventsGateway to the entire application.
 * Extracting the gateway here breaks the circular dependency:
 *   WebSocketModule → BridgeModule → NotificationsModule → WebSocketModule
 * NotificationsModule now imports GatewayModule instead of WebSocketModule.
 */
@Global()
@Module({
  imports: [
    AuthModule,
    PrismaModule,
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
export class GatewayModule {}
