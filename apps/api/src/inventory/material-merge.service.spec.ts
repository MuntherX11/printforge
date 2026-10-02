import { CallHandler, ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { materialMergeSummary, type MaterialMergeCounts } from '@printforge/types';
import { lastValueFrom, of } from 'rxjs';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { fakeCatalogDb } from '../products/__fixtures__/fake-catalog-db';
import { MaterialMergeController } from './material-merge.controller';
import { planMergeStock, renameColourKey, renameJobLine, renameJobPlate } from './material-merge-plan';
import { MaterialMergeService } from './material-merge.service';

/**
 * Owner request: blank filaments a slicer import created ("PLA Beige", no
 * brand, cost 0, no spools) are merged into a real one. Every stored material
 * id moves to the target, then the blank is deleted.
 */

const BLANK = 'm-blank';
const BEIGE = 'm-beige';
const RED = 'm-red';
const PETG = 'm-petg';

const mat = (id: string, name: string, type: string, extra: Record<string, unknown> = {}) => ({
  id, name, type, color: null, colorHex: null, brand: null, costPerGram: 0, spoolPrice: null, spoolWeightGrams: null, density: 1.24, reorderPoint: 500, ...extra,
});

/** The `merge:jobPlates` narrowing query, served from the fake's JobPlate rows (LIKE '%<id>%'). */
function withPlateQuery(db: any) {
  const raw = db.$queryRaw.getMockImplementation();
  db.$queryRaw = jest.fn(async (q: { sql: string; values: any[] }) => {
    if (/merge:jobPlates/.test(q.sql)) {
      const id = String(q.values[1]).replace(/%/g, '');
      return db.t('jobPlate').filter((p: any) => p.colourKey.includes(`:${id}`) || JSON.stringify(p.slots).includes(id)).map((p: any) => ({ id: p.id }));
    }
    return raw(q);
  });
  return db;
}

function setup() {
  const db = withPlateQuery(fakeCatalogDb());
  db.insert('material', mat(BLANK, 'PLA Beige', 'PLA', { color: 'Beige' }));
  db.insert('material', mat(BEIGE, 'eSUN PLA Beige', 'PLA', { brand: 'eSUN', color: 'Beige', colorHex: 'E8D8B0', costPerGram: 0.02 }));
  db.insert('material', mat(RED, 'PLA Red', 'PLA', { color: 'Red', costPerGram: 0.02 }));
  db.insert('material', mat(PETG, 'PETG Black', 'PETG', { color: 'Black', costPerGram: 0.03 }));
  db.insert('user', { id: 'u1', name: 'Owner' });

  db.insert('product', { id: 'p1', name: 'Sardine tin' });
  db.insert('product', { id: 'p2', name: 'Fish' });
  db.insert('product', { id: 'p3', name: 'Untouched' });
  // c1: single filament in the blank, 4 in the column; a colour option already printed 3 in the real beige.
  db.insert('productComponent', { id: 'c1', productId: 'p1', materialId: BLANK, isMultiColor: false, description: 'Tin', gramsUsed: 10, stockOnHand: 4 });
  db.insert('componentColourStock', { id: 'r1', componentId: 'c1', colourKey: `0:${BEIGE}`, stockOnHand: 3 });
  // c2: multicolour blank + red; a row in beige + red (the new base) and one in red only.
  db.insert('productComponent', { id: 'c2', productId: 'p2', materialId: null, isMultiColor: true, description: 'Fish', gramsUsed: 8, stockOnHand: 2 });
  db.insert('componentMaterial', { id: 'cm1', componentId: 'c2', materialId: BLANK, colorIndex: 0, gramsUsed: 5 });
  db.insert('componentMaterial', { id: 'cm2', componentId: 'c2', materialId: RED, colorIndex: 1, gramsUsed: 3 });
  db.insert('componentColourStock', { id: 'r2', componentId: 'c2', colourKey: `0:${BEIGE}|1:${RED}`, stockOnHand: 1 });
  // c3: red part; printed stock in the blank (5) and the real beige (2) join; a 0 row in the blank is relabelled.
  db.insert('productComponent', { id: 'c3', productId: 'p1', materialId: RED, isMultiColor: false, description: 'Lid', gramsUsed: 4, stockOnHand: 0 });
  db.insert('componentColourStock', { id: 'r3', componentId: 'c3', colourKey: `0:${BLANK}`, stockOnHand: 5 });
  db.insert('componentColourStock', { id: 'r4', componentId: 'c3', colourKey: `0:${BEIGE}`, stockOnHand: 2 });
  db.insert('componentColourStock', { id: 'r5', componentId: 'c3', colourKey: `0:${BLANK}|1:${RED}`, stockOnHand: 0 });
  // c4: multicolour blank + beige: prints two colours in one filament afterwards.
  db.insert('productComponent', { id: 'c4', productId: 'p2', materialId: null, isMultiColor: true, description: 'Fin', gramsUsed: 2, stockOnHand: 0 });
  db.insert('componentMaterial', { id: 'cm3', componentId: 'c4', materialId: BLANK, colorIndex: 0, gramsUsed: 1 });
  db.insert('componentMaterial', { id: 'cm4', componentId: 'c4', materialId: BEIGE, colorIndex: 1, gramsUsed: 1 });
  // An untouched product.
  db.insert('productComponent', { id: 'c9', productId: 'p3', materialId: RED, isMultiColor: false, description: 'Other', gramsUsed: 1, stockOnHand: 1 });

  db.insert('productVariant', { id: 'v1', productId: 'p1', kind: 'COLOUR', name: 'Sand' });
  db.insert('productColourSlot', { id: 'cs1', productId: 'p1', name: 'Tin' });
  db.insert('colourOptionSlot', { id: 'a1', variantId: 'v1', colourSlotId: 'cs1', materialId: BLANK });

  db.insert('productionJob', { id: 'j1', name: 'Done', status: 'COMPLETED' });
  db.insert('productionJob', { id: 'j2', name: 'Queued', status: 'QUEUED' });
  db.insert('productionJob', { id: 'j3', name: 'Printing', status: 'IN_PROGRESS' });
  const line = (id: string, jobId: string, f: Record<string, unknown>) =>
    db.insert('jobMaterial', { id, jobId, slicedMaterialId: null, plannedMaterialId: null, plannedSlicedMaterialId: null, spoolId: null, gramsUsed: 5, costPerGram: 0, colorIndex: 0, ...f });
  line('l1', 'j1', { materialId: BLANK, plannedMaterialId: BLANK });
  line('l2', 'j2', { materialId: BLANK, plannedMaterialId: BLANK });
  line('l3', 'j2', { materialId: BEIGE, plannedMaterialId: BEIGE });
  line('l4', 'j3', { materialId: RED, slicedMaterialId: BLANK, plannedMaterialId: RED, plannedSlicedMaterialId: BLANK });
  line('l5', 'j3', { materialId: BEIGE, slicedMaterialId: BLANK, plannedMaterialId: BEIGE, plannedSlicedMaterialId: BLANK });
  line('l6', 'j3', { materialId: RED, plannedMaterialId: RED });

  const slot = (materialId: string, slicedMaterialId: string | null) => ({ colorIndex: 0, materialId, slicedMaterialId, colourSlotId: null, gramsPerPlate: 5 });
  db.insert('jobPlate', { id: 'jp1', jobId: 'j2', componentId: 'c1', colourKey: `0:${BLANK}`, slots: [slot(BLANK, null)] });
  db.insert('jobPlate', { id: 'jp2', jobId: 'j3', componentId: 'c3', colourKey: `0:${RED}`, slots: [slot(RED, BLANK)] });
  db.insert('jobPlate', { id: 'jp3', jobId: 'j3', componentId: 'c9', colourKey: `0:${RED}`, slots: [slot(RED, null)] });

  db.insert('componentStockMovement', { id: 'mv1', componentId: 'c1', colourKey: `0:${BLANK}`, baseColumn: true, delta: -1, balanceAfter: 4, reason: 'PLAN_ALLOCATE', orderItemId: 'oi1' });
  db.insert('componentStockMovement', { id: 'mv2', componentId: 'c3', colourKey: `0:${BLANK}`, baseColumn: false, delta: 5, balanceAfter: 5, reason: 'MANUAL_ADJUST' });
  db.insert('componentStockMovement', { id: 'mv3', componentId: 'c9', colourKey: `0:${RED}`, baseColumn: true, delta: 1, balanceAfter: 1, reason: 'MANUAL_ADJUST' });

  db.insert('spool', { id: 's1', materialId: BLANK, currentWeight: 0, isActive: false });
  db.insert('spool', { id: 's2', materialId: BEIGE, currentWeight: 900, isActive: true });

  const pricing = { recalcPricing: jest.fn(async () => []) };
  const cache = { invalidate: jest.fn(async () => undefined) };
  const svc = new MaterialMergeService(db as any, pricing as any, cache as any);
  return { db, svc, pricing, cache };
}

const TABLES = ['productComponent', 'componentMaterial', 'colourOptionSlot', 'jobMaterial', 'jobPlate', 'componentColourStock', 'componentStockMovement', 'spool', 'material', 'auditLog'];
const snapshot = (db: any) => JSON.stringify(TABLES.map((t) => db.t(t)));

describe('MaterialMergeService — dry run', () => {
  it('counts everything that would move, warns, and changes nothing', async () => {
    const { db, svc, pricing, cache } = setup();
    const before = snapshot(db);
    const r = await svc.merge(BLANK, { targetMaterialId: BEIGE }, 'u1');
    expect(r.merged).toBe(false);
    expect(r.source).toEqual({ id: BLANK, name: 'PLA Beige', type: 'PLA', color: 'Beige', colorHex: null, brand: null });
    expect(r.target.id).toBe(BEIGE);
    expect(r.counts).toEqual({
      componentFilaments: 1, // c1
      componentColourSlots: 2, // cm1, cm3
      colourAssignments: 1, // a1
      jobLines: 4, // l1, l2, l4, l5
      openJobLines: 3,
      jobPlates: 2, // jp1, jp2
      printedStockRows: 2, // r3, r5
      printedStockUnits: 5,
      printedStockCombined: 3, // r1 → c1's column, r2 → c2's column, r3 → r4
      stockMovements: 2,
      retiredSpools: 1,
      products: 2, // p1, p2
    });
    expect(r.warnings.map((w) => w.code)).toEqual(['STOCK_COMBINED', 'SAME_FILAMENT_TWICE', 'JOB_LINES_DOUBLED', 'PRICES_CHANGE']);
    expect(r.warnings.find((w) => w.code === 'JOB_LINES_DOUBLED')!.message).toBe('1 open job ends up with two Beige (eSUN PLA Beige) lines — when it completes, add the printed units to stock by hand');
    expect(snapshot(db)).toBe(before);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(pricing.recalcPricing).not.toHaveBeenCalled();
    expect(cache.invalidate).not.toHaveBeenCalled();
    expect(r).not.toHaveProperty('productIds');
  });

  it('a filament nothing uses: all counts 0, no warnings', async () => {
    const { db, svc } = setup();
    db.insert('material', mat('m-cyan', 'PLA Cyan', 'PLA', { color: 'Cyan' }));
    const r = await svc.merge('m-cyan', { targetMaterialId: BEIGE, confirm: false }, 'u1');
    expect(Object.values(r.counts).every((n) => n === 0)).toBe(true);
    expect(r.warnings).toEqual([]);
  });
});

describe('MaterialMergeService — confirm', () => {
  it('moves every reference to the target, then deletes the source; nothing names it afterwards', async () => {
    const { db, svc, pricing, cache } = setup();
    const r = await svc.merge(BLANK, { targetMaterialId: BEIGE, confirm: true }, 'u1');
    expect(r.merged).toBe(true);

    expect(db.t('material').some((m: any) => m.id === BLANK)).toBe(false);
    const rest = JSON.stringify(TABLES.filter((t) => t !== 'auditLog').map((t) => db.t(t)));
    expect(rest).not.toContain(BLANK);

    const by = (t: string, id: string) => db.t(t).find((x: any) => x.id === id);
    expect(by('productComponent', 'c1').materialId).toBe(BEIGE);
    expect(by('componentMaterial', 'cm1').materialId).toBe(BEIGE);
    expect(by('componentMaterial', 'cm3').materialId).toBe(BEIGE);
    expect(by('colourOptionSlot', 'a1').materialId).toBe(BEIGE);
    expect(by('spool', 's1').materialId).toBe(BEIGE);

    // Job lines: a "sliced with" equal to the filament it qualifies is cleared.
    expect(by('jobMaterial', 'l1')).toMatchObject({ materialId: BEIGE, plannedMaterialId: BEIGE, slicedMaterialId: null });
    expect(by('jobMaterial', 'l4')).toMatchObject({ materialId: RED, slicedMaterialId: BEIGE, plannedMaterialId: RED, plannedSlicedMaterialId: BEIGE });
    expect(by('jobMaterial', 'l5')).toMatchObject({ materialId: BEIGE, slicedMaterialId: null, plannedMaterialId: BEIGE, plannedSlicedMaterialId: null });
    expect(by('jobMaterial', 'l6')).toMatchObject({ materialId: RED, plannedMaterialId: RED });

    // Job plates: colour key and slot snapshot.
    expect(by('jobPlate', 'jp1')).toMatchObject({ colourKey: `0:${BEIGE}`, slots: [expect.objectContaining({ materialId: BEIGE, slicedMaterialId: null })] });
    expect(by('jobPlate', 'jp2')).toMatchObject({ colourKey: `0:${RED}`, slots: [expect.objectContaining({ materialId: RED, slicedMaterialId: BEIGE, gramsPerPlate: 5 })] });

    // Printed stock: c1's beige row folds into its column (4 + 3); c2's into its column (2 + 1);
    // c3's blank 5 joins its beige 2; the blank+red 0 row is relabelled.
    expect(by('productComponent', 'c1').stockOnHand).toBe(7);
    expect(by('componentColourStock', 'r1').stockOnHand).toBe(0);
    expect(by('productComponent', 'c2').stockOnHand).toBe(3);
    expect(by('componentColourStock', 'r2').stockOnHand).toBe(0);
    expect(by('componentColourStock', 'r3')).toBeUndefined();
    expect(by('componentColourStock', 'r4').stockOnHand).toBe(7);
    expect(by('componentColourStock', 'r5').colourKey).toBe(`0:${BEIGE}|1:${RED}`);
    expect(by('productComponent', 'c9').stockOnHand).toBe(1);

    // History relabelled (an open allocation still nets on the merged key), the moves recorded.
    expect(by('componentStockMovement', 'mv1').colourKey).toBe(`0:${BEIGE}`);
    expect(by('componentStockMovement', 'mv2').colourKey).toBe(`0:${BEIGE}`);
    const rekeys = db.t('componentStockMovement').filter((m: any) => m.reason === 'FILAMENT_REKEY')
      .map((m: any) => [m.componentId, m.colourKey, m.baseColumn, m.delta, m.balanceAfter]);
    expect(rekeys).toEqual([
      ['c1', `0:${BEIGE}`, false, -3, 0], ['c1', `0:${BEIGE}`, true, 3, 7],
      ['c2', `0:${BEIGE}|1:${RED}`, false, -1, 0], ['c2', `0:${BEIGE}|1:${RED}`, true, 1, 3],
      ['c3', `0:${BEIGE}`, false, -5, 0], ['c3', `0:${BEIGE}`, false, 5, 7],
    ]);
    expect(db.t('componentStockMovement').filter((m: any) => m.reason === 'FILAMENT_REKEY').every((m: any) => m.userId === 'u1' && /PLA Beige/.test(m.note))).toBe(true);

    // One audit row with the counts; the KPI cache and the touched products' prices after commit.
    expect(db.t('auditLog')).toEqual([expect.objectContaining({
      userId: 'u1', action: 'Material.merged', entityType: 'Material', entityId: BLANK,
      details: expect.objectContaining({ target: { id: BEIGE, name: 'eSUN PLA Beige' }, counts: r.counts }),
    })]);
    expect(cache.invalidate).toHaveBeenCalledWith('dashboard:kpis');
    expect(pricing.recalcPricing.mock.calls.map((c: unknown[]) => c[0])).toEqual(['p1', 'p2']);
  });

  it('one transaction under the identity lock, then both filament rows FOR UPDATE in id order, then the stock columns', async () => {
    const { db, svc } = setup();
    const order: string[] = [];
    const raw = db.$queryRaw.getMockImplementation();
    db.$queryRaw = jest.fn(async (q: { sql: string; values: any[] }) => {
      const m = /(material:advisory|lock:Material|stock:lockColumn)/.exec(q.sql);
      if (m) order.push(m[1] === 'stock:lockColumn' ? `column:${q.values[0]}` : m[1]);
      return raw(q);
    });
    await svc.merge(BLANK, { targetMaterialId: BEIGE, confirm: true }, 'u1');
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.locks).toEqual([{ table: 'Material', mode: 'UPDATE', ids: [BEIGE, BLANK] }]);
    expect(order).toEqual(['material:advisory', 'lock:Material', 'column:c1', 'column:c2', 'column:c3']);
  });

  it('a failure part way rolls everything back', async () => {
    const { db, svc } = setup();
    const before = snapshot(db);
    db.material.delete = jest.fn(async () => { throw new Error('boom'); });
    await expect(svc.merge(BLANK, { targetMaterialId: BEIGE, confirm: true }, 'u1')).rejects.toThrow('boom');
    expect(snapshot(db)).toBe(before);
  });
});

