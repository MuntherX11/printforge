import { Module, Global, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisCacheService } from './redis-cache.service';
import { REDIS_CLIENT } from './redis.constants';

export { REDIS_CLIENT } from './redis.constants';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('REDIS_URL', 'redis://localhost:6379');
        const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
        client.on('error', (err) => new Logger('RedisModule').error(`Redis connection error: ${err.message}`));
        return client;
      },
    },
    RedisCacheService,
  ],
  exports: [REDIS_CLIENT, RedisCacheService],
})
export class RedisModule {}
