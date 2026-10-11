import { GUARDS_METADATA } from '@nestjs/common/constants';
import JSZip from 'jszip';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { parseProfilePatch } from './profile-input';
import { SlicerProfilesController } from './slicer-profiles.controller';
import { SlicerProfilesService } from './slicer-profiles.service';

type Row = Record<string, any>;

/**
 * A small in-memory Prisma stand-in: just the delegates and query shapes this
 * service uses (findUnique by id / kind_name, findFirst, findMany, create,
 * update, updateMany, delete, $transaction with rollback).
 */
function fakeDb() {
  let tables: Record<string, Row[]> = { slicerProfile: [], printer: [], material: [] };
  let seq = 0;

  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'kind_name') return row.kind === v.kind && row.name === v.name;
      if (v && typeof v === 'object' && 'not' in v) return row[k] !== v.not;
      return row[k] === v;
    });
  const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row });

  const delegate = (model: string) => ({
    findUnique: jest.fn(async ({ where, select }: Row) => {
      const row = tables[model].find((r) => matches(r, where));
      return row ? pick(row, select) : null;
    }),
    findFirst: jest.fn(async ({ where, select }: Row) => {
      const row = tables[model].find((r) => matches(r, where));
      return row ? pick(row, select) : null;
    }),
    findMany: jest.fn(async ({ where }: Row = {}) => tables[model].filter((r) => matches(r, where)).map((r) => ({ ...r }))),
    create: jest.fn(async ({ data, select }: Row) => {
      const row = { id: `${model}-${++seq}`, printerId: null, materialId: null, isDefault: false, updatedAt: new Date(), ...data };
      tables[model].push(row);
      return pick(row, select);
    }),
    update: jest.fn(async ({ where, data }: Row) => {
      const row = tables[model].find((r) => matches(r, where));
      if (!row) throw new Error('P2025');
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    }),
    updateMany: jest.fn(async ({ where, data }: Row) => {
      const rows = tables[model].filter((r) => matches(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    }),
    delete: jest.fn(async ({ where }: Row) => {
      const i = tables[model].findIndex((r) => matches(r, where));
      if (i === -1) throw new Error('P2025');
      return tables[model].splice(i, 1)[0];
    }),
  });

  const db: any = {
    t: (model: string) => tables[model],
    insert: (model: string, row: Row) => {
      const full = { printerId: null, materialId: null, isDefault: false, updatedAt: new Date('2026-01-01T00:00:00Z'), ...row };
      tables[model].push(full);
      return full;
    },
    $transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) => {
      const snapshot = structuredClone(tables);
      try {
        return await fn(db);
      } catch (e) {
        tables = snapshot;
        throw e;
      }
    }),
  };
  for (const m of Object.keys(tables)) db[m] = delegate(m);
  return db;
}

function fakeSidecar(reachable: boolean, unresolved: string[] = []) {
  return {
    health: jest.fn(async () => (reachable ? { reachable: true, orcaVersion: '2.4.2' } : { reachable: false, orcaVersion: null })),
    checkProfiles: jest.fn(async () => (reachable ? { ok: unresolved.length === 0, unresolved } : null)),
  };
}

async function bundle(structure: Record<string, unknown>, files: Record<string, unknown>): Promise<Express.Multer.File> {
  const zip = new JSZip();
  zip.file('bundle_structure.json', JSON.stringify(structure));
  for (const [name, content] of Object.entries(files)) zip.file(name, JSON.stringify(content));
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  return { buffer, originalname: 'x.orca_printer', size: buffer.length } as Express.Multer.File;
}

const MACHINE = { type: 'machine', name: 'Hi 0.4 - PF', inherits: 'Creality Hi 0.4 nozzle', nozzle_diameter: ['0.4'] };
const FILAMENT = { type: 'filament', name: 'eSUN PLA+ @Hi', inherits: 'eSUN PLA+ @System', filament_density: ['1.25'] };
const printerBundle = (m = MACHINE) =>
  bundle({ printer_config: ['printer/m.json'], filament_config: ['filament/f.json'] }, { 'printer/m.json': m, 'filament/f.json': FILAMENT });

