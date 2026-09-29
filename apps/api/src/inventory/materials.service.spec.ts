import { ConflictException } from '@nestjs/common';
import { MaterialType, type BulkMaterialUploadRow } from '@printforge/types';
import { fixtureMaterial, M, sardineRow } from '../catalog-core/__fixtures__/sardine-tin';
import type { PrismaService } from '../common/prisma/prisma.service';
import type { RedisCacheService } from '../common/redis/redis-cache.service';
import { fakeCatalogDb, seedProduct } from '../products/__fixtures__/fake-catalog-db';
import * as identity from './material-identity';
import { MATERIAL_BUSY_MESSAGE } from './material-identity';
import { MaterialsService } from './materials.service';

/** §7.1 item 32: a filament in use can't be deleted, and nothing else is ever deleted with it. */
describe('MaterialsService.remove', () => {
  const setup = () => {
    const db = fakeCatalogDb();
    seedProduct(db, sardineRow());
    db.insert('material', fixtureMaterial(M.grey));
    db.insert('material', fixtureMaterial(M.crimson));
    return { db, svc: new MaterialsService(db as any) };
  };
  const snapshot = (db: any) => JSON.stringify(['productComponent', 'componentMaterial', 'plateLayout', 'componentColourStock', 'componentStockMovement', 'spool', 'jobMaterial', 'colourOptionSlot', 'productVariant'].map((t) => db.t(t)));

  it('a filament assigned by a colour → 409 naming the counts; nothing deleted', async () => {
    const { db, svc } = setup();
    db.insert('spool', { materialId: M.gold, currentWeight: 900, isActive: true });
    db.insert('jobMaterial', { jobId: 'j1', materialId: M.gold, slicedMaterialId: null, plannedMaterialId: null, plannedSlicedMaterialId: null, gramsUsed: 3 });
    const before = snapshot(db);
    await expect(svc.remove(M.gold)).rejects.toThrow('"PLA Gold" is used by 0 parts, 2 colours, 1 job lines and 1 spools — remove it from those first');
    expect(snapshot(db)).toBe(before);
    expect(db.t('material').some((m: any) => m.id === M.gold)).toBe(true);
  });

  it("the own filament of a size's component → 409; the component, its layouts, colour stock and ledger stay", async () => {
    const { db, svc } = setup();
    db.insert('componentColourStock', { componentId: 'c9', colourKey: `0:${M.red}`, stockOnHand: 2 });
    db.insert('componentStockMovement', { componentId: 'c9', colourKey: `0:${M.red}`, baseColumn: false, delta: 2, balanceAfter: 2, reason: 'MANUAL_ADJUST' });
    const before = snapshot(db);
    await expect(svc.remove(M.silver)).rejects.toThrow('"PLA Silver" is used by 4 parts');
    expect(snapshot(db)).toBe(before);
  });

  it('only a ComponentColourStock key with stock > 0 → 409; a zero balance does not count', async () => {
    const { db, svc } = setup();
    db.insert('componentColourStock', { componentId: 'c1', colourKey: `0:${M.crimson}`, stockOnHand: 3 });
    db.insert('componentColourStock', { componentId: 'c2', colourKey: `0:${M.grey}|1:${M.silver}`, stockOnHand: 0 });
    await expect(svc.remove(M.crimson)).rejects.toThrow('is used by 1 parts');
    await expect(svc.remove(M.grey)).resolves.toEqual({ deleted: true });
  });

  it('only JobMaterial.plannedMaterialId → 409; only a spool → 409', async () => {
    const { db, svc } = setup();
    db.insert('jobMaterial', { jobId: 'j1', materialId: M.black, slicedMaterialId: null, plannedMaterialId: M.crimson, plannedSlicedMaterialId: null, gramsUsed: 3 });
    await expect(svc.remove(M.crimson)).rejects.toThrow('0 parts, 0 colours, 1 job lines and 0 spools');
    db.insert('spool', { materialId: M.grey, currentWeight: 10, isActive: false });
    await expect(svc.remove(M.grey)).rejects.toThrow('0 parts, 0 colours, 0 job lines and 1 spools');
  });

  it('an unreferenced filament is deleted; an unknown one → 404', async () => {
    const { db, svc } = setup();
    await expect(svc.remove(M.grey)).resolves.toEqual({ deleted: true });
    expect(db.t('material').some((m: any) => m.id === M.grey)).toBe(false);
    await expect(svc.remove('m-nope')).rejects.toThrow('Material not found');
  });

  it('is one transaction under a row lock and never deletes dependants: a failure after the count leaves the row', async () => {
    const { db, svc } = setup();
    db.material.delete = jest.fn(async () => { throw new Error('boom'); });
    await expect(svc.remove(M.grey)).rejects.toThrow('boom');
    expect(db.t('material').some((m: any) => m.id === M.grey)).toBe(true);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.locks).toEqual([{ table: 'Material', mode: 'UPDATE', ids: [M.grey] }]);
    expect(db.calls.filter((c: string) => /deleteMany/.test(c))).toEqual([]);
  });
});

