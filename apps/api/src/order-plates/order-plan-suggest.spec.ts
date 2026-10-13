import { ORDER_PLAN_MAX_PLATES } from '@printforge/types';
import type { PlannerLayout } from '../catalog-core/plate-planner';
import { MIX_FILL_SHARE, suggestOrderPlates, type SuggestNeed, type SuggestPrinter } from './order-plan-suggest';

/**
 * The order plan suggestion (owner decisions 2026-10-13): projects alone on
 * their printer, existing plates for parts without a model, and models of one
 * filament sharing plates on the printer with the least to do.
 */

const K1: SuggestPrinter = { id: 'k1', name: 'K1', bed: { x: 220, y: 220 }, canSliceModels: true };
const HI: SuggestPrinter = { id: 'hi', name: 'Hi', bed: { x: 260, y: 260 }, canSliceModels: true };
const OLD: SuggestPrinter = { id: 'old', name: 'Old', bed: null, canSliceModels: false };

function need(id: string, o: Partial<SuggestNeed> = {}): SuggestNeed {
  return {
    rowKey: `line:${id}`, orderItemId: 'line', componentId: id, description: id, mode: 'MIX', units: 1, materialId: 'black', lockedPrinterId: null,
    capacity: null, footprint: { x: 50, y: 50 }, minutesPerUnit: 10, gramsPerUnit: 2, pricingPrinterId: null, layouts: [], ...o,
  };
}

const layout = (id: string | null, units: number, minutes: number, o: Partial<PlannerLayout> = {}): PlannerLayout =>
  ({ layoutId: id, label: `x${units}`, unitsPerPlate: units, plateMinutes: minutes, plateGrams: units * 2, slotGrams: new Map([[0, units * 2]]), attachmentId: `file-${id}`, ...o });

const units = (plates: ReturnType<typeof suggestOrderPlates>['plates'], rowKey: string) =>
  plates.reduce((s, p) => s + p.items.filter((i) => i.rowKey === rowKey).reduce((t, i) => t + i.units, 0) * p.plateCount, 0);

describe('projects', () => {
  it('print alone on their own printer, as many units per plate as one is known to hold', () => {
    const { plates } = suggestOrderPlates([need('face', { mode: 'PROJECT', units: 25, lockedPrinterId: 'hi', capacity: 12, materialId: null })], [K1, HI]);
    expect(plates.map((p) => [p.kind, p.printerId, p.items.map((i) => i.units)])).toEqual([
      ['PROJECT', 'hi', [12]], ['PROJECT', 'hi', [12]], ['PROJECT', 'hi', [1]],
    ]);
    expect(plates[0]).toMatchObject({ estMinutes: 120, estGrams: 24, plateCount: 1, layoutId: null });
  });

  it('unknown capacity: one plate asks for everything (the slicer says what fits), never more than 100', () => {
    const one = suggestOrderPlates([need('face', { mode: 'PROJECT', units: 30, lockedPrinterId: 'hi' })], [HI]).plates;
    expect(one.map((p) => p.items[0].units)).toEqual([30]);
    const many = suggestOrderPlates([need('face', { mode: 'PROJECT', units: 250, lockedPrinterId: 'hi' })], [HI]).plates;
    expect(many.map((p) => p.items[0].units)).toEqual([100, 100, 50]);
  });

  it('never shares a plate with another part and is never given a printer by guessing', () => {
    const { plates } = suggestOrderPlates([
      need('face', { mode: 'PROJECT', units: 2, lockedPrinterId: 'hi', capacity: 10 }),
      need('lost', { mode: 'PROJECT', units: 2, lockedPrinterId: null }),
      need('dress', { units: 2 }),
    ], [K1, HI]);
    expect(plates.filter((p) => p.kind === 'PROJECT')).toHaveLength(1);
    expect(plates.every((p) => p.kind !== 'MIXED' || p.items.every((i) => i.componentId === 'dress'))).toBe(true);
    expect(units(plates, 'line:lost')).toBe(0);
  });
});

