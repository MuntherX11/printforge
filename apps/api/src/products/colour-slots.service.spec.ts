import { boxRow } from '../catalog-core/__fixtures__/box-product';
import { fixtureMaterial, M, OPT, PRODUCT_ID, sardineRow, SLOT } from '../catalog-core/__fixtures__/sardine-tin';
import { parseSlotPatch } from './product-input';
import { addOrderLine, productsHarness, statusOf } from './__fixtures__/products-harness';

const P = PRODUCT_ID;
const comp = (h: any, id: string) => h.db.t('productComponent').find((c: any) => c.id === id);
const cm = (h: any, id: string, i: number) => h.db.t('componentMaterial').find((m: any) => m.componentId === id && m.colorIndex === i);

function allUnlinked() {
  const row = sardineRow();
  for (const c of row.components) {
    c.colourSlotId = null;
    c.colourFixed = null;
    for (const m of c.materials) { m.colourSlotId = null; m.colourFixed = null; }
  }
  return row;
}

describe('ColourSlotsService (§7.1 items 26, 35)', () => {
  describe('C1/C2', () => {
    it('C1: a duplicate name ignoring case → 409; the 13th slot → 400', async () => {
      const h = productsHarness([sardineRow()]);
      await expect(h.slots.create(P, { name: 'tin' })).rejects.toThrow('A colour slot named "tin" already exists');
      for (let i = 0; i < 9; i++) await h.slots.create(P, { name: `Slot ${i}` });
      await expect(h.slots.create(P, { name: 'One more' })).rejects.toThrow('A product can have at most 12 colour slots');
      expect(h.db.t('productColourSlot')).toHaveLength(12);
      const s = h.db.t('productColourSlot').find((x: any) => x.name === 'Slot 0');
      expect(s.sortOrder).toBe(3);
    });

    it('C2: renaming to an existing name → 409; sortOrder is bounded 0–1000', async () => {
      const h = productsHarness([sardineRow()]);
      await expect(h.slots.update(P, SLOT.trim, { name: 'TIN' })).rejects.toThrow('A colour slot named "TIN" already exists');
      await expect(h.slots.update(P, SLOT.trim, { sortOrder: 1001 })).rejects.toThrow('sortOrder');
      expect(() => parseSlotPatch({ sortOrder: -1 })).toThrow('sortOrder');
      expect(await h.slots.update(P, SLOT.trim, { name: 'Accent', sortOrder: 1000 })).toEqual({ id: SLOT.trim, name: 'Accent', sortOrder: 1000 });
      expect(await statusOf(h.slots.update(P, 'nope', { name: 'x' }))).toBe(404);
    });
  });

  describe('C3 delete', () => {
    it('marks every link Fixed and deletes assignments in one transaction; no reprice, no stock move', async () => {
      const h = productsHarness([sardineRow()]);
      comp(h, 'c4').stockOnHand = 6;
      const spy = jest.spyOn(h.pricing, 'recalcPricing');
      const priceBefore = h.db.t('product')[0].basePrice;
      const out: any = await h.slots.remove(P, SLOT.trim, false, false);
      expect(out).toMatchObject({ deleted: true, fixed: 4, assignmentsRemoved: 1, impact: [] });
      expect(comp(h, 'c4')).toMatchObject({ colourSlotId: null, colourFixed: true, stockOnHand: 6 });
      expect(cm(h, 'c2', 1)).toMatchObject({ colourSlotId: null, colourFixed: true });
      expect(cm(h, 'c7', 1)).toMatchObject({ colourSlotId: null, colourFixed: true });
      expect(h.db.t('colourOptionSlot').some((r: any) => r.colourSlotId === SLOT.trim)).toBe(false);
      expect(h.db.t('productColourSlot').some((s: any) => s.id === SLOT.trim)).toBe(false);
      expect(spy).not.toHaveBeenCalled();
      expect(h.db.t('product')[0].basePrice).toBe(priceBefore);
      expect(h.db.t('componentStockMovement')).toHaveLength(0);
    });

    it('?dryRun=1 writes nothing and lists links, assignments and the open-line impact; confirm is then required', async () => {
      const h = productsHarness([sardineRow()]);
      addOrderLine(h.db, { productId: P, colourOptionId: OPT.blue, quantity: 12, description: 'Sardine tin — Blue' });
      const before = JSON.stringify(h.db.tables());
      const dry: any = await h.slots.remove(P, SLOT.trim, true, false);
      expect(JSON.stringify(h.db.tables())).toBe(before);
      expect(dry.links.map((l: any) => [l.componentId, l.colorIndex]).sort()).toEqual([['c2', 1], ['c4', 0], ['c7', 1], ['c9', 0]]);
      expect(dry.assignments).toEqual([{ colourOptionId: OPT.blue, name: 'Blue', materialId: M.white, materialName: 'PLA White' }]);
      expect(dry.impact).toHaveLength(1);
      expect(dry.impact[0].changes).toEqual(['Trim: PLA White → PLA Silver on Lid, Key']);
      await expect(h.slots.remove(P, SLOT.trim, false, false)).rejects.toThrow('This change affects 1 open order or quote lines');
      expect(JSON.stringify(h.db.tables())).toBe(before);
      const out: any = await h.slots.remove(P, SLOT.trim, false, true);
      expect(out.warnings.map((w: any) => w.code)).toEqual(['OPEN_LINES_AFFECTED']);
    });
  });

  describe('C4 links', () => {
    it('validation: another product\'s component → 404; bad colour indexes, foreign slots and duplicates → 400', async () => {
      const h = productsHarness([sardineRow(), boxRow()]);
      expect(await statusOf(h.slots.saveLinks(P, { links: [{ componentId: 'box', colorIndex: 0, fixed: true }] }, false))).toBe(404);
      await expect(h.slots.saveLinks(P, { links: [{ componentId: 'c1', colorIndex: 1, fixed: true }] }, false)).rejects.toThrow('"Box" has no colour 2');
      await expect(h.slots.saveLinks(P, { links: [{ componentId: 'c2', colorIndex: 5, fixed: true }] }, false)).rejects.toThrow('"Lid" has no colour 6');
      await expect(h.slots.saveLinks(P, { links: [{ componentId: 'c1', colorIndex: 0, colourSlotId: 'slot-body' }] }, false)).rejects.toThrow('Unknown colour slot');
      await expect(h.slots.saveLinks(P, { links: [{ componentId: 'c1', colorIndex: 0, fixed: true }, { componentId: 'c1', colorIndex: 0, colourSlotId: SLOT.tin }] }, false))
        .rejects.toThrow('listed twice');
    });

    it('links on a size\'s components are accepted; SLOT_STANDARD_MIXED is returned when a slot\'s own filaments differ', async () => {
      const row = sardineRow();
      const lbox = row.components.find((c: any) => c.id === 'c6');
      Object.assign(lbox, { materialId: M.grey, material: fixtureMaterial(M.grey), colourSlotId: null });
      const h = productsHarness([row]);
      const out: any = await h.slots.saveLinks(P, { links: [{ componentId: 'c6', colorIndex: 0, colourSlotId: SLOT.tin }] }, false);
      expect(comp(h, 'c6').colourSlotId).toBe(SLOT.tin);
      expect(out.components.map((c: any) => c.id)).toEqual(['c6']);
      expect(out.warnings.map((w: any) => w.code)).toContain('SLOT_STANDARD_MIXED');
    });

    it('batch: creates by ref, renames by id, fixed and unlinked, all in one transaction', async () => {
      const h = productsHarness([sardineRow()]);
      const out: any = await h.slots.saveLinks(P, {
        slots: [{ ref: 'n1', name: 'Band white' }, { id: SLOT.trim, name: 'Accent' }],
        links: [
          { componentId: 'c5', colorIndex: 1, slotRef: 'n1' },
          { componentId: 'c4', colorIndex: 0, fixed: true },
          { componentId: 'c1', colorIndex: 0, colourSlotId: null },
        ],
      }, false);
      const created = h.db.t('productColourSlot').find((s: any) => s.name === 'Band white');
      expect(cm(h, 'c5', 1)).toMatchObject({ colourSlotId: created.id, colourFixed: null });
      expect(comp(h, 'c4')).toMatchObject({ colourSlotId: null, colourFixed: true });
      expect(comp(h, 'c1')).toMatchObject({ colourSlotId: null, colourFixed: null });
      expect(out.slots.map((s: any) => s.name)).toEqual(['Tin', 'Accent', 'Band', 'Band white']);
      expect(out.components.map((c: any) => c.id).sort()).toEqual(['c1', 'c4', 'c5']);
    });

    it('batch: a 13th slot → 400 with nothing written', async () => {
      const h = productsHarness([sardineRow()]);
      const before = JSON.stringify(h.db.tables());
      const slots = Array.from({ length: 10 }, (_, i) => ({ ref: `r${i}`, name: `New ${i}` }));
      await expect(h.slots.saveLinks(P, { slots, links: [{ componentId: 'c1', colorIndex: 0, slotRef: 'r0' }] }, false)).rejects.toThrow('A product can have at most 12 colour slots');
      expect(JSON.stringify(h.db.tables())).toBe(before);
    });

    it('open-line impact: no confirm → 400 and nothing written; dryRun → impact; confirm → written', async () => {
      const h = productsHarness([sardineRow()]);
      addOrderLine(h.db, { productId: P, sizeOptionId: OPT.large, colourOptionId: OPT.red, quantity: 30, description: 'Sardine tin — Large — Red' });
      const body = { links: [{ componentId: 'c6', colorIndex: 0, fixed: true }] };
      const before = JSON.stringify(h.db.tables());
      const dry: any = await h.slots.saveLinks(P, body, true);
      expect(dry.impact[0].changes).toEqual(['Tin: PLA Red → PLA Black on Large Box']);
      expect(JSON.stringify(h.db.tables())).toBe(before);
      await expect(h.slots.saveLinks(P, body, false)).rejects.toThrow('review them and confirm');
      expect(JSON.stringify(h.db.tables())).toBe(before);
      const out: any = await h.slots.saveLinks(P, { ...body, confirm: true }, false);
      expect(out.warnings.map((w: any) => w.code)).toContain('OPEN_LINES_AFFECTED');
      expect(comp(h, 'c6').colourFixed).toBe(true);
    });
  });

  describe('C5 proposal', () => {
    it('Sardine with every slot unlinked: PLA Black and PLA Silver slots, fish and band white Fixed; nothing written', async () => {
      const h = productsHarness([allUnlinked()]);
      const before = JSON.stringify(h.db.tables());
      const p = await h.slots.proposal(P);
      expect(JSON.stringify(h.db.tables())).toBe(before);
      expect(p.newSlots).toEqual([{ ref: 'new-1', name: 'PLA Black' }, { ref: 'new-2', name: 'PLA Silver' }]);
      const to = (ref: string | null, fixed = false) => p.links.filter((l) => l.slotRef === ref && l.fixed === fixed).map((l) => `${l.componentId}:${l.colorIndex}`).sort();
      expect(to('new-1')).toEqual(expect.arrayContaining(['c1:0', 'c2:0', 'c5:0']));
      expect(to('new-2')).toEqual(expect.arrayContaining(['c2:1', 'c4:0']));
      expect(to(null, true)).toEqual(expect.arrayContaining(['c3:0', 'c3:1', 'c5:1']));
      expect(p.links.every((l) => l.colourSlotId === null)).toBe(true);
    });

    it('already-decided slots are never proposed; over the cap → 400', async () => {
      const h = productsHarness([sardineRow()]);
      expect((await h.slots.proposal(P)).links).toEqual([]);
      const row = allUnlinked();
      for (let i = 0; i < 9; i++) row.colourSlots.push({ id: `x${i}`, productId: P, name: `X${i}`, sortOrder: 10 + i });
      await expect(productsHarness([row]).slots.proposal(P)).rejects.toThrow('Link by filament would need 14 colour slots (maximum 12) — link some parts by hand first');
    });
  });
});