// ------------------------------------------------ duplicate guard (safety spec §3)

const T = (n: number) => new Date(Date.UTC(2026, 0, n));

/** An in-memory DB with filaments, and an event log of the calls the guard makes. */
function guardSetup(rows: Array<Record<string, unknown>> = []) {
  const db = fakeCatalogDb();
  for (const r of rows) {
    db.insert('material', { brand: null, color: null, colorHex: null, costPerGram: 0.01, spoolPrice: null, spoolWeightGrams: null, density: 1.24, reorderPoint: 500, ...r });
  }
  const events: string[] = [];
  const rawQuery = db.$queryRaw;
  db.$queryRaw = jest.fn(async (sql: { sql: string }) => {
    events.push(/material:advisory/.test(sql.sql) ? 'advisory' : 'raw');
    return rawQuery(sql);
  });
  const transaction = db.$transaction;
  db.$transaction = jest.fn(async (arg: unknown, opts?: unknown) => {
    events.push('tx:begin');
    try {
      return await transaction(arg, opts);
    } finally {
      events.push('tx:end');
    }
  });
  for (const method of ['findMany', 'create', 'createMany', 'update']) {
    const original = db.material[method];
    db.material[method] = jest.fn(async (args: unknown) => {
      events.push(`material.${method}`);
      return original(args);
    });
  }
  return { db, events, svc: new MaterialsService(db as unknown as PrismaService) };
}

const RED = { id: 'm-red', name: 'eSUN PLA Red', type: 'PLA', brand: 'eSUN', color: 'Red', colorHex: 'C4402B', createdAt: T(1) };

type ConflictBody = { message: string; code: string; existing?: { id: string; name: string } };

async function conflictBody(p: Promise<unknown>): Promise<ConflictBody> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ConflictException);
  return (err as ConflictException).getResponse() as ConflictBody;
}

