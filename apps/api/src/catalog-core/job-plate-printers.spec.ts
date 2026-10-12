import { BadRequestException } from '@nestjs/common';
import { boxConfig } from './__fixtures__/box-product';
import { resolveInConfig } from './bom-resolve';
import { assertOnePrinter, noGcodeOnFile, noPlateSlicedFor, suggestJobPlan, suggestJobPlates, type PrinterScope } from './job-plate-suggestion';
import { PlanError, type PlannedPlate, type PlannerLayout } from './plate-planner';
import { planFromBom } from './production-planner.service';

/**
 * v2.18.2: a plate sliced in the app belongs to the printer it was sliced for,
 * and a job has one printer. Found live: a part with "×3 · Hi" and "×6 · Ender"
 * was suggested "3 plates of ×6 + 1 plate of ×3" for a job on the Hi.
 */

const HI: PrinterScope = { id: 'pr-hi', name: 'Hi' };
const ENDER: PrinterScope = { id: 'pr-ender', name: 'Ender' };
const K1: PrinterScope = { id: 'pr-1', name: 'K1' };

const L = (units: number, minutes: number, file: string | null, printer: PrinterScope | null = null, id: string | null = `l${units}${printer?.name ?? ''}`): PlannerLayout => ({
  layoutId: id, label: `×${units}`, unitsPerPlate: units, plateMinutes: minutes, plateGrams: units * 5,
  slotGrams: new Map([[0, units * 5]]), attachmentId: file, gcodeFilename: file ? `${file}.gcode` : null,
  ...(printer ? { printerId: printer.id, printerName: printer.name } : {}),
});
const shape = (plates: ReadonlyArray<PlannedPlate>) => plates.map((p) => `${p.plateCount}×${p.layout.unitsPerPlate}${p.layout.printerName ? ` ${p.layout.printerName}` : ''}`);
const printersOf = (plates: ReadonlyArray<PlannedPlate>) => [...new Set(plates.map((p) => p.layout.printerId ?? null))];

/** The live case: ×3 sliced for the Hi (30 min), ×6 sliced for the Ender (54 min). */
const x3hi = L(3, 30, 'a3', HI);
const x6ender = L(6, 54, 'a6', ENDER);

