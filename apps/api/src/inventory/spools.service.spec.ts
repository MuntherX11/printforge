import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { UpdateSpoolDto } from '@printforge/types';
import type { PrismaService } from '../common/prisma/prisma.service';
import type { RedisCacheService } from '../common/redis/redis-cache.service';
import { fakeCatalogDb, type FakeCatalogDb } from '../products/__fixtures__/fake-catalog-db';
import { addJobRow, addSpool } from '../production/__fixtures__/production-harness';
import { SpoolsService } from './spools.service';

/**
 * Safety spec §2: deleting a spool never erases job history. A spool with any
 * job line is refused with 409 (active jobs first), the lines and the spool
 * stay, and only a spool no job ever used is deleted.
 */

const HISTORY_ACTIVE = "PF-A7X2 was used by 2 jobs and can't be deleted. Deactivate it instead — its job history is kept.";
const HISTORY_INACTIVE = "PF-A7X2 was used by 2 jobs and can't be deleted. It is already inactive, and its job history is kept.";
const ONE_ACTIVE = "PF-A7X2 is on 1 active job and can't be deleted. When that job is finished or cancelled, deactivate the spool instead.";
const TWO_ACTIVE = "PF-A7X2 is on 2 active jobs and can't be deleted. When those jobs are finished or cancelled, deactivate the spool instead.";

const made: FakeCatalogDb[] = [];

function setup(spool: Record<string, unknown> = {}) {
  const db = fakeCatalogDb();
  made.push(db);
  db.insert('material', { id: 'm-pla', name: 'eSUN PLA Red', type: 'PLA', color: 'Red', brand: 'eSUN', costPerGram: 0.01 });
  const s = addSpool(db, 'm-pla', 800, { id: 'sp-1', printforgeId: 'PF-A7X2', ...spool });
  const svc = new SpoolsService(db as unknown as PrismaService);
  return { db, svc, spoolId: s.id as string };
}

/** A job in `status` with `n` filament lines on the spool. */
function jobWithLines(db: FakeCatalogDb, spoolId: string, status: string, n = 1) {
  const job = addJobRow(db, { status });
  for (let i = 0; i < n; i++) {
    db.insert('jobMaterial', {
      jobId: job.id, materialId: 'm-pla', spoolId, gramsUsed: 5 + i, costPerGram: 0.01, colorIndex: 0,
      slicedMaterialId: null, plannedMaterialId: null, plannedSlicedMaterialId: null,
    });
  }
  return job;
}

async function conflictOf(p: Promise<unknown>): Promise<{ message: string; code: string }> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ConflictException);
  const conflict = err as ConflictException;
  expect(conflict.getStatus()).toBe(409);
  const body = conflict.getResponse() as { message: string; code: string };
  expect(conflict.message).toBe(body.message);
  return body;
}

const snapshot = (db: FakeCatalogDb) => JSON.stringify([db.t('spool'), db.t('jobMaterial'), db.t('productionJob')]);

afterEach(() => {
  for (const db of made.splice(0)) expect(db.calls).not.toContain('jobMaterial.deleteMany');
});