describe('MaterialsService.create — duplicate brand + type + colour', () => {
  it("' esun ' / PLA / 'RED' over an existing eSUN PLA Red → 409 MATERIAL_DUPLICATE naming it; nothing created", async () => {
    const { db, svc } = guardSetup([RED]);
    const body = await conflictBody(svc.create({ name: 'X', type: MaterialType.PLA, brand: ' esun ', color: 'RED', costPerGram: 0.01 }));
    expect(body).toEqual({
      message: 'esun · PLA · RED already exists as "eSUN PLA Red" — add a spool to it instead',
      code: 'MATERIAL_DUPLICATE',
      existing: { id: 'm-red', name: 'eSUN PLA Red' },
    });
    expect(body.message.endsWith('— add a spool to it instead')).toBe(true);
    expect(db.t('material')).toHaveLength(1);
  });

  it("eSUN / PLA / Red over a stored ' esun ' / PLA / 'RED' → 409 labelled with the incoming spelling", async () => {
    const { db, svc } = guardSetup([{ ...RED, id: 'm-odd', name: 'esun pla red (old sheet)', brand: ' esun ', color: 'RED' }]);
    const body = await conflictBody(svc.create({ name: 'eSUN PLA Red', type: MaterialType.PLA, brand: 'eSUN', color: 'Red', costPerGram: 0.01 }));
    expect(body).toEqual({
      message: 'eSUN · PLA · Red already exists as "esun pla red (old sheet)" — add a spool to it instead',
      code: 'MATERIAL_DUPLICATE',
      existing: { id: 'm-odd', name: 'esun pla red (old sheet)' },
    });
    expect(db.t('material')).toHaveLength(1);
  });

  it('names the oldest of legacy duplicates', async () => {
    const { svc } = guardSetup([{ ...RED, id: 'm-new', name: 'Newer Red', createdAt: T(5) }, RED]);
    const body = await conflictBody(svc.create({ name: 'X', type: MaterialType.PLA, brand: 'eSUN', color: 'Red' }));
    expect(body.existing).toEqual({ id: 'm-red', name: 'eSUN PLA Red' });
  });

  it("exact names stay distinct: eSUN PLA 'Fire Engine Red' and eSUN PETG Red are created", async () => {
    const { db, svc } = guardSetup([RED]);
    const fer = await svc.create({ name: 'eSUN PLA Fire Engine Red', type: MaterialType.PLA, brand: 'eSUN', color: 'Fire Engine Red', costPerGram: 0.01 });
    expect(fer).toMatchObject({ name: 'eSUN PLA Fire Engine Red', color: 'Fire Engine Red', brand: 'eSUN', type: 'PLA' });
    await svc.create({ name: 'eSUN PETG Red', type: MaterialType.PETG, brand: 'eSUN', color: 'Red', costPerGram: 0.01 });
    expect(db.t('material')).toHaveLength(3);
  });

  it("a blank brand ('   ') is the same as no brand: refused when a brandless PLA Red exists", async () => {
    const { db, svc } = guardSetup([{ ...RED, id: 'm-nb', name: 'PLA Red', brand: null }]);
    const body = await conflictBody(svc.create({ name: 'Y', type: MaterialType.PLA, brand: '   ', color: 'Red' }));
    expect(body.message).toBe('No brand · PLA · Red already exists as "PLA Red" — add a spool to it instead');
    expect(db.t('material')).toHaveLength(1);
  });

  it('a filament with no colour is created beside a colourless brandless PLA, with no transaction and no lock', async () => {
    const { db, events, svc } = guardSetup([{ id: 'm-plain', name: 'PLA Plain', type: 'PLA', createdAt: T(1) }]);
    await svc.create({ name: 'PLA Other', type: MaterialType.PLA, costPerGram: 0.02 });
    await svc.create({ name: 'PLA Blank', type: MaterialType.PLA, color: '  ' });
    expect(db.t('material')).toHaveLength(3);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(events).toEqual(['material.create', 'material.create']);
  });

  it('the advisory try-lock runs inside the single transaction, before the duplicate lookup', async () => {
    const { events, svc, db } = guardSetup([RED]);
    await svc.create({ name: 'eSUN PLA Blue', type: MaterialType.PLA, brand: 'eSUN', color: 'Blue' });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['tx:begin', 'advisory', 'material.findMany', 'material.create', 'tx:end']);
  });
});