describe('MaterialMergeService — refusals', () => {
  const refused = async (body: unknown, message: string | RegExp, status: number, source = BLANK, tweak?: (db: any) => void) => {
    const { db, svc } = setup();
    tweak?.(db);
    const before = snapshot(db);
    let err: any;
    try { await svc.merge(source, body, 'u1'); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.getStatus()).toBe(status);
    expect(err.message).toMatch(message);
    expect(snapshot(db)).toBe(before);
  };

  it('the same filament → 400', () => refused({ targetMaterialId: BLANK, confirm: true }, 'Pick a different filament to merge into', 400));
  it('no target, or not an id → 400', async () => {
    await refused({}, 'Pick the filament to merge into', 400);
    await refused({ targetMaterialId: 'a b' }, 'Pick the filament to merge into', 400);
  });
  it('a key outside the allowlist → 400; confirm must be a boolean', async () => {
    await refused({ targetMaterialId: BEIGE, deleteSource: false }, 'property deleteSource should not exist', 400);
    await refused({ targetMaterialId: BEIGE, confirm: 'yes' }, '"confirm" must be true or false', 400);
  });
  it('a missing target, or a missing source → 404', async () => {
    await refused({ targetMaterialId: 'm-gone', confirm: true }, 'The filament to merge into no longer exists', 404);
    await refused({ targetMaterialId: BEIGE, confirm: true }, 'Material not found', 404, 'm-gone');
  });
  it('another material type → 409 naming both (dry run and confirm)', async () => {
    const msg = '"PLA Beige" is PLA and "PETG Black" is PETG — merge only into a filament of the same type';
    await refused({ targetMaterialId: PETG }, msg, 409);
    await refused({ targetMaterialId: PETG, confirm: true }, msg, 409);
  });
  it('the source still has an active spool → 409; retired spools move with it', async () => {
    await refused({ targetMaterialId: BEIGE, confirm: true }, '"PLA Beige" has 1 active spool — retire them first (merging doesn\'t move spool stock)', 409, BLANK,
      (db) => db.insert('spool', { id: 's3', materialId: BLANK, currentWeight: 500, isActive: true }));
  });
});

