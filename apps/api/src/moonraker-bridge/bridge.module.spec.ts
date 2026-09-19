import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { PrismaService } from '../common/prisma/prisma.service';
import { JobCompletionService } from '../stock-ledger/job-completion.service';
import { BridgeModule } from './bridge.module';
import { CrealityWsService } from './creality-ws.service';
import { MoonrakerService } from './moonraker.service';

/**
 * The standalone printer bridge (bridge.main.ts) loads only Prisma and
 * Notifications around BridgeModule. Its dependency graph must resolve on its
 * own — in particular the shared JobCompletionService (StockLedgerModule, which
 * needs only Prisma). Lifecycle hooks that would open connections are stubbed;
 * dependency resolution is what's under test.
 */
describe('BridgeModule (standalone bridge boot)', () => {
  it('resolves with only Prisma and Notifications around it, and wires JobCompletionService into both bridges', async () => {
    const prismaInit = jest.spyOn(PrismaService.prototype, 'onModuleInit').mockResolvedValue(undefined);
    const prismaDestroy = jest.spyOn(PrismaService.prototype, 'onModuleDestroy').mockResolvedValue(undefined);
    const wsInit = jest.spyOn(CrealityWsService.prototype, 'onModuleInit').mockResolvedValue(undefined);

    @Module({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ SECRET_KEY: 'test-secret' })] }), BridgeModule],
    })
    class StandaloneBridgeTestModule {}

    const app = await NestFactory.createApplicationContext(StandaloneBridgeTestModule, { logger: false, abortOnError: false });
    try {
      const completion = app.get(JobCompletionService);
      expect(completion).toBeInstanceOf(JobCompletionService);
      expect((app.get(MoonrakerService) as any).completion).toBe(completion);
      expect((app.get(CrealityWsService) as any).completion).toBe(completion);
    } finally {
      await app.close();
      prismaInit.mockRestore();
      prismaDestroy.mockRestore();
      wsInit.mockRestore();
    }
  });
});