function setup(sidecar = fakeSidecar(false)) {
  const db = fakeDb();
  db.insert('printer', { id: 'pr1', name: 'Hi #1' });
  db.insert('printer', { id: 'pr2', name: 'Hi #2' });
  db.insert('material', { id: 'm1', name: 'eSUN PLA+ Black', type: 'PLA' });
  const svc = new SlicerProfilesService(db, sidecar as any);
  return { db, svc, sidecar };
}

const status = async (p: Promise<unknown>) => {
  try { await p; } catch (e: any) { return e.getStatus?.() ?? e; }
  return 200;
};

describe('SlicerProfilesService — import', () => {
  it('creates rows as exported; the sidecar down → check null', async () => {
    const { db, svc, sidecar } = setup();
    const r = await svc.importBundle(await printerBundle());
    expect(r.imported).toEqual([
      { id: expect.any(String), kind: 'MACHINE', name: 'Hi 0.4 - PF', replaced: false },
      { id: expect.any(String), kind: 'FILAMENT', name: 'eSUN PLA+ @Hi', replaced: false },
    ]);
    expect(r.skipped).toEqual([]);
    expect(r.check).toBeNull();
    expect(sidecar.checkProfiles).toHaveBeenCalledWith([
      { kind: 'MACHINE', name: 'Hi 0.4 - PF', json: MACHINE },
      { kind: 'FILAMENT', name: 'eSUN PLA+ @Hi', json: FILAMENT },
    ]);
    expect(db.t('slicerProfile').find((p: Row) => p.kind === 'MACHINE').json).toEqual(MACHINE);
    const list = await svc.list();
    expect(list.map((p) => [p.kind, p.name, p.inherits, p.printerId, p.isDefault])).toEqual([
      ['MACHINE', 'Hi 0.4 - PF', 'Creality Hi 0.4 nozzle', null, false],
      ['FILAMENT', 'eSUN PLA+ @Hi', 'eSUN PLA+ @System', null, false],
    ]);
  });

  it('re-importing replaces the JSON and keeps printer / filament mappings and the default flag', async () => {
    const { db, svc } = setup();
    db.insert('slicerProfile', { id: 'sp1', kind: 'MACHINE', name: 'Hi 0.4 - PF', json: { name: 'Hi 0.4 - PF', old: '1' }, printerId: 'pr1' });
    db.insert('slicerProfile', { id: 'sp2', kind: 'FILAMENT', name: 'eSUN PLA+ @Hi', json: { name: 'eSUN PLA+ @Hi' }, materialId: 'm1' });
    db.insert('slicerProfile', { id: 'sp3', kind: 'PROCESS', name: 'Std', json: { name: 'Std' }, printerId: 'pr1', isDefault: true });
    const r = await svc.importBundle(await printerBundle({ ...MACHINE, nozzle_diameter: ['0.6'] }));
    expect(r.imported).toEqual([
      { id: 'sp1', kind: 'MACHINE', name: 'Hi 0.4 - PF', replaced: true },
      { id: 'sp2', kind: 'FILAMENT', name: 'eSUN PLA+ @Hi', replaced: true },
    ]);
    const by = (id: string) => db.t('slicerProfile').find((p: Row) => p.id === id);
    expect(by('sp1')).toMatchObject({ printerId: 'pr1', json: { ...MACHINE, nozzle_diameter: ['0.6'] } });
    expect(by('sp1').json.old).toBeUndefined();
    expect(by('sp2')).toMatchObject({ materialId: 'm1', json: FILAMENT });
    expect(by('sp3')).toMatchObject({ isDefault: true, printerId: 'pr1' });
    expect(db.t('slicerProfile')).toHaveLength(3);
  });

  it('the sidecar up → its check is returned, unresolved names included', async () => {
    const { svc } = setup(fakeSidecar(true, ['eSUN PLA+ @Hi']));
    const r = await svc.importBundle(await printerBundle());
    expect(r.check).toEqual({ ok: false, unresolved: ['eSUN PLA+ @Hi'] });
  });

  it('skipped presets are reported; a bundle that is not a zip → 400; no file → 400', async () => {
    const { svc, sidecar } = setup();
    const file = await bundle({ printer_config: ['../x.json', 'printer/m.json'] }, { 'printer/m.json': MACHINE });
    const r = await svc.importBundle(file);
    expect(r.imported).toHaveLength(1);
    expect(r.skipped).toEqual([{ name: '../x.json', reason: 'Unsafe path in bundle' }]);
    expect(sidecar.checkProfiles).toHaveBeenCalledTimes(1);
    expect(await status(svc.importBundle({ buffer: Buffer.from('nope') } as any))).toBe(400);
    expect(await status(svc.importBundle(undefined))).toBe(400);
  });
});