describe('SpoolsService.remove (safety spec §2)', () => {
  it('a spool with no job lines is deleted, in one transaction under a FOR UPDATE row lock', async () => {
    const { db, svc, spoolId } = setup();
    await expect(svc.remove(spoolId)).resolves.toEqual({ deleted: true });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.locks).toEqual([{ table: 'Spool', mode: 'UPDATE', ids: [spoolId] }]);
    expect(db.t('spool')).toEqual([]);
  });

  it('an active spool with 3 lines on 2 COMPLETED jobs → 409 SPOOL_HAS_HISTORY; spool and every line kept', async () => {
    const { db, svc, spoolId } = setup();
    jobWithLines(db, spoolId, 'COMPLETED', 2);
    jobWithLines(db, spoolId, 'COMPLETED', 1);
    const before = snapshot(db);
    expect(await conflictOf(svc.remove(spoolId))).toEqual({ message: HISTORY_ACTIVE, code: 'SPOOL_HAS_HISTORY' });
    expect(snapshot(db)).toBe(before);
    expect(db.t('jobMaterial')).toHaveLength(3);
    expect(db.t('spool').map((s: { id: string }) => s.id)).toEqual([spoolId]);
  });

  it('the same spool already inactive says so; a single job reads "1 job"', async () => {
    const inactive = setup({ isActive: false });
    jobWithLines(inactive.db, inactive.spoolId, 'COMPLETED', 2);
    jobWithLines(inactive.db, inactive.spoolId, 'COMPLETED', 1);
    expect(await conflictOf(inactive.svc.remove(inactive.spoolId))).toEqual({ message: HISTORY_INACTIVE, code: 'SPOOL_HAS_HISTORY' });

    const single = setup();
    jobWithLines(single.db, single.spoolId, 'COMPLETED', 2);
    expect((await conflictOf(single.svc.remove(single.spoolId))).message).toBe(
      "PF-A7X2 was used by 1 job and can't be deleted. Deactivate it instead — its job history is kept.",
    );
  });

  it.each(['QUEUED', 'IN_PROGRESS', 'PAUSED'])('one line on a %s job → 409 SPOOL_ON_ACTIVE_JOB; nothing changes', async (status) => {
    const { db, svc, spoolId } = setup();
    jobWithLines(db, spoolId, status);
    const before = snapshot(db);
    expect(await conflictOf(svc.remove(spoolId))).toEqual({ message: ONE_ACTIVE, code: 'SPOOL_ON_ACTIVE_JOB' });
    expect(snapshot(db)).toBe(before);
  });

  it('an active job wins over history: QUEUED + COMPLETED → SPOOL_ON_ACTIVE_JOB counting 1 active job', async () => {
    const { db, svc, spoolId } = setup();
    jobWithLines(db, spoolId, 'COMPLETED', 2);
    jobWithLines(db, spoolId, 'QUEUED', 2);
    expect(await conflictOf(svc.remove(spoolId))).toEqual({ message: ONE_ACTIVE, code: 'SPOOL_ON_ACTIVE_JOB' });
  });

  it('two active jobs use the plural text; only FAILED and CANCELLED jobs → SPOOL_HAS_HISTORY', async () => {
    const two = setup();
    jobWithLines(two.db, two.spoolId, 'QUEUED');
    jobWithLines(two.db, two.spoolId, 'IN_PROGRESS');
    expect(await conflictOf(two.svc.remove(two.spoolId))).toEqual({ message: TWO_ACTIVE, code: 'SPOOL_ON_ACTIVE_JOB' });

    const finished = setup();
    jobWithLines(finished.db, finished.spoolId, 'FAILED');
    jobWithLines(finished.db, finished.spoolId, 'CANCELLED');
    expect(await conflictOf(finished.svc.remove(finished.spoolId))).toEqual({ message: HISTORY_ACTIVE, code: 'SPOOL_HAS_HISTORY' });
  });

  it('an unknown id → 404 "Spool not found" and nothing is deleted', async () => {
    const { db, svc } = setup();
    const before = snapshot(db);
    await expect(svc.remove('sp-nope')).rejects.toThrow(new NotFoundException('Spool not found'));
    await expect(svc.remove('sp-nope')).rejects.toBeInstanceOf(NotFoundException);
    expect(snapshot(db)).toBe(before);
  });

  it('a legacy spool without a PF-ID is called "This spool"', async () => {
    const { db, svc, spoolId } = setup({ printforgeId: null });
    jobWithLines(db, spoolId, 'COMPLETED');
    expect((await conflictOf(svc.remove(spoolId))).message).toBe(
      "This spool was used by 1 job and can't be deleted. Deactivate it instead — its job history is kept.",
    );
    jobWithLines(db, spoolId, 'PAUSED');
    expect((await conflictOf(svc.remove(spoolId))).message).toBe(
      "This spool is on 1 active job and can't be deleted. When that job is finished or cancelled, deactivate the spool instead.",
    );
  });
});

/**
 * PATCH /spools/:id writes only its allowlist. UpdateSpoolDto is an interface
 * the ValidationPipe can't whitelist, so a nested relation write in the body
 * used to reach Prisma and get round §2 (job history) and §3 (identity).
 */
