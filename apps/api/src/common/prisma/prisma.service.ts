import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    // Timeout middleware registered first (outermost wrapper)
    this.$use(async (params, next) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new ServiceUnavailableException('Database query timed out'));
        }, 10000);
      });
      try {
        const result = await Promise.race([next(params), timeoutPromise]);
        clearTimeout(timeoutId);
        return result;
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    });

    // Slow-query logging middleware registered second (inner)
    this.$use(async (params, next) => {
      const start = Date.now();
      const result = await next(params);
      const duration = Date.now() - start;
      if (duration > 500) {
        this.logger.warn(
          `Slow query: ${params.model}.${params.action} took ${duration}ms`,
        );
      }
      return result;
    });

    // Retry $connect up to 3 times with 1s delay
    let retries = 3;
    while (retries > 0) {
      try {
        await this.$connect();
        break;
      } catch (error) {
        retries--;
        const attempt = 4 - retries;
        this.logger.error(`Database connect failed, retrying (${attempt}/3)…`);
        if (retries === 0) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