describe('merge rules (pure)', () => {
  it('renameColourKey relabels only whole material ids', () => {
    expect(renameColourKey('0:a|1:ab|2:a', 'a', 'z')).toBe('0:z|1:ab|2:z');
  });

  it('two source keys that become one colour are added together, never a unique-key clash', () => {
    const comp = { id: 'c', materialId: 'x', isMultiColor: false, materials: [] };
    const plan = planMergeStock([comp], [
      { id: 'r1', componentId: 'c', colourKey: '0:S|1:T', stockOnHand: 2 },
      { id: 'r2', componentId: 'c', colourKey: '0:T|1:S', stockOnHand: 3 },
      { id: 'r3', componentId: 'c', colourKey: '0:T|1:T', stockOnHand: 1 },
    ], 'S', 'T');
    expect(plan.steps).toEqual([
      { kind: 'combine', componentId: 'c', rowId: 'r1', from: '0:S|1:T', to: '0:T|1:T', into: 'row', units: 2 },
      { kind: 'combine', componentId: 'c', rowId: 'r2', from: '0:T|1:S', to: '0:T|1:T', into: 'row', units: 3 },
    ]);
    expect(plan).toMatchObject({ rows: 2, units: 5, combined: 2 });
  });

  it('a job line or plate that does not name the source is left alone', () => {
    expect(renameJobLine({ id: 'l', jobId: 'j', materialId: 'a', slicedMaterialId: null, plannedMaterialId: 'a', plannedSlicedMaterialId: null }, 'S', 'T')).toBeNull();
    expect(renameJobPlate({ colourKey: '0:a', slots: [{ materialId: 'a', slicedMaterialId: null }] }, 'S', 'T')).toBeNull();
  });

  it('materialMergeSummary says the counts in plain words, skipping zeros', () => {
    const zero: MaterialMergeCounts = {
      componentFilaments: 0, componentColourSlots: 0, colourAssignments: 0, jobLines: 0, openJobLines: 0, jobPlates: 0,
      printedStockRows: 0, printedStockUnits: 0, printedStockCombined: 0, stockMovements: 0, retiredSpools: 0, products: 0,
    };
    expect(materialMergeSummary(zero)).toEqual([]);
    expect(materialMergeSummary({ ...zero, componentFilaments: 1, componentColourSlots: 2, products: 2, jobLines: 4, openJobLines: 1, printedStockRows: 1, printedStockUnits: 5, retiredSpools: 1 })).toEqual([
      '3 part filaments in 2 products',
      '4 job filament lines (1 on open jobs)',
      '5 printed units in stock (1 colour bucket)',
      '1 retired spool',
    ]);
  });
});

describe('POST /materials/:id/merge route', () => {
  it('is ADMIN only, answers 200 (a dry run creates nothing)', () => {
    const handler = MaterialMergeController.prototype.merge;
    expect(Reflect.getMetadata(GUARDS_METADATA, MaterialMergeController)).toEqual([JwtAuthGuard]);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['ADMIN']);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
  });

  it('the generic audit row is skipped: the service writes its own (only when it merged)', async () => {
    const audit = { log: jest.fn(async () => ({})) };
    const interceptor = new AuditInterceptor(audit as never);
    const req = { method: 'POST', user: { id: 'u1' }, url: '/api/materials/m1/merge', route: { path: '/api/materials/:id/merge' }, params: { id: 'm1' }, body: {} };
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of({ merged: false }) };
    await lastValueFrom(interceptor.intercept(ctx, next));
    expect(audit.log).not.toHaveBeenCalled();
  });
});
