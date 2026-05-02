import { Injectable, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.constants';

@Injectable()
export class TokenBlocklistService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Block a specific token JTI until it naturally expires. ttlSeconds = seconds until exp. */
  async block(jti: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    await this.redis.set(`blocklist:jti:${jti}`, '1', 'EX', ttlSeconds);
  }

  /** Returns true if this JTI has been revoked. */
  async isBlocked(jti: string): Promise<boolean> {
    const result = await this.redis.exists(`blocklist:jti:${jti}`);
    return result === 1;
  }
}