describe('parts without a model', () => {
  it('use their existing plates as the job planner would, on the plate\'s printer', () => {
    const layouts = [layout('x20', 20, 300, { printerId: 'hi', printerName: 'Hi' }), layout(null, 1, 20, { printerId: 'hi', printerName: 'Hi' })];
    const { plates } = suggestOrderPlates([need('stand', { mode: 'LAYOUT', units: 45, layouts, materialId: null })], [K1, HI]);
    expect(plates.map((p) => [p.kind, p.printerId, p.layoutId, p.items[0].units, p.plateCount, p.estMinutes])).toEqual([
      ['LAYOUT', 'hi', 'x20', 20, 2, 300], ['LAYOUT', 'hi', null, 1, 5, 20],
    ]);
  });

  it('a plate that names no printer goes to the pricing printer, or to none', () => {
    const layouts = [layout('x10', 10, 100)];
    const priced = suggestOrderPlates([need('stand', { mode: 'LAYOUT', units: 10, layouts, pricingPrinterId: 'k1' })], [K1, HI]).plates;
    expect(priced[0].printerId).toBe('k1');
    const none = suggestOrderPlates([need('stand', { mode: 'LAYOUT', units: 10, layouts })], [K1, HI]).plates;
    expect(none[0].printerId).toBeNull();
  });

  it('no plate at all → a BLOCKED warning, no plate', () => {
    const { plates, warnings } = suggestOrderPlates([need('stand', { mode: 'LAYOUT', units: 3, layouts: [] })], [K1]);
    expect(plates).toEqual([]);
    expect(warnings).toEqual([expect.objectContaining({ code: 'BLOCKED', rowKey: 'line:stand' })]);
  });
});

describe('mixed plates', () => {
  it('parts of one filament share a plate; another filament gets its own', () => {
    const { plates } = suggestOrderPlates([
      need('dress', { units: 3 }), need('hat', { units: 2, footprint: { x: 30, y: 30 } }), need('shoe', { units: 4, materialId: 'white', footprint: { x: 20, y: 20 } }),
    ], [K1]);
    expect(plates).toHaveLength(2);
    expect(plates[0]).toMatchObject({ kind: 'MIXED', printerId: 'k1', items: [{ componentId: 'dress', units: 3 }, { componentId: 'hat', units: 2 }] });
    expect(plates[1].items).toEqual([expect.objectContaining({ componentId: 'shoe', units: 4 })]);
    expect(plates[0]).toMatchObject({ estMinutes: 50, estGrams: 10 });
  });

  it('fills a plate to 80 % of the bed by the parts\' boxes plus the 5 mm gap, largest first, then opens the next', () => {
    // 55 x 55 mm per unit on a 220 x 220 bed: floor(38720 / 3025) = 12 per plate.
    const { plates } = suggestOrderPlates([need('dress', { units: 30 })], [K1]);
    expect(plates.map((p) => p.items[0].units)).toEqual([12, 12, 6]);
    for (const p of plates) expect(p.items[0].units * 55 * 55).toBeLessThanOrEqual(220 * 220 * MIX_FILL_SHARE);
  });

  it('the largest footprint is placed first and a row\'s units stay together', () => {
    const { plates } = suggestOrderPlates([
      need('small', { units: 5, footprint: { x: 10, y: 10 } }), need('big', { units: 5, footprint: { x: 80, y: 80 } }),
    ], [K1]);
    expect(plates[0].items.map((i) => i.componentId)).toEqual(['big', 'small']);
    expect(plates.flatMap((p) => p.items).filter((i) => i.componentId === 'small')).toHaveLength(1);
  });

  it('each new plate goes to the printer with the least minutes so far; ties go to the pricing printer, then by name', () => {
    const tie = suggestOrderPlates([need('dress', { units: 12, pricingPrinterId: 'k1' })], [HI, K1]).plates;
    expect(tie[0].printerId).toBe('k1');
    const byName = suggestOrderPlates([need('dress', { units: 12 })], [K1, HI]).plates;
    expect(byName[0].printerId).toBe('hi');
    // 40 units: the plates alternate, so neither printer waits while the other works.
    const spread = suggestOrderPlates([need('dress', { units: 40, pricingPrinterId: 'k1' })], [K1, HI]).plates;
    expect(spread.map((p) => p.printerId)).toEqual(['k1', 'hi', 'k1']);
    expect(units(spread, 'line:dress')).toBe(40);
  });

  it('the project and layout plates already on a printer count as its load', () => {
    const { plates } = suggestOrderPlates([
      need('face', { mode: 'PROJECT', units: 5, lockedPrinterId: 'hi', capacity: 10, minutesPerUnit: 60, materialId: null }),
      need('dress', { units: 12, pricingPrinterId: 'hi' }),
    ], [K1, HI]);
    expect(plates.find((p) => p.kind === 'MIXED')!.printerId).toBe('k1');
  });

  it('only printers that can slice models are used; with none, a NO_PRINTER warning and no mixed plate', () => {
    expect(suggestOrderPlates([need('dress', { units: 2 })], [OLD, K1]).plates[0].printerId).toBe('k1');
    const none = suggestOrderPlates([need('dress', { units: 2 })], [OLD]);
    expect(none.plates).toEqual([]);
    expect(none.warnings).toEqual([expect.objectContaining({ code: 'NO_PRINTER' })]);
  });

  it('a part must fit the bed: it goes to the printer whose bed holds it, and one that fits none is reported', () => {
    const wide = need('wide', { units: 2, footprint: { x: 240, y: 100 } });
    const { plates } = suggestOrderPlates([wide], [K1, HI]);
    expect(plates.every((p) => p.printerId === 'hi')).toBe(true);
    const huge = suggestOrderPlates([need('huge', { units: 1, footprint: { x: 400, y: 400 } }), need('dress', { units: 1 })], [K1, HI]);
    expect(huge.warnings).toEqual([expect.objectContaining({ code: 'NO_PRINTER', rowKey: 'line:huge' })]);
    expect(units(huge.plates, 'line:dress')).toBe(1);
    expect(units(huge.plates, 'line:huge')).toBe(0);
  });

  it('a part that fits the bed but not the 80 % still gets a plate of its own, turned if it must be', () => {
    const { plates } = suggestOrderPlates([need('slab', { units: 2, footprint: { x: 210, y: 215 } })], [K1]);
    expect(plates.map((p) => p.items[0].units)).toEqual([1, 1]);
    expect(suggestOrderPlates([need('long', { units: 1, footprint: { x: 100, y: 219 } })], [K1]).plates).toHaveLength(1);
  });

  it('a part of unknown size is planned as 40 x 40 mm', () => {
    // 45 x 45 per unit: floor(38720 / 2025) = 19.
    const { plates } = suggestOrderPlates([need('blob', { units: 25, footprint: null })], [K1]);
    expect(plates.map((p) => p.items[0].units)).toEqual([19, 6]);
  });

  it('never more than 24 different parts on a plate, nor 500 units of one', () => {
    const many = Array.from({ length: 30 }, (_, i) => need(`p${String(i).padStart(2, '0')}`, { units: 1, footprint: { x: 5, y: 5 } }));
    const { plates } = suggestOrderPlates(many, [K1]);
    expect(plates.map((p) => p.items.length)).toEqual([24, 6]);
    const tiny = suggestOrderPlates([need('bead', { units: 900, footprint: { x: 1, y: 1 } })], [K1]).plates;
    expect(tiny.map((p) => p.items[0].units)).toEqual([500, 400]);
  });
});

