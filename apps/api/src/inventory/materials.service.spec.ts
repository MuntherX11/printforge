import { fixtureMaterial, M, sardineRow } from '../catalog-core/__fixtures__/sardine-tin';
import { fakeCatalogDb, seedProduct } from '../products/__fixtures__/fake-catalog-db';
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

