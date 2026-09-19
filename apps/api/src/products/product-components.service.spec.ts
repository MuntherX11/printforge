import { fixtureMaterial, M, OPT, PRODUCT_ID, sardineRow, SLOT } from '../catalog-core/__fixtures__/sardine-tin';
import { linkAfter } from './product-components.service';
import { addOrderLine, productsHarness, statusOf } from './__fixtures__/products-harness';

const P = PRODUCT_ID;
const comp = (h: any, id: string) => h.db.t('productComponent').find((c: any) => c.id === id);

/** P10/P11 confirmation (§7.1 item 35), P11 and P12 details. */
describe('ProductComponentsService', () => {
  const withOpenLine = () => {
    const h = productsHarness([sardineRow()]);
    h.db.insert('material', fixtureMaterial(M.grey));
    addOrderLine(h.db, { productId: P, quantity: 4, description: 'Sardine tin' });
    return h;
  };

  it('linkAfter: a link clears Fixed, Fixed clears the link, null without fixed = unlinked', () => {
    const cur = { colourSlotId: 's1', colourFixed: null };
    expect(linkAfter(cur, {})).toBeNull();
    expect(linkAfter(cur, { colourFixed: true })).toEqual({ colourSlotId: null, colourFixed: true });
    expect(linkAfter({ colourSlotId: null, colourFixed: true }, { colourSlotId: 's2' })).toEqual({ colourSlotId: 's2', colourFixed: null });
    expect(linkAfter(cur, { colourSlotId: null })).toEqual({ colourSlotId: null, colourFixed: null });
  });

  it('P10 with a non-empty impact: no confirm → 400 and nothing written; dryRun → impact; confirm → written', async () => {
    const h = withOpenLine();
    const before = JSON.stringify(h.db.tables());
    const dry: any = await h.components.update(P, 'c1', { materialId: M.grey }, true);
    expect(dry).toEqual({ impact: [expect.objectContaining({ kind: 'ORDER', quantity: 4, changes: ['Tin: PLA Black → PLA Grey on Box'] })] });
    expect(JSON.stringify(h.db.tables())).toBe(before);
    await expect(h.components.update(P, 'c1', { materialId: M.grey })).rejects.toThrow('This change affects 1 open order or quote lines — review them and confirm');
    expect(JSON.stringify(h.db.tables())).toBe(before);
    const out: any = await h.components.update(P, 'c1', { materialId: M.grey, confirm: true });
    expect(out.warnings.map((w: any) => w.code)).toContain('OPEN_LINES_AFFECTED');
    expect(comp(h, 'c1').materialId).toBe(M.grey);
  });

  it('P10 on the alias route resolves the product from the component', async () => {
    const h = productsHarness([sardineRow()]);
    const out: any = await h.components.update(null, 'c4', { description: 'Key ring' });
    expect(out.description).toBe('Key ring');
    expect(await statusOf(h.components.update(null, 'nope', { description: 'x' }))).toBe(404);
  });

  it('P11 with a non-empty impact needs confirm; writes slots and links; reprices only on a filament change', async () => {
    const h = withOpenLine();
    const body = { slots: [{ colorIndex: 1, materialId: M.grey }] };
    const before = JSON.stringify(h.db.tables());
    expect(((await h.components.setMaterials(P, 'c2', body, true)) as any).impact).toHaveLength(1);
    await expect(h.components.setMaterials(P, 'c2', body)).rejects.toThrow('review them and confirm');
    expect(JSON.stringify(h.db.tables())).toBe(before);
    const spy = jest.spyOn(h.pricing, 'recalcPricing');
    const out: any = await h.components.setMaterials(P, 'c2', { ...body, confirm: true });
    expect(out.materials.find((m: any) => m.colorIndex === 1).materialId).toBe(M.grey);
    expect(out.warnings.map((w: any) => w.code)).toContain('OPEN_LINES_AFFECTED');
    expect(spy).toHaveBeenCalledTimes(1);
    await h.components.setMaterials(P, 'c3', { slots: [{ colorIndex: 0, materialId: M.white, colourSlotId: SLOT.band }] });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(h.db.t('componentMaterial').find((m: any) => m.componentId === 'c3' && m.colorIndex === 0)).toMatchObject({ colourSlotId: SLOT.band, colourFixed: null });
  });

  it('P11: a colour the component lacks → 400; an unknown material → 404; a foreign slot → 400', async () => {
    const h = productsHarness([sardineRow()]);
    await expect(h.components.setMaterials(P, 'c2', { slots: [{ colorIndex: 4, materialId: M.black }] })).rejects.toThrow('"Lid" has no colour 5');
    expect(await statusOf(h.components.setMaterials(P, 'c2', { slots: [{ colorIndex: 0, materialId: 'm-nope' }] }))).toBe(404);
    await expect(h.components.setMaterials(P, 'c2', { slots: [{ colorIndex: 0, materialId: M.black, colourSlotId: 'slot-x' }] })).rejects.toThrow('Unknown colour slot');
  });

  it('P12: must list exactly that size\'s components; a stale variantId → 400', async () => {
    const h = productsHarness([sardineRow()]);
    await expect(h.components.reorder(P, { variantId: OPT.large, componentIds: [] })).rejects.toThrow('This page is out of date — reload it');
    await expect(h.components.reorder(P, { sizeOptionId: OPT.large, componentIds: ['c6', 'c7'] })).rejects.toThrow('exactly the components');
    expect(await h.components.reorder(P, { sizeOptionId: OPT.large, componentIds: ['c9', 'c8', 'c7', 'c6'] })).toEqual({ ok: true });
    expect(['c6', 'c7', 'c8', 'c9'].map((id) => comp(h, id).sortOrder)).toEqual([3, 2, 1, 0]);
    await expect(h.components.reorder(P, { sizeOptionId: OPT.red, componentIds: [] })).rejects.toThrow("Colours use each size's components");
  });
});