describe('MaterialsService.update — the lock only when the identity changes', () => {
  const C = { id: 'm-blue', name: 'eSUN PLA Blue', type: 'PLA', brand: 'eSUN', color: 'Blue', createdAt: T(2) };

  it('a legacy duplicate row stays editable, including a colour case or spacing change', async () => {
    const { db, events, svc } = guardSetup([RED, { ...RED, id: 'm-red-2', name: 'eSUN PLA Red (old)', createdAt: T(3) }]);
    const out = await svc.update('m-red', { name: 'new', type: MaterialType.PLA, brand: 'ESUN', color: 'red ' });
    expect(out).toMatchObject({ id: 'm-red', name: 'new', brand: 'ESUN', color: 'red' });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(events).not.toContain('advisory');
  });

  it('a price-only save that resends type, brand and colour: no transaction, no lock, no identity column written', async () => {
    const { db, events, svc } = guardSetup([RED]);
    const out = await svc.update('m-red', { name: 'eSUN PLA Red', type: MaterialType.PLA, brand: 'eSUN', color: 'Red', spoolPrice: 12, spoolWeightGrams: 1000 });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(events).toEqual(['material.update']);
    const data = db.material.update.mock.calls[0][0].data;
    expect(Object.keys(data).sort()).toEqual(['costPerGram', 'name', 'spoolPrice', 'spoolWeightGrams']);
    expect(data.costPerGram).toBeCloseTo(0.012, 9);
    expect(out).toMatchObject({ type: 'PLA', brand: 'eSUN', color: 'Red', colorHex: 'C4402B', spoolPrice: 12 });
  });

  it('moving a row onto an existing identity → 409 with the update text; nothing changes', async () => {
    const { db, svc } = guardSetup([RED, C]);
    const before = JSON.stringify(db.t('material'));
    const body = await conflictBody(svc.update('m-blue', { color: 'Red' }));
    expect(body).toEqual({ message: 'eSUN · PLA · Red already exists as "eSUN PLA Red"', code: 'MATERIAL_DUPLICATE', existing: { id: 'm-red', name: 'eSUN PLA Red' } });
    expect(body.message).not.toContain('add a spool');
    expect(JSON.stringify(db.t('material'))).toBe(before);
  });

  it('brand → null while a brandless PLA Red exists → 409; a free identity change goes through the lock', async () => {
    const { db, events, svc } = guardSetup([RED, { ...RED, id: 'm-nb', name: 'PLA Red', brand: null, createdAt: T(4) }, C]);
    const body = await conflictBody(svc.update('m-red', { brand: null as unknown as string }));
    expect(body.existing).toEqual({ id: 'm-nb', name: 'PLA Red' });
    events.length = 0;
    await svc.update('m-blue', { color: 'Green' });
    expect(db.t('material').find((m: { id: string }) => m.id === 'm-blue')).toMatchObject({ color: 'Green' });
    expect(events).toEqual(['tx:begin', 'advisory', 'material.findMany', 'material.update', 'tx:end']);
  });
});