describe('suggestJobPlates with printers', () => {
  it('a printer is given → only its plates: 20 on the Hi is 7 × ×3, never the Ender ×6', () => {
    const hi = suggestJobPlates(20, [x6ender, x3hi], undefined, { printer: HI });
    expect(shape(hi.plates)).toEqual(['7×3 Hi']);
    expect(hi.noFile).toBe(false);
    const ender = suggestJobPlates(20, [x6ender, x3hi], undefined, { printer: ENDER });
    expect(shape(ender.plates)).toEqual(['4×6 Ender']);
  });

  it('a printer is given → its plates and the printer-agnostic ones together', () => {
    const single = L(1, 5, 'a1', null, null);
    // 20 on the Hi: 6 × ×3 (240 min with changeovers) + 2 singles (30) beats 7 × ×3 (280).
    expect(shape(suggestJobPlates(20, [x6ender, x3hi, single], undefined, { printer: HI }).plates)).toEqual(['6×3 Hi', '2×1']);
    expect(printersOf(suggestJobPlates(20, [x6ender, x3hi, single], undefined, { printer: ENDER }).plates)).not.toContain(HI.id);
  });

  it('no printer given → never mixed: the best printer group wins (quickest, then fewest plates, then fewest extras)', () => {
    // Hi: 7 plates, 280 min with changeovers. Ender: 4 plates, 256 min.
    const out = suggestJobPlan([{ key: 'box', units: 20, layouts: [x6ender, x3hi] }]);
    expect(shape(out.parts.get('box')!.plates)).toEqual(['4×6 Ender']);
    expect(out.planPrinter).toEqual(ENDER);
    // 3 units: one ×3 on the Hi (40 min) beats one ×6 on the Ender (64 min).
    const small = suggestJobPlan([{ key: 'box', units: 3, layouts: [x6ender, x3hi] }]);
    expect(shape(small.parts.get('box')!.plates)).toEqual(['1×3 Hi']);
    expect(small.planPrinter).toEqual(HI);
    for (const n of [1, 2, 5, 7, 9, 13, 20, 45, 100]) {
      expect(printersOf(suggestJobPlates(n, [x6ender, x3hi]).plates)).toHaveLength(1);
    }
  });

  it('no printer given → one printer for every part of the job', () => {
    const lidHi = L(4, 40, 'b4', HI, 'lid4');
    const out = suggestJobPlan([
      { key: 'box', units: 20, layouts: [x6ender, x3hi] },
      { key: 'lid', units: 20, layouts: [lidHi] },
    ]);
    // The Ender has nothing for the lid, so the whole job is planned for the Hi.
    expect(out.planPrinter).toEqual(HI);
    expect(shape(out.parts.get('box')!.plates)).toEqual(['7×3 Hi']);
    expect(shape(out.parts.get('lid')!.plates)).toEqual(['5×4 Hi']);
  });

  it('equal plans → the printer-agnostic plates, and planPrinter is null', () => {
    const any6 = L(6, 54, 'a6any', null, 'any6');
    const out = suggestJobPlan([{ key: 'box', units: 12, layouts: [any6, L(6, 54, 'a6', ENDER)] }]);
    expect(out.parts.get('box')!.plates.map((p) => p.layout.layoutId)).toEqual(['any6']);
    expect(out.planPrinter).toBeNull();
  });

  it('the printer has no plate with a file → falls back to the printer-agnostic plates and names the printer', () => {
    const single = L(1, 34, null, null, null);
    const out = suggestJobPlates(5, [x6ender, single], undefined, { printer: HI });
    expect(shape(out.plates)).toEqual(['5×1']);
    expect(out.noFile).toBe(true);
    expect(out.missingFor).toEqual(HI);
    // A part no printer has a file for keeps the plain no-G-code case.
    const plain = suggestJobPlates(5, [single], undefined, { printer: HI });
    expect(plain.noFile).toBe(true);
    expect(plain.missingFor).toBeUndefined();
  });

  it('the printer has nothing at all for the part → no plates, blocked, the printer named; no layouts at all still throws', () => {
    const out = suggestJobPlates(5, [x6ender], undefined, { printer: HI });
    expect(out).toEqual({ plates: [], noFile: true, blocked: true, missingFor: HI });
    expect(() => suggestJobPlates(5, [], undefined, { printer: HI })).toThrow(PlanError);
  });

  it('the preferred (default) printer is used when it has a file for every part, else the best group', () => {
    expect(suggestJobPlan([{ key: 'box', units: 20, layouts: [x6ender, x3hi] }], { prefer: HI }).planPrinter).toEqual(HI);
    // The K1 has no plate here: the suggestion is as if no printer was preferred.
    const out = suggestJobPlan([{ key: 'box', units: 20, layouts: [x6ender, x3hi] }], { prefer: K1 });
    expect(out.planPrinter).toEqual(ENDER);
    expect(out.parts.get('box')!.missingFor).toBeUndefined();
  });

  it('layouts without a printer plan exactly as before, with or without a printer', () => {
    const layouts = [L(20, 300, 'a20'), L(1, 20, 'a1', null, null)];
    const before = suggestJobPlates(45, layouts);
    expect(shape(before.plates)).toEqual(['2×20', '5×1']);
    expect(before).toEqual({ plates: before.plates, noFile: false });
    expect(suggestJobPlates(45, layouts, undefined, { printer: HI })).toEqual(before);
    expect(suggestJobPlates(45, layouts, undefined, { prefer: HI })).toEqual(before);
    expect(suggestJobPlan([{ key: 'p', units: 45, layouts }]).planPrinter).toBeNull();
  });
});

describe('assertOnePrinter', () => {
  const plate = (layout: PlannerLayout, plateCount = 1): PlannedPlate => ({ layout, plateCount });

  it('a plate sliced for another printer than the job\'s → 400 naming the part, the plate and both printers', () => {
    expect(() => assertOnePrinter([{ description: 'Box', plates: [plate(x6ender, 4)] }], HI)).toThrow(BadRequestException);
    expect(() => assertOnePrinter([{ description: 'Box', plates: [plate(x6ender, 4)] }], HI)).toThrow('"Box": plate ×6 is sliced for Ender, not Hi');
    expect(assertOnePrinter([{ description: 'Box', plates: [plate(x3hi, 7)] }], HI)).toEqual(HI);
  });

  it('no printer and plates of two printers → 400, for one part or two', () => {
    const message = 'These plates are sliced for different printers (Ender and Hi). Choose one printer.';
    expect(() => assertOnePrinter([{ description: 'Box', plates: [plate(x3hi), plate(x6ender, 3)] }], null)).toThrow(message);
    expect(() => assertOnePrinter([{ description: 'Box', plates: [plate(x3hi)] }, { description: 'Lid', plates: [plate(x6ender)] }])).toThrow(message);
  });

  it('printer-agnostic plates fit any printer; one printer\'s plates with no printer chosen are fine', () => {
    const any = L(12, 243, 'a12');
    expect(assertOnePrinter([{ description: 'Box', plates: [plate(any)] }], HI)).toBeNull();
    expect(assertOnePrinter([{ description: 'Box', plates: [plate(any), plate(x6ender)] }], null)).toEqual(ENDER);
  });
});

