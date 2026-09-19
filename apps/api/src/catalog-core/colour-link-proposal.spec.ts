import { decideImportLinks, proposeLinks, type LinkComponent } from './colour-link-proposal';
import { M, MATERIALS, sardineConfig, SLOT } from './__fixtures__/sardine-tin';
import type { ProductConfig } from './catalog-config';

const materials = new Map(Object.values(MATERIALS).map((m) => [m.id, { name: m.name, type: m.type }]));

function linkComponents(config: ProductConfig): LinkComponent[] {
  return config.components.map((c) => {
    const multi = c.materials.length > 0 && (c.isMultiColor || !c.materialId);
    return {
      id: c.id, description: c.description, variantId: c.variantId, sortOrder: c.sortOrder, createdAt: c.createdAt, isMultiColor: multi,
      slots: multi
        ? c.materials.map((m) => ({ colorIndex: m.colorIndex, materialId: m.materialId, colourSlotId: m.colourSlotId, colourFixed: m.colourFixed }))
        : [{ colorIndex: 0, materialId: c.materialId!, colourSlotId: c.colourSlotId, colourFixed: c.colourFixed }],
    };
  });
}

/** Sardine tin with only the Regular components, all unlinked and no slots (the §3.6.2 start). */
const unlinkedRegular = () =>
  sardineConfig((r) => {
    r.components = r.components.filter((c: any) => c.variantId === null);
    r.colourSlots = [];
    for (const c of r.components) {
      c.colourSlotId = null; c.colourFixed = null;
      for (const m of c.materials) { m.colourSlotId = null; m.colourFixed = null; }
    }
  });

describe('C5 link proposal (link by filament)', () => {
  it('Sardine fixture, all unlinked: PLA Black → Box 0, Lid 0, Band 0; PLA Silver → Lid 1, Key 0; Fixed → Fish 0, Fish 1, Band 1', () => {
    const config = unlinkedRegular();
    const p = proposeLinks({ components: linkComponents(config), colourSlots: [], materials });
    expect(p.newSlots).toEqual([{ ref: 'new-1', name: 'PLA Black' }, { ref: 'new-2', name: 'PLA Silver' }]);
    const by = (pred: (l: any) => boolean) => p.links.filter(pred).map((l) => `${l.componentId}:${l.colorIndex}`).sort();
    expect(by((l) => l.ref === 'new-1')).toEqual(['c1:0', 'c2:0', 'c5:0']);
    expect(by((l) => l.ref === 'new-2')).toEqual(['c2:1', 'c4:0']);
    expect(by((l) => l.fixed)).toEqual(['c3:0', 'c3:1', 'c5:1']);
  });

  it('never proposes a change to an already-decided slot; reuses an existing slot of the same name', () => {
    const config = unlinkedRegular();
    const comps = linkComponents(config);
    comps[0].slots[0].colourSlotId = 'slot-x'; // Box decided
    const p = proposeLinks({ components: comps, colourSlots: [{ id: 'slot-x', name: 'pla black' }], materials });
    expect(p.links.find((l) => l.componentId === 'c1')).toBeUndefined();
    expect(p.links.filter((l) => l.colourSlotId === 'slot-x').map((l) => l.componentId).sort()).toEqual(['c2', 'c5']);
  });

  it('proposes Fixed when every decided slot with that filament is Fixed', () => {
    const config = unlinkedRegular();
    const comps = linkComponents(config);
    comps[0].slots[0].colourFixed = true; // Box Black fixed
    const p = proposeLinks({ components: comps, colourSlots: [], materials });
    expect(p.links.filter((l) => l.fixed).map((l) => `${l.componentId}:${l.colorIndex}`)).toEqual(expect.arrayContaining(['c2:0', 'c5:0']));
  });

  it('over the 12-slot cap → 400', () => {
    const slots = Array.from({ length: 11 }, (_, i) => ({ id: `s${i}`, name: `Slot ${i}` }));
    expect(() => proposeLinks({ components: linkComponents(unlinkedRegular()), colourSlots: slots, materials }))
      .toThrow('Link by filament would need 13 colour slots (maximum 12) — link some parts by hand first');
  });
});

