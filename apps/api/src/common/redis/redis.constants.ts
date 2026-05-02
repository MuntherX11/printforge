/** Injection token for the ioredis client — kept in a standalone file to avoid
 *  circular imports between redis.module.ts and redis-cache.service.ts. */
export const REDIS_CLIENT = 'REDIS_CLIENT';