describe('planFromBom with printers', () => {
  /** Box: own single unit (34 min, no file), ×3 sliced for the Hi, ×6 sliced for the Ender. */
  const config = (mutate?: (row: any) => void) => boxConfig({}, (row) => {
    const layout = (id: string, units: number, minutes: number, printer: PrinterScope, sortOrder: number) => ({
      id, componentId: 'box', name: `×${units}`, unitsPerPlate: units, plateMinutes: minutes, plateGrams: units * 9.4, colorChanges: 0,
      attachmentId: `a-${id}`, gcodeFilename: `${id}.gcode`, isActive: true, sortOrder, createdAt: new Date(0), updatedAt: new Date(0), slots: [],
      printerId: printer.id, printer: { id: printer.id, name: printer.name },
    });
    row.components[0].plateLayouts = [layout('box3', 3, 30, HI, 0), layout('box6', 6, 54, ENDER, 1)];
    mutate?.(row);
  });
  const plan = (input: Record<string, unknown>, mutate?: (row: any) => void) =>
    planFromBom(resolveInConfig(config(mutate), null, null), { quantity: 20, surplusPolicy: 'KEEP_FOR_STOCK', ...input }, new Map());
  const platesOf = (p: ReturnType<typeof plan>) => shape(p.components[0].plates);

  it('the resolver carries the printer of each layout; a layout without one has no printer keys', () => {
    const c = resolveInConfig(config(), null, null).components[0];
    expect(c.layouts.map((l) => [l.layoutId, l.printerId ?? null, l.printerName ?? null])).toEqual([
      ['box6', ENDER.id, 'Ender'], ['box3', HI.id, 'Hi'], [null, null, null],
    ]);
    const plain = resolveInConfig(boxConfig(), null, null).components[0];
    expect(plain.layouts.every((l) => !('printerId' in l) && !('printerName' in l))).toBe(true);
  });

  it('the same size sliced for two printers is kept once per printer', () => {
    const c = resolveInConfig(config((row) => {
      row.components[0].plateLayouts.push({
        ...row.components[0].plateLayouts[1], id: 'box6hi', attachmentId: 'a-box6hi', plateMinutes: 60, sortOrder: 2,
        printerId: HI.id, printer: { id: HI.id, name: HI.name },
      });
    }), null, null).components[0];
    expect(c.layouts.map((l) => l.layoutId)).toEqual(['box6', 'box6hi', 'box3', null]);
  });

  it('the job\'s printer → only its plates; planPrinter says which printer the plan is for', () => {
    const hi = plan({ printer: HI });
    expect(platesOf(hi)).toEqual(['7×3 Hi']);
    expect(hi.planPrinter).toEqual(HI);
    expect(hi.problems).toEqual([]);
    expect(platesOf(plan({ printer: ENDER }))).toEqual(['4×6 Ender']);
  });

  it('no printer → the best group, never mixed; the default printer is preferred only when it has the plates', () => {
    const none = plan({});
    expect(platesOf(none)).toEqual(['4×6 Ender']);
    expect(none.planPrinter).toEqual(ENDER);
    expect(plan({ preferPrinter: HI }).planPrinter).toEqual(HI);
    expect(plan({ preferPrinter: K1 }).planPrinter).toEqual(ENDER);
  });

  it('a printer with no plate for the part: the single unit without a file is planned, and the warning names the printer', () => {
    const k1 = plan({ printer: K1, quantity: 2 });
    expect(platesOf(k1)).toEqual(['2×1']);
    expect(k1.planPrinter).toBeNull();
    expect(k1.warnings).toContainEqual({ code: 'NO_GCODE_ON_FILE', componentId: 'box', message: 'No plate sliced for K1 for "Box"' });
    expect(noPlateSlicedFor('K1', 'Box')).toBe('No plate sliced for K1 for "Box"');
    expect(k1.warnings.some((w) => w.message === noGcodeOnFile('Box'))).toBe(false);
  });

  it('a printer with nothing it can print for the part → a blocking problem naming the printer, no plates', () => {
    // A ×1 layout sliced for the Ender: there is no printer-agnostic single unit left.
    const blocked = plan({ printer: K1, quantity: 2 }, (row) => {
      row.components[0].plateLayouts.push({
        ...row.components[0].plateLayouts[1], id: 'box1', unitsPerPlate: 1, plateMinutes: 30, plateGrams: 9.4, attachmentId: 'a-box1', sortOrder: 2,
      });
    });
    expect(blocked.components[0].plates).toEqual([]);
    expect(blocked.problems).toEqual([{ code: 'NO_PLATE_FOR_PRINTER', componentId: 'box', message: 'No plate sliced for K1 for "Box"' }]);
  });

  it('plates chosen by hand: another printer\'s plate → 400; two printers with no printer → 400', () => {
    const ender = [{ componentId: 'box', layoutId: 'box6', plateCount: 4 }];
    expect(() => plan({ printer: HI, plates: ender })).toThrow('"Box": plate ×6 is sliced for Ender, not Hi');
    expect(platesOf(plan({ printer: ENDER, plates: ender }))).toEqual(['4×6 Ender']);
    const mixed = [{ componentId: 'box', layoutId: 'box6', plateCount: 3 }, { componentId: 'box', layoutId: 'box3', plateCount: 1 }];
    expect(() => plan({ plates: mixed })).toThrow('These plates are sliced for different printers (Ender and Hi). Choose one printer.');
    expect(() => plan({ printer: null, plates: mixed })).toThrow(BadRequestException);
    // One printer's plates with no printer chosen are a valid plan for that printer.
    expect(plan({ plates: ender }).planPrinter).toEqual(ENDER);
  });

  it('plates chosen by hand for one part fix the printer of the parts that are suggested', () => {
    const twoParts = (row: any) => {
      const lid = structuredClone(row.components[0]);
      lid.id = 'lid'; lid.description = 'Lid'; lid.sortOrder = 1;
      lid.plateLayouts = lid.plateLayouts.map((l: any) => ({ ...l, id: `lid-${l.id}`, componentId: 'lid', attachmentId: `a-lid-${l.id}` }));
      row.components.push(lid);
    };
    // Suggested alone, both parts go on the Ender; the Box plates chosen for the Hi move the Lid there too.
    expect(plan({}, twoParts).components.map((c) => shape(c.plates))).toEqual([['4×6 Ender'], ['4×6 Ender']]);
    const p = plan({ plates: [{ componentId: 'box', layoutId: 'box3', plateCount: 7 }] }, twoParts);
    expect(p.components.map((c) => shape(c.plates))).toEqual([['7×3 Hi'], ['7×3 Hi']]);
    expect(p.planPrinter).toEqual(HI);
  });

  it('a product whose layouts have no printer plans the same with a printer, a preferred printer or neither', () => {
    const bom = () => resolveInConfig(boxConfig({}, (row) => {
      row.components[0].attachmentId = 'a-box';
      row.components[0].plateLayouts[0].attachmentId = 'a-box12';
    }), null, null);
    const strip = (p: ReturnType<typeof planFromBom>) => JSON.stringify({
      plates: p.components.map((c) => c.plates.map((x) => [x.layout.layoutId, x.plateCount, Object.keys(x.layout).sort()])),
      needs: p.filamentNeeds, minutes: p.totalMinutes, problems: p.problems, warnings: p.warnings, planPrinter: p.planPrinter,
    });
    const before = strip(planFromBom(bom(), { quantity: 13, surplusPolicy: 'KEEP_FOR_STOCK' }, new Map()));
    expect(JSON.parse(before).plates).toEqual([[['box12', 1, expect.not.arrayContaining(['printerId'])], [null, 1, expect.not.arrayContaining(['printerId'])]]]);
    expect(JSON.parse(before).planPrinter).toBeNull();
    for (const input of [{ printer: HI }, { printer: null }, { preferPrinter: K1 }]) {
      expect(strip(planFromBom(bom(), { quantity: 13, surplusPolicy: 'KEEP_FOR_STOCK', ...input }, new Map()))).toBe(before);
    }
  });
});
