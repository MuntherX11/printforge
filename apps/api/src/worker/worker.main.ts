import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();

  console.log('PrintForge Worker started');
  console.log('Low-stock checks scheduled every hour');

  // Keep the event loop alive — createApplicationContext doesn't start
  // an HTTP server, so without an explicit timer the process may exit
  // if the scheduler fails to attach its own timers.
  const keepalive = setInterval(() => {}, 60_000);

  const shutdown = async () => {
    console.log('Worker shutting down...');
    clearInterval(keepalive);
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
bootstrap().catch(err => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});