describe('SlicerProfilesService — mapping', () => {
  function seeded() {
    const s = setup();
    s.db.insert('slicerProfile', { id: 'mach', kind: 'MACHINE', name: 'M', json: { name: 'M' } });
    s.db.insert('slicerProfile', { id: 'proc1', kind: 'PROCESS', name: 'P1', json: { name: 'P1' } });
    s.db.insert('slicerProfile', { id: 'proc2', kind: 'PROCESS', name: 'P2', json: { name: 'P2' } });
    s.db.insert('slicerProfile', { id: 'fil', kind: 'FILAMENT', name: 'F', json: { name: 'F' } });
    return s;
  }

  it('maps a machine to an existing printer and a filament to an existing material; unknown ids → 404', async () => {
    const { svc } = seeded();
    expect((await svc.update('mach', { printerId: 'pr1' })).printerId).toBe('pr1');
    expect((await svc.update('fil', { materialId: 'm1' })).materialId).toBe('m1');
    expect(await status(svc.update('mach', { printerId: 'pr-none' }))).toBe(404);
    expect(await status(svc.update('fil', { materialId: 'm-none' }))).toBe(404);
    expect(await status(svc.update('gone', { printerId: 'pr1' }))).toBe(404);
    expect((await svc.update('mach', { printerId: null })).printerId).toBeNull();
  });

  it('the wrong mapping for the kind → 400', async () => {
    const { svc } = seeded();
    expect(await status(svc.update('fil', { printerId: 'pr1' }))).toBe(400);
    expect(await status(svc.update('mach', { materialId: 'm1' }))).toBe(400);
    expect(await status(svc.update('mach', { isDefault: true }))).toBe(400);
    expect(await status(svc.update('proc1', { isDefault: true }))).toBe(400); // no printer yet
  });

  it('isDefault is exclusive per printer and set in one transaction', async () => {
    const { db, svc } = seeded();
    await svc.update('proc1', { printerId: 'pr1', isDefault: true });
    await svc.update('proc2', { printerId: 'pr1' });
    expect(await svc.defaultProcessFor('pr1')).toEqual({ name: 'P1' });

    db.$transaction.mockClear();
    const r = await svc.update('proc2', { isDefault: true });
    expect(r.isDefault).toBe(true);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    const flags = Object.fromEntries(db.t('slicerProfile').map((p: Row) => [p.id, p.isDefault]));
    expect(flags).toEqual({ mach: false, proc1: false, proc2: true, fil: false });
    expect(await svc.defaultProcessFor('pr1')).toEqual({ name: 'P2' });

    // Another printer's default is untouched.
    db.insert('slicerProfile', { id: 'proc3', kind: 'PROCESS', name: 'P3', json: { name: 'P3' }, printerId: 'pr2', isDefault: true });
    await svc.update('proc1', { isDefault: true });
    expect(db.t('slicerProfile').find((p: Row) => p.id === 'proc3').isDefault).toBe(true);
    expect(db.t('slicerProfile').find((p: Row) => p.id === 'proc2').isDefault).toBe(false);
  });

  it('unmapping a default process clears its default; a failure rolls the transaction back', async () => {
    const { db, svc } = seeded();
    await svc.update('proc1', { printerId: 'pr1', isDefault: true });
    const r = await svc.update('proc1', { printerId: null });
    expect(r).toMatchObject({ printerId: null, isDefault: false });

    await svc.update('proc1', { printerId: 'pr1', isDefault: true });
    await svc.update('proc2', { printerId: 'pr1' });
    db.slicerProfile.update.mockImplementationOnce(async () => { throw new Error('boom'); });
    await expect(svc.update('proc2', { isDefault: true })).rejects.toThrow('boom');
    expect(db.t('slicerProfile').find((p: Row) => p.id === 'proc1').isDefault).toBe(true);
  });

  it('helpers return the raw json or null', async () => {
    const { svc } = seeded();
    expect(await svc.machineFor('pr1')).toBeNull();
    expect(await svc.filamentFor('m1')).toBeNull();
    await svc.update('mach', { printerId: 'pr1' });
    await svc.update('fil', { materialId: 'm1' });
    expect(await svc.machineFor('pr1')).toEqual({ name: 'M' });
    expect(await svc.filamentFor('m1')).toEqual({ name: 'F' });
    expect(await svc.defaultProcessFor('pr1')).toBeNull();
  });

  it('delete: 409 while mapped (printer or filament), 404 when missing, else deleted', async () => {
    const { db, svc } = seeded();
    await svc.update('mach', { printerId: 'pr1' });
    await svc.update('fil', { materialId: 'm1' });
    expect(await status(svc.remove('mach'))).toBe(409);
    expect(await status(svc.remove('fil'))).toBe(409);
    expect(await status(svc.remove('gone'))).toBe(404);
    expect(await svc.remove('proc1')).toEqual({ deleted: true });
    expect(db.t('slicerProfile').some((p: Row) => p.id === 'proc1')).toBe(false);
    await svc.update('mach', { printerId: null });
    expect(await svc.remove('mach')).toEqual({ deleted: true });
  });

  it('health proxies the sidecar', async () => {
    expect(await setup().svc.health()).toEqual({ reachable: false, orcaVersion: null });
    expect(await setup(fakeSidecar(true)).svc.health()).toEqual({ reachable: true, orcaVersion: '2.4.2' });
  });
});

