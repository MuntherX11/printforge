import { Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CatalogCoreModule } from '../catalog-core/catalog-core.module';
import { PrismaModule } from '../common/prisma/prisma.module';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisCacheService } from '../common/redis/redis-cache.service';
import { PriceImpactReport, toCsv } from './price-impact-report';

/**
 * CLI for the WP11 price-impact report. CSV on stdout, notes on stderr.
 *
 *   node dist/release/price-impact-report.main.js [--threshold 10] > price-impact.csv
 *
 * Read-only by construction:
 *  - one database connection (`connection_limit=1`), switched to
 *    `default_transaction_read_only` before the first query, and checked;
 *  - a Prisma middleware that refuses every write action;
 *  - settings are read straight from the database (no Redis, so a copy of
 *    production never touches the live cache).
 * Point DATABASE_URL at a RESTORED COPY after `prisma db push`, never at the
 * live database, and run it before the new API has booted there.
 */

/** Settings read uncached: the report must not read or fill the live Redis cache. */
@Global()
@Module({
  providers: [{ provide: RedisCacheService, useValue: { getOrSet: (_k: string, _t: number, f: () => Promise<unknown>) => f(), invalidate: async () => undefined } }],
  exports: [RedisCacheService],
})
class NoCacheModule {}

@Module({
  imports: [PrismaModule, NoCacheModule, CatalogCoreModule],
  providers: [PriceImpactReport],
})
export class PriceImpactReportModule {}

const WRITE_ACTIONS = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'executeRaw', 'executeRawUnsafe']);

export function singleConnectionUrl(url: string | undefined): string {
  if (!url) throw new Error('DATABASE_URL is not set');
  const u = new URL(url);
  u.searchParams.set('connection_limit', '1');
  return u.toString();
}

function parseArgs(argv: string[]) {
  let threshold = 10;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--threshold') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0 || n > 1000) throw new Error('--threshold must be a number from 0 to 1000');
      threshold = n;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stderr.write('usage: node dist/release/price-impact-report.main.js [--threshold <pct>] > report.csv\n');
      process.exit(0);
    } else throw new Error(`unknown argument ${argv[i]}`);
  }
  return { threshold };
}

export async function main(argv = process.argv.slice(2)) {
  const { threshold } = parseArgs(argv);
  process.env.DATABASE_URL = singleConnectionUrl(process.env.DATABASE_URL);
  const app = await NestFactory.createApplicationContext(PriceImpactReportModule, { logger: ['error'] });
  try {
    const prisma = app.get(PrismaService);
    await prisma.$executeRawUnsafe('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    const [{ default_transaction_read_only: ro }] = await prisma.$queryRawUnsafe<Array<{ default_transaction_read_only: string }>>('SHOW default_transaction_read_only');
    if (ro !== 'on') throw new Error('could not put the connection in read-only mode — aborting');
    prisma.$use(async (params, next) => {
      if (WRITE_ACTIONS.has(params.action)) throw new Error(`price-impact report is read-only (refused ${params.model ?? 'raw'}.${params.action})`);
      return next(params);
    });
    const u = new URL(process.env.DATABASE_URL);
    process.stderr.write(`price-impact report: database ${u.hostname}/${u.pathname.slice(1)}, read-only, threshold ±${threshold} %\n`);
    const sections = await app.get(PriceImpactReport).build({ thresholdPct: threshold });
    process.stdout.write(toCsv(sections));
    for (const s of sections) process.stderr.write(`  ${s.name}: ${s.rows.length} rows\n`);
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`price-impact report failed: ${e?.stack ?? e}\n`);
    process.exit(1);
  });
}