describe('SpoolsService.update allowlist', () => {
  /** A raw request body, as it arrives off the wire. */
  const patch = (svc: SpoolsService, id: string, body: unknown) => svc.update(id, body as UpdateSpoolDto);

  async function badRequestOf(p: Promise<unknown>): Promise<string> {
    let err: unknown;
    try {
      await p;
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).message;
  }

  const tables = (db: FakeCatalogDb) => JSON.stringify([db.t('spool'), db.t('jobMaterial'), db.t('material')]);

  it.each<[string, Record<string, unknown>, string]>([
    ['jobMaterials deleteMany', { jobMaterials: { deleteMany: {} } }, 'property jobMaterials should not exist'],
    ['jobMaterials set', { jobMaterials: { set: [] } }, 'property jobMaterials should not exist'],
    ['material rename', { material: { update: { color: 'Red' } } }, 'property material should not exist'],
    ['material reprice', { material: { update: { costPerGram: 1_000_000 } } }, 'property material should not exist'],
    ['materialId', { materialId: 'm-other' }, 'property materialId should not exist'],
    ['printforgeId beside a valid key', { currentWeight: 500, printforgeId: 'PF-ZZZZ' }, 'property printforgeId should not exist'],
  ])('%s → 400, and nothing is written', async (_label, body, message) => {
    const { db, svc, spoolId } = setup();
    jobWithLines(db, spoolId, 'COMPLETED', 2);
    const before = tables(db);
    expect(await badRequestOf(patch(svc, spoolId, body))).toBe(message);
    expect(tables(db)).toBe(before);
    expect(db.calls).not.toContain('spool.update');
  });

  it('after a refused jobMaterials write the spool keeps its history, so DELETE still says SPOOL_HAS_HISTORY', async () => {
    const { db, svc, spoolId } = setup();
    jobWithLines(db, spoolId, 'COMPLETED', 2);
    await badRequestOf(patch(svc, spoolId, { jobMaterials: { deleteMany: {} } }));
    expect((await conflictOf(svc.remove(spoolId))).code).toBe('SPOOL_HAS_HISTORY');
    expect(db.t('jobMaterial')).toHaveLength(2);
  });

  it('writes the allowed keys: grams bounded, lot number trimmed, a date parsed', async () => {
    const { db, svc, spoolId } = setup();
    await svc.update(spoolId, {
      currentWeight: 500, initialWeight: 1000, spoolWeight: 250, purchasePrice: 7.5,
      isActive: false, locationId: 'loc-b', lotNumber: '  L-7 ', purchaseDate: '2026-09-01',
    });
    expect(db.t('spool')[0]).toMatchObject({
      currentWeight: 500, initialWeight: 1000, spoolWeight: 250, purchasePrice: 7.5,
      isActive: false, locationId: 'loc-b', lotNumber: 'L-7', purchaseDate: new Date('2026-09-01'),
    });
    await svc.update(spoolId, { locationId: null, lotNumber: null, purchaseDate: null });
    expect(db.t('spool')[0]).toMatchObject({ locationId: null, lotNumber: null, purchaseDate: null, currentWeight: 500 });
  });

  it.each<[Record<string, unknown> | unknown[], string]>([
    [{ isActive: 'false' }, '"isActive" must be true or false'],
    [{ currentWeight: -50 }, '"currentWeight" must be between 0 and 100000'],
    [{ locationId: 5 }, '"locationId" must be a location id or null'],
    [{ lotNumber: 7 }, '"lotNumber" must be text'],
    [{ purchaseDate: 'soon' }, '"purchaseDate" must be a date'],
    [[{ currentWeight: 5 }], 'Request body must be a JSON object'],
  ])('%j → 400 %s', async (body, message) => {
    const { db, svc, spoolId } = setup();
    expect(await badRequestOf(patch(svc, spoolId, body))).toBe(message);
    expect(db.calls).not.toContain('spool.update');
  });

  it('an unknown id → 404 "Spool not found"', async () => {
    const { svc } = setup();
    await expect(svc.update('sp-nope', { isActive: false })).rejects.toThrow(new NotFoundException('Spool not found'));
  });
});

describe('spool writes clear the 60 s dashboard KPI cache', () => {
  it('after a successful update or delete; not after a refused one', async () => {
    const { db, spoolId } = setup();
    const invalidate = jest.fn(async (_key: string) => undefined);
    const svc = new SpoolsService(db as unknown as PrismaService, { invalidate } as unknown as RedisCacheService);
    await svc.update(spoolId, { isActive: false });
    expect(invalidate.mock.calls).toEqual([['dashboard:kpis']]);
    await expect(svc.update(spoolId, { jobMaterials: { deleteMany: {} } } as unknown as UpdateSpoolDto)).rejects.toBeInstanceOf(BadRequestException);
    expect(invalidate).toHaveBeenCalledTimes(1);
    await svc.remove(spoolId);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
