import { Module } from '@nestjs/common';
import { ConfiguratorController } from './configurator.controller';
import { ConfiguratorService } from './configurator.service';
import { ConfiguratorCleanupScheduler } from './configurator-cleanup.scheduler';
import { SettingsModule } from '../settings/settings.module';
import { CommunicationsModule } from '../communications/communications.module';

@Module({
  imports: [SettingsModule, CommunicationsModule],
  controllers: [ConfiguratorController],
  providers: [ConfiguratorService, ConfiguratorCleanupScheduler],
  exports: [ConfiguratorService],
})
export class ConfiguratorModule {}