describe('import link rule (§3.12)', () => {
  const regular = sardineConfig((r) => { r.components = r.components.filter((c: any) => c.variantId === null); });
  const existing = linkComponents(regular);
  const colourSlots = regular.colourSlots;
  const large = { id: 'v-large', name: 'Large' };
  const slot = (componentKey: string, description: string, rank: number, colorIndex: number, materialId: string, isMultiColor: boolean) =>
    ({ componentKey, description, rank, colorIndex, materialId, materialType: 'PLA', isMultiColor });

  it('the Sardine Large import: position for Tin, filament for Trim, Fixed for the fish', () => {
    const { decisions, warnings } = decideImportLinks({
      newSlots: [
        slot('n6', 'Large Box', 0, 0, M.black, false),
        slot('n7', 'Large Lid', 1, 0, M.black, true),
        slot('n7', 'Large Lid', 1, 1, M.silver, true),
        slot('n8', 'Large Fish', 2, 0, M.white, true),
        slot('n8', 'Large Fish', 2, 1, M.orange, true),
        slot('n9', 'Large Key', 3, 0, M.silver, false),
      ],
      existing, colourSlots, materials, targetSize: large, standardSizeLabel: 'Regular',
    });
    expect(decisions.map((d) => [d.componentKey, d.colorIndex, d.colourSlotId, d.colourFixed, d.how])).toEqual([
      ['n6', 0, SLOT.tin, null, 'POSITION'],
      ['n7', 0, SLOT.tin, null, 'POSITION'],
      ['n7', 1, SLOT.trim, null, 'FILAMENT'],
      ['n8', 0, null, true, 'FILAMENT'],
      ['n8', 1, null, true, 'FILAMENT'],
      ['n9', 0, SLOT.trim, null, 'FILAMENT'],
    ]);
    expect(warnings).toEqual([{ code: 'COLOUR_LINKED_BY_POSITION', message: '2 parts linked by position (Large Box → Tin, Large Lid colour 1 → Tin) — check them in Edit links' }]);
  });

  it('a filament linked only to Tin links by filament; no positional match and a split filament stays unlinked', () => {
    const onlyTin = existing.map((c) => ({ ...c, slots: c.slots.map((s) => (s.materialId === M.black && c.id === 'c5' ? { ...s, materialId: M.grey } : s)) }));
    const r1 = decideImportLinks({ newSlots: [slot('n', 'Extra', 0, 0, M.black, false)], existing: onlyTin, colourSlots, materials, targetSize: null, standardSizeLabel: 'Regular' });
    expect(r1.decisions[0]).toMatchObject({ colourSlotId: SLOT.tin, how: 'FILAMENT' });
    const r2 = decideImportLinks({ newSlots: [slot('n', 'Ribbon', 9, 0, M.black, false)], existing, colourSlots, materials, targetSize: large, standardSizeLabel: 'Regular' });
    expect(r2.decisions[0]).toMatchObject({ colourSlotId: null, colourFixed: null, how: 'NONE' });
    expect(r2.warnings[0]).toEqual({
      code: 'COLOUR_SLOT_NOT_LINKED',
      message: `"Ribbon" colour 1 (PLA Black) isn't linked to a colour slot — colours won't change it and won't be offered on Large in the shop; link it in Edit links`,
    });
  });

  it('a product without colour slots leaves everything unlinked, silently', () => {
    const r = decideImportLinks({ newSlots: [slot('n', 'Box', 0, 0, M.black, false)], existing, colourSlots: [], materials, targetSize: null, standardSizeLabel: 'Standard' });
    expect(r).toEqual({ decisions: [{ componentKey: 'n', colorIndex: 0, colourSlotId: null, colourFixed: null, how: 'NONE' }], warnings: [] });
  });
});