describe('MaterialsService.bulkImport — identity checks on the sheet', () => {
  const row = (name: string, color: string | undefined): BulkMaterialUploadRow =>
    ({ name, type: 'PLA', brand: 'eSUN', color, costPerGram: 0.01 });

  it('a new name with an existing identity is skipped; a repeat within the sheet names the earlier row', async () => {
    const { db, svc } = guardSetup([RED]);
    const out = await svc.bulkImport([row('Red again', 'Red'), row('Sky', 'Sky Blue'), row('Sky 2', ' sky  blue ')]);
    expect(out).toEqual({
      created: 1,
      skipped: 2,
      errors: [
        'Row 2: eSUN · PLA · Red already exists as "eSUN PLA Red" — skipped',
        'Row 4: eSUN · PLA · sky blue repeats row 3 — skipped',
      ],
    });
    expect(db.t('material').map((m: { name: string }) => m.name)).toEqual(['eSUN PLA Red', 'Sky']);
    const fresh = await guardSetup([]).svc.bulkImport([row('A', 'Red'), row('B', 'Red')]);
    expect(fresh).toEqual({ created: 1, skipped: 1, errors: ['Row 3: eSUN · PLA · Red repeats row 2 — skipped'] });
  });

  it('Red and Fire Engine Red are both created; colourless rows are not identity-checked; the name+type message is unchanged', async () => {
    const { db, events, svc } = guardSetup([{ id: 'm-plain', name: 'Plain', type: 'PLA', createdAt: T(1) }]);
    const out = await svc.bulkImport([row('Red', 'Red'), row('FER', 'Fire Engine Red'), row('Blank 1', undefined), row('Blank 2', undefined), row('plain', undefined)]);
    expect(out).toEqual({ created: 4, skipped: 1, errors: ['"plain" (PLA) already exists — skipped'] });
    expect(db.t('material')).toHaveLength(5);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // (the fake's createMany inserts through create, one per row)
    expect(events.filter((e) => e !== 'material.create')).toEqual(['tx:begin', 'advisory', 'material.findMany', 'material.createMany', 'tx:end']);
  });

  it('a failed insert reports only "Bulk insert failed: …", with no lines from the rolled-back pass', async () => {
    const { db, svc } = guardSetup([RED]);
    db.material.createMany = jest.fn(async () => { throw new Error('boom'); });
    const out = await svc.bulkImport([row('Red again', 'Red'), row('Blue', 'Blue'), row('Blue 2', 'Blue')]);
    expect(out).toEqual({ created: 0, skipped: 3, errors: ['Bulk insert failed: boom'] });
    expect(db.t('material')).toHaveLength(1);

    const invalid = { name: 'No type', costPerGram: 0.01 } as unknown as BulkMaterialUploadRow;
    const withInvalid = await svc.bulkImport([invalid, row('Blue', 'Blue')]);
    expect(withInvalid.skipped).toBe(2);
    expect(withInvalid.errors).toEqual(['Row 2: missing required fields (name, type, and either spoolPrice or costPerGram)', 'Bulk insert failed: boom']);
  });
});

describe('a busy identity lock is a 409 MATERIAL_BUSY on every guarded path, never a 500', () => {
  afterEach(() => jest.restoreAllMocks());

  it('create, identity-changing update and bulk upload', async () => {
    const busy = new ConflictException({ message: MATERIAL_BUSY_MESSAGE, code: 'MATERIAL_BUSY' });
    jest.spyOn(identity, 'lockMaterialIdentity').mockRejectedValue(busy);
    const { db, svc } = guardSetup([RED]);
    const before = JSON.stringify(db.t('material'));
    const attempts = [
      () => svc.create({ name: 'Blue', type: MaterialType.PLA, brand: 'eSUN', color: 'Blue' }),
      () => svc.update('m-red', { color: 'Blue' }),
      () => svc.bulkImport([{ name: 'Blue', type: 'PLA', color: 'Blue', costPerGram: 0.01 }]),
    ];
    for (const attempt of attempts) {
      expect(await conflictBody(attempt())).toEqual({ message: MATERIAL_BUSY_MESSAGE, code: 'MATERIAL_BUSY' });
    }
    expect(JSON.stringify(db.t('material'))).toBe(before);
  });
});


describe('filament writes clear the 60 s dashboard KPI cache', () => {
  it('after a create, an update and a delete; not after a refused duplicate', async () => {
    const { db } = guardSetup([RED]);
    const invalidate = jest.fn(async (_key: string) => undefined);
    const svc = new MaterialsService(db as unknown as PrismaService, { invalidate } as unknown as RedisCacheService);
    await conflictBody(svc.create({ name: 'X', type: MaterialType.PLA, brand: 'eSUN', color: 'Red' }));
    expect(invalidate).not.toHaveBeenCalled();
    const blue = await svc.create({ name: 'eSUN PLA Blue', type: MaterialType.PLA, brand: 'eSUN', color: 'Blue' });
    await svc.update(blue.id, { reorderPoint: 800 });
    await svc.remove(blue.id);
    expect(invalidate.mock.calls).toEqual([['dashboard:kpis'], ['dashboard:kpis'], ['dashboard:kpis']]);
  });
});
