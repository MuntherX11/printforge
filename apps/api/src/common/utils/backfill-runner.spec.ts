import { Logger } from '@nestjs/common';
import { runBackfill, BACKFILL_LEASE_TTL_MS } from './backfill-runner';

/**
 * In-memory stand-in for the SystemSetting lease statements. It implements the
 * same semantics as the SQL: INSERT … ON CONFLICT only overwrites an expired
 * lease; UPDATE/DELETE only touch a lease whose value starts with the instance id.
 */
function fakePrisma(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const expiry = (v: string) => new Date(v.split('|')[1]).getTime();
  const owns = (v: string | undefined, instanceId: string) => !!v && v.startsWith(`${instanceId}|`);

  const $queryRaw = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    expect(strings.join('?')).toContain('ON CONFLICT (key) DO UPDATE');
    const [, key, value] = values as [string, string, string];
    const current = store.get(key);
    if (current !== undefined && !(expiry(current) < Date.now())) return [];
    store.set(key, value);
    return [{ value }];
  });

  const $executeRaw = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (sql.includes('UPDATE')) {
      const [value, key, instanceId] = values as [string, string, string];
      if (!owns(store.get(key), instanceId)) return 0;
      store.set(key, value);
      return 1;
    }
    if (sql.includes('DELETE')) {
      const [key, instanceId] = values as [string, string];
      if (!owns(store.get(key), instanceId)) return 0;
      store.delete(key);
      return 1;
    }
    throw new Error(`unexpected SQL ${sql}`);
  });

  return { store, prisma: { $queryRaw, $executeRaw } as any };
}

function fakeLogger() {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as Logger & { log: jest.Mock; warn: jest.Mock; error: jest.Mock };
}

const KEY = 'plate-layouts-v1';
const LEASE_KEY = `backfill-lease:${KEY}`;
const ok = { created: 1, skipped: 2, failed: 0 };

describe('runBackfill', () => {
  it('takes the lease, runs fn, logs the counts and releases the lease', async () => {
    const { store, prisma } = fakePrisma();
    const logger = fakeLogger();
    let leaseDuringRun: string | undefined;
    const fn = jest.fn(async (renew: () => Promise<void>) => {
      leaseDuringRun = store.get(LEASE_KEY);
      await renew();
      return ok;
    });

    await expect(runBackfill(prisma, logger, KEY, fn)).resolves.toBeUndefined();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(leaseDuringRun).toMatch(/\|\d{4}-\d{2}-\d{2}T/);
    const expiresAt = new Date(leaseDuringRun!.split('|')[1]).getTime();
    expect(expiresAt).toBeGreaterThan(Date.now() + BACKFILL_LEASE_TTL_MS - 60_000);
    expect(logger.log).toHaveBeenCalledWith(`Backfill ${KEY}: created 1, skipped 2, failed 0`);
    expect(store.has(LEASE_KEY)).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not call fn while another unexpired instance holds the lease', async () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    const { store, prisma } = fakePrisma({ [LEASE_KEY]: `other-host-1-abc|${future}` });
    const logger = fakeLogger();
    const fn = jest.fn(async () => ok);

    await expect(runBackfill(prisma, logger, KEY, fn)).resolves.toBeUndefined();

    expect(fn).not.toHaveBeenCalled();
    // The other runner's lease is untouched.
    expect(store.get(LEASE_KEY)).toBe(`other-host-1-abc|${future}`);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('takes over an expired lease', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const { store, prisma } = fakePrisma({ [LEASE_KEY]: `dead-host-1-abc|${past}` });
    const logger = fakeLogger();
    let leaseDuringRun: string | undefined;
    const fn = jest.fn(async () => {
      leaseDuringRun = store.get(LEASE_KEY);
      return ok;
    });

    await runBackfill(prisma, logger, KEY, fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(leaseDuringRun).toBeDefined();
    expect(leaseDuringRun!.startsWith('dead-host-1-abc|')).toBe(false);
    expect(store.has(LEASE_KEY)).toBe(false);
  });

  it('resolves when fn throws, logs the stack and releases the lease', async () => {
    const { store, prisma } = fakePrisma();
    const logger = fakeLogger();
    const boom = new Error('bug in fn');
    const fn = jest.fn(async () => {
      throw boom;
    });

    await expect(runBackfill(prisma, logger, KEY, fn)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, stack] = logger.error.mock.calls[0];
    expect(message).toContain('bug in fn');
    expect(stack).toBe(boom.stack);
    expect(store.has(LEASE_KEY)).toBe(false);
  });

  it('resolves and logs when the lease query itself throws (DB down)', async () => {
    const { prisma } = fakePrisma();
    prisma.$queryRaw.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const logger = fakeLogger();
    const fn = jest.fn(async () => ok);

    await expect(runBackfill(prisma, logger, KEY, fn)).resolves.toBeUndefined();

    expect(fn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toContain('ECONNREFUSED');
    // Nothing to release: the lease was never taken.
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('resolves and warns when releasing the lease throws', async () => {
    const { prisma } = fakePrisma();
    prisma.$executeRaw.mockRejectedValueOnce(new Error('release failed'));
    const logger = fakeLogger();

    await expect(runBackfill(prisma, logger, KEY, async () => ok)).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('release failed');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('renewLease extends the expiry of the lease it holds', async () => {
    const { store, prisma } = fakePrisma();
    const logger = fakeLogger();
    const seen: string[] = [];
    const realNow = Date.now;
    try {
      await runBackfill(prisma, logger, KEY, async (renew) => {
        seen.push(store.get(LEASE_KEY)!);
        const t = realNow() + 5 * 60_000;
        Date.now = () => t;
        await renew();
        seen.push(store.get(LEASE_KEY)!);
        return ok;
      });
    } finally {
      Date.now = realNow;
    }
    const [before, after] = seen.map((v) => new Date(v.split('|')[1]).getTime());
    expect(after).toBeGreaterThan(before);
    expect(seen[0].split('|')[0]).toBe(seen[1].split('|')[0]);
  });
});
