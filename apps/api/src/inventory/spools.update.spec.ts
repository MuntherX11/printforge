import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { UpdateSpoolDto } from '@printforge/types';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { PrismaService } from '../common/prisma/prisma.service';
import { fakeCatalogDb, type FakeCatalogDb } from '../products/__fixtures__/fake-catalog-db';
import { addJobRow, addSpool } from '../production/__fixtures__/production-harness';
import { SpoolsController } from './spools.controller';
import { SpoolsService } from './spools.service';

/**
 * PATCH /spools/:id writes only its allowlist. UpdateSpoolDto is an interface
 * the ValidationPipe can't whitelist, so a nested relation write in the body
 * used to reach Prisma: `jobMaterials` rewrote or erased job history,
 * `material` renamed or repriced the filament, and `printforgeId` or
 * `materialId` changed the spool's QR identity or cost basis.
 */

function setup() {
  const db = fakeCatalogDb();
  db.insert('material', { id: 'm-pla', name: 'eSUN PLA Red', type: 'PLA', color: 'Red', brand: 'eSUN', costPerGram: 0.01 });
  const s = addSpool(db, 'm-pla', 800, { id: 'sp-1', printforgeId: 'PF-A7X2', initialWeight: 1000, spoolWeight: 200 });
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

describe('SpoolsService.update allowlist', () => {
  it.each<[string, Record<string, unknown>, string]>([
    ['jobMaterials deleteMany', { jobMaterials: { deleteMany: {} } }, 'property jobMaterials should not exist'],
    ['jobMaterials updateMany', { jobMaterials: { updateMany: { where: {}, data: { gramsUsed: 0 } } } }, 'property jobMaterials should not exist'],
    ['material rename', { material: { update: { color: 'Red' } } }, 'property material should not exist'],
    ['material reprice', { material: { update: { costPerGram: 1_000_000 } } }, 'property material should not exist'],
    ['materialId', { materialId: 'm-other' }, 'property materialId should not exist'],
    ['location create', { location: { create: { name: 'Shelf Z' } } }, 'property location should not exist'],
    ['id', { id: 'sp-2' }, 'property id should not exist'],
    ['createdAt', { createdAt: '2020-01-01' }, 'property createdAt should not exist'],
    ['printforgeId beside a valid key', { currentWeight: 500, printforgeId: 'PF-ZZZZ' }, 'property printforgeId should not exist'],
  ])('%s → 400, and nothing is written', async (_label, body, message) => {
    const { db, svc, spoolId } = setup();
    jobWithLines(db, spoolId, 'COMPLETED', 2);
    const before = tables(db);
    expect(await badRequestOf(patch(svc, spoolId, body))).toBe(message);
    expect(tables(db)).toBe(before);
    expect(db.calls).not.toContain('spool.update');
  });

  it('saves the Edit Spool dialog payload and the Deactivate button payload', async () => {
    const { db, svc, spoolId } = setup();
    // inventory/[id]/page.tsx handleEditSpool
    await svc.update(spoolId, { currentWeight: 612.5, locationId: 'loc-b', isActive: true });
    expect(db.t('spool')[0]).toMatchObject({ currentWeight: 612.5, locationId: 'loc-b', isActive: true, printforgeId: 'PF-A7X2', materialId: 'm-pla' });
    // the same dialog with "No location" sends null
    await svc.update(spoolId, { currentWeight: 600, locationId: null, isActive: true });
    expect(db.t('spool')[0]).toMatchObject({ currentWeight: 600, locationId: null });
    // handleDeactivateSpool
    await svc.update(spoolId, { isActive: false });
    expect(db.t('spool')[0]).toMatchObject({ isActive: false, currentWeight: 600 });
  });

  it('writes the other allowed keys: grams bounded, lot number trimmed, a date parsed', async () => {
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
    [{ currentWeight: Infinity }, '"currentWeight" must be a number'],
    [{ purchasePrice: 1e9 }, '"purchasePrice" must be between 0 and 100000'],
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

  it('PATCH /spools/:id stays ADMIN or OPERATOR', () => {
    const reflector = new Reflector();
    expect(reflector.get(GUARDS_METADATA, SpoolsController.prototype.update)).toEqual([RolesGuard]);
    expect(reflector.get(ROLES_KEY, SpoolsController.prototype.update)).toEqual(['ADMIN', 'OPERATOR']);
  });
});
