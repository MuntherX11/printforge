import { BomResolverService } from './bom-resolver.service';
import { OpenLinesImpactService } from './open-lines-impact.service';
import { ProductionPlannerService } from './production-planner.service';
import { plannerPrisma, type FakeOrder, type FakeQuote } from './__fixtures__/planner-prisma';
import { key, M, MATERIALS, OPT, PRODUCT_ID, sardineRow, SLOT } from './__fixtures__/sardine-tin';

const line = (id: string, sizeOptionId: string | null, colourOptionId: string | null, quantity: number, description: string) =>
  ({ id, productId: PRODUCT_ID, sizeOptionId, colourOptionId, quantity, description });

function setup() {
  const orders: FakeOrder[] = [
    { id: 'o107', orderNumber: 'ORD-0107', status: 'CONFIRMED', items: [line('oi-107', OPT.large, OPT.red, 30, 'Sardine tin — Large — Red')] },
    { id: 'o110', orderNumber: 'ORD-0110', status: 'CONFIRMED', items: [line('oi-110', null, OPT.blue, 12, 'Sardine tin — Blue')] },
    { id: 'o111', orderNumber: 'ORD-0111', status: 'IN_PRODUCTION', items: [line('oi-111', null, null, 4, 'Sardine tin')] },
    { id: 'o090', orderNumber: 'ORD-0090', status: 'COMPLETED', items: [line('oi-090', OPT.large, OPT.red, 5, 'Sardine tin — Large — Red')] },
  ];
  const quotes: FakeQuote[] = [
    { id: 'q31', quoteNumber: 'Q-0031', status: 'DRAFT', items: [line('qi-31', null, OPT.red, 8, 'Sardine tin — Red')] },
    { id: 'q12', quoteNumber: 'Q-0012', status: 'ACCEPTED', items: [line('qi-12', null, OPT.red, 8, 'Sardine tin — Red')] },
  ];
  const prisma = plannerPrisma({
    rows: [sardineRow()],
    orders,
    quotes,
    movements: [{ orderItemId: 'oi-107', componentId: 'c6', colourKey: key([0, M.red]), delta: -2, reason: 'PLAN_ALLOCATE' }],
    materials: [MATERIALS[M.crimson], MATERIALS[M.grey]],
  });
  const resolver = new BomResolverService(prisma);
  return new OpenLinesImpactService(prisma, resolver, new ProductionPlannerService(prisma, resolver));
}

describe('OpenLinesImpactService (§3.3 "Changes that affect sold lines")', () => {
  it('O5 Red Tin → PLA Crimson lists ORD-0107 (partly planned) and the DRAFT quote; not the COMPLETED order, not Blue', async () => {
    const impact = await setup().compute(PRODUCT_ID, {
      kind: 'ASSIGNMENTS', colourOptionId: OPT.red,
      assignments: [{ colourSlotId: SLOT.tin, materialId: M.crimson }, { colourSlotId: SLOT.band, materialId: M.gold }],
    });
    expect(impact.map((i) => [i.kind, i.number])).toEqual([['ORDER', 'ORD-0107'], ['QUOTE', 'Q-0031']]);
    expect(impact[0]).toMatchObject({ changes: ['Tin: PLA Red → PLA Crimson on Large Box, Large Lid'], partlyPlanned: true, quantity: 30 });
    expect(impact[1]).toMatchObject({ changes: ['Tin: PLA Red → PLA Crimson on Box, Lid'], partlyPlanned: false });
  });

  it('a change that alters no resolution → empty impact', async () => {
    const impact = await setup().compute(PRODUCT_ID, {
      kind: 'ASSIGNMENTS', colourOptionId: OPT.red,
      assignments: [{ colourSlotId: SLOT.tin, materialId: M.red }, { colourSlotId: SLOT.band, materialId: M.gold }],
    });
    expect(impact).toEqual([]);
  });

  it('C3 of Trim lists the (Regular, Blue) line: Trim PLA White → PLA Silver', async () => {
    const impact = await setup().compute(PRODUCT_ID, { kind: 'SLOT_DELETE', colourSlotId: SLOT.trim });
    const blue = impact.find((i) => i.number === 'ORD-0110')!;
    expect(blue.changes).toEqual(['Trim: PLA White → PLA Silver on Lid, Key']);
    expect(impact.find((i) => i.number === 'ORD-0107')).toBeUndefined(); // Red has no Trim row
  });

  it('P10 on Box\'s own material lists the standard-colour lines of Regular', async () => {
    const impact = await setup().compute(PRODUCT_ID, { kind: 'COMPONENT_MATERIAL', componentId: 'c1', materialId: M.grey });
    expect(impact.map((i) => i.number)).toEqual(['ORD-0111']);
    expect(impact[0].changes).toEqual(['Tin: PLA Black → PLA Grey on Box']);
  });

  it('C4 unlinking Large Lid colour 1 changes what (Large, Red) prints', async () => {
    const impact = await setup().compute(PRODUCT_ID, { kind: 'LINKS', links: [{ componentId: 'c7', colorIndex: 0, colourSlotId: null, fixed: true }] });
    expect(impact.map((i) => [i.number, i.changes])).toEqual([['ORD-0107', ['Tin: PLA Red → PLA Black on Large Lid']]]);
  });

  it('O5 exclusions list the lines of a newly excluded pair without blocking them', async () => {
    const impact = await setup().compute(PRODUCT_ID, { kind: 'EXCLUSIONS', colourOptionId: OPT.red, excludedSizeKeys: [OPT.large] });
    expect(impact.map((i) => [i.number, i.changes])).toEqual([['ORD-0107', [`Red won't be made in Large any more`]]]);
  });
});
