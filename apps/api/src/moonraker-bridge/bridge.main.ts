import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { BridgeModule } from './bridge.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    BridgeModule,
  ],
})
class StandaloneBridgeModule {}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(StandaloneBridgeModule);
  app.enableShutdownHooks();

  console.log('PrintForge Moonraker Bridge started');
  console.log('Polling Moonraker-connected printers every 10 seconds');

  // Keep the event loop alive — createApplicationContext doesn't start
  // an HTTP server, so without an explicit timer the process may exit.
  const keepalive = setInterval(() => {}, 60_000);

  const shutdown = async () => {
    console.log('Bridge shutting down...');
    clearInterval(keepalive);
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
bootstrap().catch(err => {
  console.error('Moonraker Bridge failed to start:', err);
  process.exit(1);
});
