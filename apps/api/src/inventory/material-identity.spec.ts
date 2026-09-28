import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { filamentIdentityKey, filamentIdentityLabel, normText } from '@printforge/types';
import { fakeCatalogDb } from '../products/__fixtures__/fake-catalog-db';
import {
  MATERIAL_BUSY_MESSAGE, MATERIAL_LOCK_WAIT, MATERIAL_TX, duplicateMaterialConflict, findDuplicateMaterial, isMaterialBusy,
  lockMaterialIdentity, waitForMaterialIdentity,
} from './material-identity';

/** Safety spec §3: the filament identity rule and the guard's building blocks. */

type Tx = Prisma.TransactionClient;
const asTx = (db: unknown) => db as Tx;
const sqlOf = (call: unknown[]) => (call[0] as { sql: string }).sql;

describe('filamentIdentityKey / filamentIdentityLabel', () => {
  it('brand and colour are compared after trim, space-collapse and lowercase', () => {
    expect(filamentIdentityKey({ brand: ' eSUN ', type: 'PLA', color: 'Fire  Engine Red' }))
      .toBe(filamentIdentityKey({ brand: 'esun', type: 'PLA', color: 'fire engine red' }));
    const noBrand = [null, '', '  ', undefined].map((brand) => filamentIdentityKey({ brand, type: 'PLA', color: 'Red' }));
    expect(new Set(noBrand).size).toBe(1);
    expect(noBrand[0]).toBe('|PLA|red');
  });

  it('a blank colour has no identity; exact names and types stay distinct', () => {
    for (const color of [null, '', '  ', undefined]) expect(filamentIdentityKey({ brand: 'eSUN', type: 'PLA', color })).toBeNull();
    expect(filamentIdentityKey({ brand: 'eSUN', type: 'PLA', color: 'Red' }))
      .not.toBe(filamentIdentityKey({ brand: 'eSUN', type: 'PLA', color: 'Fire Engine Red' }));
    expect(filamentIdentityKey({ brand: 'eSUN', type: 'PLA', color: 'Red' }))
      .not.toBe(filamentIdentityKey({ brand: 'eSUN', type: 'PETG', color: 'Red' }));
  });

  it('parity with normText (the Filaments list and Scan Label rule): every key part is its normText', () => {
    const table: Array<{ brand: string | null; type: string; color: string }> = [
      { brand: 'eSUN', type: 'PLA', color: 'Red' },
      { brand: '  Bambu   Lab ', type: 'PETG', color: ' Jade\tWhite ' },
      { brand: null, type: 'NYLON', color: 'GREEN' },
      { brand: 'Polymaker', type: 'ABS', color: 'Fire  Engine\nRed' },
      { brand: '', type: 'OTHER', color: 'ÉCRU' },
    ];
    for (const row of table) {
      expect(filamentIdentityKey(row)?.split('|')).toEqual([normText(row.brand), row.type, normText(row.color)]);
    }
  });

  it('labels keep the case and tidy the spaces', () => {
    expect(filamentIdentityLabel({ brand: 'eSUN', type: 'PLA', color: 'Red' })).toBe('eSUN · PLA · Red');
    expect(filamentIdentityLabel({ brand: null, type: 'PLA', color: 'Red' })).toBe('No brand · PLA · Red');
    expect(filamentIdentityLabel({ brand: '  Bambu   Lab ', type: 'PLA', color: ' Fire  Engine Red ' })).toBe('Bambu Lab · PLA · Fire Engine Red');
  });
});