describe('parseProfilePatch', () => {
  const refused = (body: unknown, msg: string | RegExp) => expect(() => parseProfilePatch(body)).toThrow(msg);
  it('allowlists keys and types', () => {
    expect(parseProfilePatch({ printerId: 'pr1', isDefault: true })).toEqual({ printerId: 'pr1', isDefault: true });
    expect(parseProfilePatch({ materialId: '' })).toEqual({ materialId: null });
    refused({ printerId: 'pr1', json: {} }, 'property json should not exist');
    refused({ isDefault: 'yes' }, '"isDefault" must be true or false');
    refused({ printerId: 'a b' }, '"printerId" must be an id');
    refused({}, 'Nothing to update');
    refused([], 'Request body must be a JSON object');
  });
});

describe('/slicer-profiles routes', () => {
  it('list and health are any staff; import, patch and delete are ADMIN', () => {
    const P = SlicerProfilesController.prototype;
    expect(Reflect.getMetadata(GUARDS_METADATA, SlicerProfilesController)).toEqual([JwtAuthGuard]);
    expect(Reflect.getMetadata(GUARDS_METADATA, P.list)).toEqual([StaffGuard]);
    expect(Reflect.getMetadata(GUARDS_METADATA, P.health)).toEqual([StaffGuard]);
    for (const h of [P.importBundle, P.update, P.remove]) {
      expect(Reflect.getMetadata(GUARDS_METADATA, h)).toEqual([RolesGuard]);
      expect(Reflect.getMetadata(ROLES_KEY, h)).toEqual(['ADMIN']);
    }
  });
});
