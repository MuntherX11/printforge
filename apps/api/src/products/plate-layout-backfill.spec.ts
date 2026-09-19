import { Logger } from '@nestjs/common';
import { fakeCatalogDb, seedProduct } from './__fixtures__/fake-catalog-db';
import { PlateLayoutBackfillService } from './plate-layout-backfill.service';

/** §7.1 item 12: BF-1 plate layouts from legacy calibration (§2.4). */

const mat = { id: 'm1', name: 'PLA Black', type: 'PLA', color: 'Black', colorHex: '111111', costPerGram: 0.01 };
const mat2 = { id: 'm2', name: 'PLA White', type: 'PLA', color: 'White', colorHex: 'FFFFFF', costPerGram: 0.01 };

function comp(id: string, over: Record<string, unknown> = {}) {
  return {
    id, variantId: null, description: id, quantity: 1, sortOrder: 0, gramsUsed: 9.4, printMinutes: 34, isMultiColor: false,
    materialId: 'm1', material: mat, colorChanges: 0, stockOnHand: 0, platedMigratedAt: null,
    platedUnits: null, platedMinutes: null, platedGrams: null, ...over,
  };
}

function setup(components: any[]) {
  const db = fakeCatalogDb();
  seedProduct(db, { id: 'p1', name: 'Tin', components });
  const svc = new PlateLayoutBackfillService(db as any);
  return { db, svc };
}