describe('findDuplicateMaterial', () => {
  const seed = () => {
    const db = fakeCatalogDb();
    const at = (d: string) => new Date(`2026-0${d}T00:00:00Z`);
    db.insert('material', { id: 'm-new', name: 'Newer eSUN PLA Red', type: 'PLA', brand: 'eSUN', color: 'Red', colorHex: null, createdAt: at('3-01') });
    db.insert('material', { id: 'm-old', name: 'eSUN PLA Red', type: 'PLA', brand: ' esun', color: 'RED ', colorHex: 'C4402B', createdAt: at('1-01') });
    db.insert('material', { id: 'm-fer', name: 'eSUN PLA Fire Engine Red', type: 'PLA', brand: 'eSUN', color: 'Fire Engine Red', colorHex: null, createdAt: at('2-01') });
    db.insert('material', { id: 'm-petg', name: 'eSUN PETG Blue', type: 'PETG', brand: 'eSUN', color: 'Blue', colorHex: null, createdAt: at('2-01') });
    return db;
  };

  it('returns the oldest of two legacy duplicates (createdAt ascending)', async () => {
    const db = seed();
    const dup = await findDuplicateMaterial(asTx(db), { type: 'PLA', brand: 'ESUN', color: 'red' });
    expect(dup).toMatchObject({ id: 'm-old', name: 'eSUN PLA Red', colorHex: 'C4402B' });
  });

  it('excludes exceptId, so a row is never its own duplicate', async () => {
    const db = seed();
    expect((await findDuplicateMaterial(asTx(db), { type: 'PLA', brand: 'eSUN', color: 'Red' }, 'm-old'))?.id).toBe('m-new');
    expect(await findDuplicateMaterial(asTx(db), { type: 'PLA', brand: 'eSUN', color: 'Fire Engine Red' }, 'm-fer')).toBeNull();
  });

  it('returns null when only the type differs', async () => {
    const db = seed();
    expect(await findDuplicateMaterial(asTx(db), { type: 'PLA', brand: 'eSUN', color: 'Blue' })).toBeNull();
    expect(await findDuplicateMaterial(asTx(db), { type: 'PETG', brand: 'eSUN', color: 'Red' })).toBeNull();
  });

  it('returns null for a colourless identity without querying', async () => {
    const findMany = jest.fn();
    const db = { material: { findMany } };
    expect(await findDuplicateMaterial(asTx(db), { type: 'PLA', brand: 'eSUN', color: '  ' })).toBeNull();
    expect(await findDuplicateMaterial(asTx(db), { type: 'PLA', brand: 'eSUN', color: null })).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('lockMaterialIdentity / waitForMaterialIdentity', () => {
  it('the bounded wait stays inside the transaction timeout', () => {
    expect(MATERIAL_LOCK_WAIT).toEqual({ attempts: 50, delayMs: 200 });
    expect(MATERIAL_LOCK_WAIT.attempts * MATERIAL_LOCK_WAIT.delayMs).toBeLessThan(MATERIAL_TX.timeout);
    expect(MATERIAL_TX).toEqual({ timeout: 30_000, maxWait: 10_000 });
  });

  it('resolves after one try-lock query when the lock is free', async () => {
    const $queryRaw = jest.fn(async () => [{ ok: true }]);
    await expect(lockMaterialIdentity(asTx({ $queryRaw }))).resolves.toBeUndefined();
    expect($queryRaw).toHaveBeenCalledTimes(1);
    const sql = sqlOf($queryRaw.mock.calls[0]);
    expect(sql).toContain('material:advisory');
    expect(sql).toContain('pg_try_advisory_xact_lock');
    expect(sql).toContain("hashtext('material:identity')");
  });

  it('a held lock → 409 MATERIAL_BUSY after exactly `attempts` tries, never a blocking wait', async () => {
    const $queryRaw = jest.fn(async () => [{ ok: false }]);
    let err: unknown;
    try {
      await lockMaterialIdentity(asTx({ $queryRaw }), { attempts: 3, delayMs: 0 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toEqual({ message: MATERIAL_BUSY_MESSAGE, code: 'MATERIAL_BUSY' });
    expect($queryRaw).toHaveBeenCalledTimes(3);
    for (const call of $queryRaw.mock.calls) expect(sqlOf(call)).not.toMatch(/pg_advisory_xact_lock/);
    expect(isMaterialBusy(err)).toBe(true);
  });

  it('waits between tries and succeeds when the lock frees up', async () => {
    const answers = [[{ ok: false }], [], [{ ok: true }]];
    const $queryRaw = jest.fn(async () => answers.shift());
    await expect(lockMaterialIdentity(asTx({ $queryRaw }), { attempts: 3, delayMs: 1 })).resolves.toBeUndefined();
    expect($queryRaw).toHaveBeenCalledTimes(3);
  });

  it('slicer imports wait on the same key with the blocking form', async () => {
    const $queryRaw = jest.fn(async () => [{ ok: 1 }]);
    await waitForMaterialIdentity(asTx({ $queryRaw }));
    const sql = sqlOf($queryRaw.mock.calls[0]);
    expect(sql).toContain('material:advisory');
    expect(sql).toContain("pg_advisory_xact_lock(hashtext('material:identity'))");
  });
});

describe('duplicateMaterialConflict', () => {
  const existing = { id: 'm-old', name: 'eSUN PLA Red' };

  it('create: names the incoming identity and the existing row, and says to add a spool', () => {
    const err = duplicateMaterialConflict(existing, { type: 'PLA', brand: ' eSUN ', color: 'Red' }, 'create');
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toEqual({
      message: 'eSUN · PLA · Red already exists as "eSUN PLA Red" — add a spool to it instead',
      code: 'MATERIAL_DUPLICATE',
      existing,
    });
    expect(isMaterialBusy(err)).toBe(false);
  });

  it('update: the same text without the advice', () => {
    const err = duplicateMaterialConflict(existing, { type: 'PLA', brand: null, color: 'Red' }, 'update');
    expect(err.message).toBe('No brand · PLA · Red already exists as "eSUN PLA Red"');
  });
});
