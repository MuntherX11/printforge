import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { PrismaService } from '../prisma/prisma.service';

/** How long a runner may hold a backfill lease without renewing it. */
export const BACKFILL_LEASE_TTL_MS = 10 * 60 * 1000;

export interface BackfillCounts {
  created: number;
  skipped: number;
  failed: number;
}

export type BackfillFn = (renewLease: () => Promise<void>) => Promise<BackfillCounts>;

/** Minimal Prisma surface the runner needs (keeps the spec free of a real client). */
type LeasePrisma = Pick<PrismaService, '$queryRaw' | '$executeRaw'>;

/**
 * Runs one boot-time backfill under a lease row in SystemSetting.
 *
 * Why a lease and not pg_advisory_lock: Prisma's pool can run lock and unlock on
 * different connections, so session advisory locks are unreliable. The lease is
 * a SystemSetting row `backfill-lease:<key>` = `<instanceId>|<expiresAt ISO>`,
 * taken with one INSERT … ON CONFLICT that only overwrites an expired lease.
 * Correctness never depends on the lease: each backfill item claims itself with
 * a guarded marker update. The lease only stops two runners doing double work.
 *
 * NEVER REJECTS. The API runs without an unhandledRejection handler, so an
 * escaped rejection from a boot-time `setImmediate` would kill the process and,
 * with `restart: unless-stopped`, crash-loop it. Every failure is logged.
 */
export async function runBackfill(
  prisma: LeasePrisma,
  logger: Logger,
  key: string,
  fn: BackfillFn,
): Promise<void> {
  const leaseKey = `backfill-lease:${key}`;
  const instanceId = `${safeHost()}-${process.pid}-${randomUUID()}`;
  const leaseValue = () => `${instanceId}|${new Date(Date.now() + BACKFILL_LEASE_TTL_MS).toISOString()}`;
  let acquired = false;

  try {
    const rows = await prisma.$queryRaw<Array<{ value: string }>>`
      INSERT INTO "SystemSetting" (id, key, value) VALUES (${randomUUID()}, ${leaseKey}, ${leaseValue()})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        WHERE split_part("SystemSetting".value, '|', 2)::timestamptz < now()
      RETURNING value`;
    if (!Array.isArray(rows) || rows.length === 0) {
      logger.log(`Backfill ${key}: another instance holds the lease — skipping this run`);
      return;
    }
    acquired = true;

    const renewLease = async () => {
      const count = await prisma.$executeRaw`
        UPDATE "SystemSetting" SET value = ${leaseValue()}
        WHERE key = ${leaseKey} AND value LIKE ${instanceId} || '|%'`;
      if (count === 0) {
        // Items claim themselves, so carrying on is safe; the lease only saves work.
        logger.warn(`Backfill ${key}: lease was lost (expired and taken over) — continuing`);
      }
    };

    const { created, skipped, failed } = await fn(renewLease);
    logger.log(`Backfill ${key}: created ${created}, skipped ${skipped}, failed ${failed}`);
  } catch (e) {
    const err = e as { message?: unknown; stack?: unknown };
    logger.error(
      `Backfill ${key} failed: ${typeof err?.message === 'string' ? err.message : String(e)}`,
      typeof err?.stack === 'string' ? err.stack : undefined,
    );
  } finally {
    if (acquired) {
      try {
        await prisma.$executeRaw`
          DELETE FROM "SystemSetting" WHERE key = ${leaseKey} AND value LIKE ${instanceId} || '|%'`;
      } catch (e) {
        const err = e as { message?: unknown };
        logger.warn(
          `Backfill ${key}: could not release the lease (it expires on its own): ${
            typeof err?.message === 'string' ? err.message : String(e)
          }`,
        );
      }
    }
  }
}

function safeHost(): string {
  try {
    return hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'host';
  } catch {
    return 'host';
  }
}