const layoutsOf = (db: any, id: string) => db.t('plateLayout').filter((l: any) => l.componentId === id);
const slotsOf = (db: any, layoutId: string) => db.t('plateLayoutSlot').filter((s: any) => s.layoutId === layoutId).map((s: any) => [s.colorIndex, s.gramsUsed]);
const marked = (db: any, id: string) => db.t('productComponent').find((c: any) => c.id === id).platedMigratedAt != null;

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('BF-1 plate-layouts-v1', () => {
  it('creates a CALIBRATION layout with proportional slots (multicolour) and a single slot (single material)', async () => {
    const { db, svc } = setup([
      comp('box', { platedUnits: 12, platedMinutes: 243, platedGrams: 112.8 }),
      comp('lid', {
        isMultiColor: true, materialId: null, material: null, gramsUsed: 6, platedUnits: 15, platedMinutes: 260, platedGrams: 90,
        materials: [{ colorIndex: 0, materialId: 'm1', material: mat, gramsUsed: 5.2 }, { colorIndex: 1, materialId: 'm2', material: mat2, gramsUsed: 0.8 }],
      }),
    ]);
    const counts = await svc.run();
    expect(counts).toEqual({ created: 2, skipped: 0, failed: 0 });
    const [box] = layoutsOf(db, 'box');
    expect(box).toMatchObject({ name: '×12', unitsPerPlate: 12, plateMinutes: 243, plateGrams: 112.8, source: 'CALIBRATION', attachmentId: null, colorChanges: 0, isActive: true });
    expect(slotsOf(db, box.id)).toEqual([[0, 112.8]]);
    const [lid] = layoutsOf(db, 'lid');
    expect(slotsOf(db, lid.id)).toEqual([[0, 78], [1, 12]]);
    expect(marked(db, 'box') && marked(db, 'lid')).toBe(true);
  });

  it('grams default to per-unit grams × units when platedGrams is missing', async () => {
    const { db, svc } = setup([comp('box', { platedUnits: 10, platedMinutes: 200 })]);
    await svc.run();
    expect(layoutsOf(db, 'box')[0]).toMatchObject({ plateGrams: 94, isActive: true });
  });

  it('skips (and marks) when a same-size active layout exists', async () => {
    const { db, svc } = setup([comp('box', { platedUnits: 12, platedMinutes: 243, platedGrams: 112.8, plateLayouts: [{ id: 'lx', name: '×12', unitsPerPlate: 12, plateMinutes: 240, plateGrams: 110, isActive: true, sortOrder: 0 }] })]);
    expect(await svc.run()).toEqual({ created: 0, skipped: 1, failed: 0 });
    expect(layoutsOf(db, 'box')).toHaveLength(1);
    expect(marked(db, 'box')).toBe(true);
  });

  it('partial values → marked, no layout', async () => {
    const { db, svc } = setup([comp('box', { platedUnits: 12, platedMinutes: null, platedGrams: 112.8 })]);
    expect(await svc.run()).toEqual({ created: 0, skipped: 1, failed: 0 });
    expect(layoutsOf(db, 'box')).toHaveLength(0);
    expect(marked(db, 'box')).toBe(true);
  });

  it('out-of-range legacy values (platedUnits 600, platedMinutes 200000) → marked, no layout', async () => {
    const { db, svc } = setup([
      comp('a', { platedUnits: 600, platedMinutes: 300, platedGrams: 100 }),
      comp('b', { platedUnits: 12, platedMinutes: 200000, platedGrams: 100 }),
      comp('c', { platedUnits: 2.5, platedMinutes: 30, platedGrams: 10 }),
    ]);
    expect(await svc.run()).toEqual({ created: 0, skipped: 3, failed: 0 });
    expect(db.t('plateLayout')).toHaveLength(0);
    expect(['a', 'b', 'c'].every((id) => marked(db, id))).toBe(true);
  });

  it('unsliced component (gramsUsed 0, platedGrams null) → grams 0 → marked, no layout', async () => {
    const { db, svc } = setup([comp('box', { gramsUsed: 0, platedUnits: 12, platedMinutes: 243 })]);
    expect(await svc.run()).toEqual({ created: 0, skipped: 1, failed: 0 });
    expect(db.t('plateLayout')).toHaveLength(0);
    expect(marked(db, 'box')).toBe(true);
  });

  it('stale grams (40 % off the per-unit grams) → created inactive, warning logged', async () => {
    // 9.4 g per unit; 12 × 9.4 × 1.4 = 157.92 g on the plate.
    const { db, svc } = setup([comp('box', { platedUnits: 12, platedMinutes: 243, platedGrams: 157.92 })]);
    expect(await svc.run()).toEqual({ created: 1, skipped: 0, failed: 0 });
    expect(layoutsOf(db, 'box')[0].isActive).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('created inactive for review: plate grams differ by 40 % from the component'));
  });

  it('two runners on the same component → exactly one layout (guarded claim)', async () => {
    const { db, svc } = setup([comp('box', { platedUnits: 12, platedMinutes: 243, platedGrams: 112.8 })]);
    const other = new PlateLayoutBackfillService(db as any);
    const [a, b] = await Promise.all([svc.run(), other.run()]);
    expect(a.created + b.created).toBe(1);
    expect(a.skipped + b.skipped).toBe(1);
    expect(layoutsOf(db, 'box')).toHaveLength(1);
  });

  it('re-run is a no-op, and a deleted layout is not recreated', async () => {
    const { db, svc } = setup([comp('box', { platedUnits: 12, platedMinutes: 243, platedGrams: 112.8 })]);
    await svc.run();
    expect(await svc.run()).toEqual({ created: 0, skipped: 0, failed: 0 });
    await db.plateLayout.delete({ where: { id: layoutsOf(db, 'box')[0].id } });
    expect(await svc.run()).toEqual({ created: 0, skipped: 0, failed: 0 });
    expect(layoutsOf(db, 'box')).toHaveLength(0);
    // plated* values are left untouched (rollback-safe).
    expect(db.t('productComponent')[0]).toMatchObject({ platedUnits: 12, platedMinutes: 243, platedGrams: 112.8 });
  });

  it('a transient failure rolls the item back unmarked, counts it and moves on', async () => {
    const { db, svc } = setup([comp('a', { platedUnits: 12, platedMinutes: 243, platedGrams: 112.8 }), comp('b', { platedUnits: 10, platedMinutes: 100, platedGrams: 94 })]);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(db.plateLayoutSlot, 'create').mockRejectedValueOnce(new Error('timeout'));
    expect(await svc.run()).toEqual({ created: 1, skipped: 0, failed: 1 });
    expect(marked(db, 'a')).toBe(false);
    expect(layoutsOf(db, 'a')).toHaveLength(0);
    expect(await svc.run()).toEqual({ created: 1, skipped: 0, failed: 0 });
  });

  it('runs on boot through the lease runner and never rejects', async () => {
    const prisma: any = { $queryRaw: jest.fn(async () => { throw new Error('db down'); }), $executeRaw: jest.fn() };
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const svc = new PlateLayoutBackfillService(prisma);
    svc.onApplicationBootstrap();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('Backfill plate-layouts-v1 failed: db down'), expect.anything());
  });
});
