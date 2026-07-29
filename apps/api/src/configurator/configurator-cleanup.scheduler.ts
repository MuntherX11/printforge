import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfiguratorService } from './configurator.service';

/**
 * Artifact retention (spec §8): artifacts for terminal orders are removed after
 * the retention window so the shared host doesn't grow without bound. The
 * parameter set stays on the order, so any artifact can be regenerated.
 */
@Injectable()
export class ConfiguratorCleanupScheduler {
  private readonly logger = new Logger(ConfiguratorCleanupScheduler.name);

  constructor(private readonly configurator: ConfiguratorService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleCleanup() {
    const days = parseInt(process.env.ARTIFACT_RETENTION_DAYS || '90', 10);
    try {
      const { removed } = await this.configurator.cleanupExpiredArtifacts(days);
      if (removed > 0) this.logger.log(`Artifact retention pass removed ${removed} file(s)`);
    } catch (err: any) {
      this.logger.warn(`Artifact cleanup failed: ${err?.message}`);
    }
  }
}