describe('the whole plan', () => {
  it('covers every unit exactly once and skips needs with nothing left or that are blocked', () => {
    const needs = [
      need('dress', { units: 17 }), need('hat', { units: 9, footprint: { x: 30, y: 30 } }), need('shoe', { units: 40, materialId: 'white', footprint: { x: 20, y: 20 } }),
      need('done', { units: 0 }), need('stuck', { mode: 'BLOCKED', units: 5 }),
      need('face', { mode: 'PROJECT', units: 7, lockedPrinterId: 'hi', capacity: 4, materialId: null }),
    ];
    const { plates, warnings } = suggestOrderPlates(needs, [K1, HI]);
    for (const n of needs) expect(units(plates, n.rowKey)).toBe(n.mode === 'BLOCKED' ? 0 : n.units);
    expect(warnings).toEqual([]);
    expect(plates.every((p) => p.items.every((i) => i.units >= 1))).toBe(true);
  });

  it('is the same for the same input', () => {
    const needs = [need('dress', { units: 17 }), need('hat', { units: 9 })];
    expect(suggestOrderPlates(needs, [K1, HI])).toEqual(suggestOrderPlates(needs, [HI, K1]));
  });

  it('stops at the plan\'s plate limit and says so', () => {
    const { plates, warnings } = suggestOrderPlates([need('slab', { units: 500, footprint: { x: 200, y: 200 } })], [K1]);
    expect(plates).toHaveLength(ORDER_PLAN_MAX_PLATES);
    expect(warnings).toEqual([expect.objectContaining({ code: 'SHORT' })]);
  });
});
