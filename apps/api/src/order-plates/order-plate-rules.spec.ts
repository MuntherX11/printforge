import type { PlannerLayout } from '../catalog-core/plate-planner';
import { needModeOf, type NeedFacts } from './order-need-mode';
import type { PlanNeed, PlanPrinter, PlateJob, PlateRow } from './order-plate-model';
import { checkPlate, type PlateDraftInput } from './order-plate-rules';
import { planWarnings, plannedUnits, plateFileName, plateLabel, printerTotals, toPlateDto } from './order-plate-view';

/** How a part can be printed, what a plate may hold, and what the plan says about it. */

// ---------------------------------------------------------------- modes

const facts = (o: Partial<NeedFacts> = {}): NeedFacts => ({
  description: 'dress', pendingFirstSlice: false, isMultiColor: false,
  source: { kind: 'STL', projectSlots: 0, printerModel: null }, projectPrinter: null,
  filaments: [{ slot: 0, materialId: 'black', name: 'PLA Black', type: 'PLA', hasPreset: true }], layoutCount: 0, ...o,
});
const hi = { id: 'hi', name: 'Hi', hasMachine: true };
const twoSlots = [
  { slot: 0, materialId: 'white', name: 'PLA White', type: 'PLA', hasPreset: true },
  { slot: 1, materialId: 'orange', name: 'Silk Orange', type: 'PLA', hasPreset: true },
];

describe('needModeOf', () => {
  it('an STL with one filament can share a plate', () => {
    expect(needModeOf(facts())).toEqual({ mode: 'MIX', blockedReason: null, canOwnSettings: false, lockedPrinterId: null });
  });

  it('a one-slot project can share a plate, and can print alone where its project says', () => {
    const source = { kind: 'THREEMF' as const, projectSlots: 1, printerModel: 'Creality Hi' };
    expect(needModeOf(facts({ source, projectPrinter: hi }))).toMatchObject({ mode: 'MIX', canOwnSettings: true, lockedPrinterId: null });
    expect(needModeOf(facts({ source, projectPrinter: null }))).toMatchObject({ mode: 'MIX', canOwnSettings: false });
    expect(needModeOf(facts({ source, projectPrinter: { ...hi, hasMachine: false } }))).toMatchObject({ mode: 'MIX', canOwnSettings: false });
  });

  it('a project with two slots, or of a multi-colour part, is locked to its printer', () => {
    const source = { kind: 'THREEMF' as const, projectSlots: 2, printerModel: 'Creality Hi' };
    expect(needModeOf(facts({ source, projectPrinter: hi, filaments: twoSlots, isMultiColor: true }))).toEqual({ mode: 'PROJECT', blockedReason: null, canOwnSettings: false, lockedPrinterId: 'hi' });
    expect(needModeOf(facts({ source: { ...source, projectSlots: 1 }, projectPrinter: hi, filaments: twoSlots, isMultiColor: true })).mode).toBe('PROJECT');
  });

  it('no model: its plates, or blocked when it has none', () => {
    expect(needModeOf(facts({ source: null, layoutCount: 2 }))).toMatchObject({ mode: 'LAYOUT', blockedReason: null });
    expect(needModeOf(facts({ source: null }))).toMatchObject({ mode: 'BLOCKED', blockedReason: '"dress" has no model and no plate file — add one on the product page' });
  });

  it('blocked with a sentence that says what to do', () => {
    const project = { kind: 'THREEMF' as const, projectSlots: 2, printerModel: 'Bambu X1' };
    const reasons = [
      needModeOf(facts({ pendingFirstSlice: true })),
      needModeOf(facts({ source: project, filaments: twoSlots })),
      needModeOf(facts({ source: { ...project, printerModel: null }, filaments: twoSlots })),
      needModeOf(facts({ source: project, projectPrinter: { ...hi, hasMachine: false }, filaments: twoSlots })),
      needModeOf(facts({ source: project, projectPrinter: hi, filaments: [twoSlots[0], { ...twoSlots[1], materialId: null }] })),
      needModeOf(facts({ filaments: [{ slot: 0, materialId: 'black', name: 'PLA Black', type: 'PLA', hasPreset: false }] })),
      needModeOf(facts({ filaments: [] })),
      needModeOf(facts({ isMultiColor: true, filaments: twoSlots })),
    ];
    expect(reasons.every((r) => r.mode === 'BLOCKED' && r.lockedPrinterId === null && !r.canOwnSettings)).toBe(true);
    expect(reasons.map((r) => r.blockedReason)).toEqual([
      '"dress" has not been sliced yet — slice one unit on the product page first',
      'The project of "dress" is set up for "Bambu X1", which matches none of your printers',
      'The project of "dress" does not name a printer',
      'Hi has no machine profile — import one in Settings › Slicer',
      '"dress": colour 2 has no filament',
      '"PLA Black" has no slicer preset, and there is no main preset for PLA — set one in Settings › Slicer',
      '"dress" has no filament set',
      '"dress" prints in several colours, but its model is a single shape — upload its project (.3mf) on the product page',
    ]);
  });
});

// ---------------------------------------------------------------- rules

const layout = (id: string | null, units: number, o: Partial<PlannerLayout> = {}): PlannerLayout =>
  ({ layoutId: id, label: `x${units}`, unitsPerPlate: units, plateMinutes: units * 9, plateGrams: units * 3, slotGrams: new Map(), attachmentId: 'file', gcodeFilename: 'f.gcode', ...o });

function need(id: string, o: Partial<PlanNeed> = {}): PlanNeed {
  return {
    rowKey: `l:${id}`, orderItemId: 'l', componentId: id, productId: 'p', productName: 'Doll', componentDescription: id, optionLabel: '', colourLabel: 'Black',
    toProduce: 10, planned: 0, open: 10, mode: 'MIX', materialId: 'black', materialName: 'PLA Black', canOwnSettings: false, layouts: [], lockedPrinterId: null,
    blockedReason: null, minutesPerUnit: 10, gramsPerUnit: 2, footprint: { x: 20, y: 20 }, source: { attachmentId: 'a', storagePath: 's.stl', kind: 'STL' },
    filaments: [{ slot: 0, materialId: 'black', name: 'PLA Black', type: 'PLA', colorHex: '#111111' }], projectPrinterId: null, pricingPrinterId: 'k1',
    plannerLayouts: [], capacity: null, ...o,
  };
}
const K1: PlanPrinter = { id: 'k1', name: 'K1', bed: { x: 220, y: 220 }, canSliceModels: true, hasMachine: true };
const HI: PlanPrinter = { id: 'hi', name: 'Hi', bed: { x: 260, y: 260 }, canSliceModels: true, hasMachine: true };
const OLD: PlanPrinter = { id: 'old', name: 'Old', bed: null, canSliceModels: false, hasMachine: false };
const printers = new Map([K1, HI, OLD].map((p) => [p.id, p]));
const face = need('face', {
  mode: 'PROJECT', lockedPrinterId: 'hi', projectPrinterId: 'hi', materialId: null, materialName: null,
  filaments: [{ slot: 0, materialId: 'white', name: 'PLA White', type: 'PLA', colorHex: null }, { slot: 1, materialId: 'orange', name: 'Silk Orange', type: 'PLA', colorHex: null }],
});
const needs = new Map([
  need('dress'), need('hat'), need('shoe', { materialId: 'white', materialName: 'PLA White' }), face,
  need('badge', { canOwnSettings: true, projectPrinterId: 'hi', source: { attachmentId: 'b', storagePath: 'b.3mf', kind: 'THREEMF' } }),
  need('stand', { mode: 'LAYOUT', source: null, plannerLayouts: [layout('x10', 10), layout('hi5', 5, { printerId: 'hi', printerName: 'Hi' })] }),
  need('stuck', { mode: 'BLOCKED', blockedReason: '"stuck" has not been sliced yet — slice one unit on the product page first' }),
].map((n) => [n.rowKey, n]));

const check = (input: Partial<PlateDraftInput> & { items: PlateDraftInput['items'] }) => checkPlate({ kind: 'MIXED', layoutId: null, ...input }, needs, printers);
const refused = (input: Parameters<typeof check>[0], message: string) => {
  let err: any;
  try { check(input); } catch (e) { err = e; }
  expect(err?.getStatus?.()).toBe(400);
  expect(err.message).toBe(message);
};

describe('checkPlate — MIXED', () => {
  it('parts of one filament on a printer that can slice models', () => {
    expect(check({ printerId: 'k1', items: [{ rowKey: 'l:dress', units: 4 }, { rowKey: 'l:hat', units: 2 }] })).toMatchObject({
      kind: 'MIXED', printerId: 'k1', plateCount: 1, layoutId: null, layout: null, estMinutes: 60, estGrams: 12,
      filamentMap: { '0': { materialId: 'black', name: 'PLA Black', type: 'PLA' } },
      items: [
        { rowKey: 'l:dress', orderItemId: 'l', componentId: 'dress', units: 4, unitsSliced: null, minutes: null, grams: null },
        { rowKey: 'l:hat', units: 2 },
      ],
    });
    // A one-slot project gives its shape to a mixed plate like an STL does.
    expect(check({ printerId: 'k1', items: [{ rowKey: 'l:badge', units: 1 }] }).kind).toBe('MIXED');
  });

  it('hard limit: a multi-colour project never shares a plate', () => {
    refused({ printerId: 'hi', items: [{ rowKey: 'l:dress', units: 1 }, { rowKey: 'l:face', units: 1 }] }, '"face" is a multi-colour project — it prints alone on its own plate');
    refused({ printerId: 'hi', items: [{ rowKey: 'l:face', units: 1 }] }, '"face" is a multi-colour project — it prints alone on its own plate');
  });

  it('one filament, a printer that can slice, parts that have a model and are in the plan', () => {
    refused({ printerId: 'k1', items: [{ rowKey: 'l:dress', units: 1 }, { rowKey: 'l:shoe', units: 1 }] }, '"shoe" prints in PLA White, not PLA Black — a plate holds one filament');
    refused({ items: [{ rowKey: 'l:dress', units: 1 }] }, 'Choose a printer for this plate');
    refused({ printerId: 'gone', items: [{ rowKey: 'l:dress', units: 1 }] }, 'That printer is not active');
    refused({ printerId: 'old', items: [{ rowKey: 'l:dress', units: 1 }] }, 'Old cannot slice models yet — it needs a machine profile and a default process in Settings › Slicer');
    refused({ printerId: 'k1', items: [{ rowKey: 'l:stand', units: 1 }] }, '"stand" has no model to slice — use one of its existing files instead');
    refused({ printerId: 'k1', items: [{ rowKey: 'l:stuck', units: 1 }] }, '"stuck" has not been sliced yet — slice one unit on the product page first');
    refused({ printerId: 'k1', items: [{ rowKey: 'l:nope', units: 1 }] }, 'A part on this plate is no longer in the order — take the part off the plate or delete the plate');
  });
});

describe('checkPlate — PROJECT', () => {
  it('hard limit: the project\'s printer, whatever was asked for', () => {
    expect(check({ kind: 'PROJECT', items: [{ rowKey: 'l:face', units: 6 }] })).toMatchObject({
      kind: 'PROJECT', printerId: 'hi', estMinutes: 60, estGrams: 12,
      filamentMap: { '0': { materialId: 'white' }, '1': { materialId: 'orange' } }, items: [{ rowKey: 'l:face', units: 6 }],
    });
    expect(check({ kind: 'PROJECT', printerId: 'hi', items: [{ rowKey: 'l:face', units: 1 }] }).printerId).toBe('hi');
    refused({ kind: 'PROJECT', printerId: 'k1', items: [{ rowKey: 'l:face', units: 1 }] }, '"face" prints with its project\'s own settings, on Hi only');
  });

  it('a one-slot project can print alone with its own settings, on its project\'s printer', () => {
    expect(check({ kind: 'PROJECT', items: [{ rowKey: 'l:badge', units: 3 }] })).toMatchObject({ kind: 'PROJECT', printerId: 'hi', filamentMap: { '0': { materialId: 'black' } } });
  });

  it('exactly one part, and one that has a project', () => {
    refused({ kind: 'PROJECT', items: [{ rowKey: 'l:face', units: 1 }, { rowKey: 'l:badge', units: 1 }] }, 'A project plate holds exactly one part');
    refused({ kind: 'PROJECT', items: [{ rowKey: 'l:dress', units: 1 }] }, '"dress" has no project of its own to print from');
  });
});

describe('checkPlate — LAYOUT', () => {
  it('one of the part\'s plates, printed several times; the file decides the units', () => {
    const d = check({ kind: 'LAYOUT', layoutId: 'x10', plateCount: 3, items: [{ rowKey: 'l:stand', units: 999 }] });
    expect(d).toMatchObject({ kind: 'LAYOUT', layoutId: 'x10', plateCount: 3, printerId: 'k1', estMinutes: 90, estGrams: 30, items: [{ units: 10, unitsSliced: 10 }] });
    expect(d.layout?.unitsPerPlate).toBe(10);
  });

  it('the printer: the plate\'s own, else the one asked for, else the pricing printer; "no printer" stays none', () => {
    expect(check({ kind: 'LAYOUT', layoutId: 'hi5', items: [{ rowKey: 'l:stand', units: 1 }] }).printerId).toBe('hi');
    expect(check({ kind: 'LAYOUT', layoutId: 'x10', printerId: 'hi', items: [{ rowKey: 'l:stand', units: 1 }] }).printerId).toBe('hi');
    expect(check({ kind: 'LAYOUT', layoutId: 'x10', printerId: null, items: [{ rowKey: 'l:stand', units: 1 }] }).printerId).toBeNull();
    refused({ kind: 'LAYOUT', layoutId: 'hi5', printerId: 'k1', items: [{ rowKey: 'l:stand', units: 1 }] }, 'That plate of "stand" is sliced for Hi — it prints there only');
    refused({ kind: 'LAYOUT', layoutId: 'x10', printerId: 'gone', items: [{ rowKey: 'l:stand', units: 1 }] }, 'That printer is not active');
  });

  it('a plate that is not the part\'s, or more than one part', () => {
    refused({ kind: 'LAYOUT', layoutId: 'other', items: [{ rowKey: 'l:stand', units: 1 }] }, 'That plate is not one of the plates of "stand" any more — reload the page');
    refused({ kind: 'LAYOUT', layoutId: null, items: [{ rowKey: 'l:stand', units: 1 }] }, '"stand" has no single-unit file — choose one of its plates');
    refused({ kind: 'LAYOUT', layoutId: 'x10', items: [{ rowKey: 'l:stand', units: 1 }, { rowKey: 'l:dress', units: 1 }] }, 'A plate from an existing file holds exactly one part');
  });
});

// ----------------------------------------------------------------- view

function plate(id: string, o: Partial<PlateRow> = {}): PlateRow {
  return {
    id, orderId: 'o', kind: 'MIXED', status: 'DRAFT', printerId: 'k1', printerName: 'K1', sortOrder: 0, items: [], filamentMap: { '0': { materialId: 'black', name: 'PLA Black', type: 'PLA' } },
    layoutId: null, plateCount: 1, estMinutes: 0, estGrams: 0, minutes: null, grams: null, colorChanges: 0, attachmentId: null, gcodeFilename: null,
    preview: null, error: null, errorDetail: null, createdAt: new Date(0), ...o,
  };
}
const it3 = (part: string, units: number, unitsSliced: number | null = null) =>
  ({ rowKey: `l:${part}`, orderItemId: 'l', componentId: part, units, unitsSliced, minutes: null, grams: null });
const job = (id: string, plateId: string, part: string, units: number, status = 'QUEUED'): PlateJob =>
  ({ id, status, orderPlateId: plateId, orderItemId: 'l', componentId: part, quantityToProduce: units });

describe('labels and file names', () => {
  it('"Plate N · Printer", and a file name in plain letters that no other plate will ever have', () => {
    expect(plateLabel(2, 'Ender')).toBe('Plate 3 · Ender');
    expect(plateLabel(0, null)).toBe('Plate 1');
    expect(plateFileName('ORD-0042', 'Plate 3 · Ender', 'clx9k2f0a000108l4a1b2c')).toBe('ORD-0042 Plate 3 Ender a1b2c.gcode');
    expect(plateFileName('ORD/1"', 'Plate 1 · K1 — Böx\r\n', 'orderPlate-7')).toBe('ORD 1 Plate 1 K1 B x late7.gcode');
    expect(plateFileName('', '', '')).toBe('plate.gcode');
    // The number can come back (delete the last plate, add another): the name cannot.
    expect(plateFileName('ORD-1', 'Plate 3 · K1', 'aaaaa11111')).not.toBe(plateFileName('ORD-1', 'Plate 3 · K1', 'aaaaa22222'));
    expect(plateFileName('ORD-1', 'Plate 3 · K1', 'Ünï-cödé-ÄB12')).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('coverage', () => {
  it('an unlocked plate counts what it holds (what was placed, once sliced); a locked one only what its live jobs stand for', () => {
    const plates = [
      plate('a', { items: [it3('dress', 6), it3('hat', 2)] }),
      plate('b', { status: 'DONE', items: [it3('dress', 15, 12)] }),
      plate('c', { kind: 'LAYOUT', status: 'DONE', plateCount: 3, items: [it3('stand', 10, 10)] }),
      plate('d', { status: 'DONE', items: [it3('dress', 5, 5), it3('hat', 4, 4)] }),
    ];
    const jobs = [job('j1', 'd', 'dress', 5), job('j2', 'd', 'hat', 4, 'FAILED')];
    const live = new Map([['l:dress', 5]]);
    expect([...plannedUnits(plates, jobs, live)].sort()).toEqual([['l:dress', 23], ['l:hat', 2], ['l:stand', 30]]);
  });

  it('warns in plain sentences: blocked, too full, short, over, no printer, slicer down', () => {
    const view = {
      needs: [
        need('dress', { toProduce: 15, planned: 12 }), need('hat', { toProduce: 2, planned: 5, optionLabel: 'Large' }), need('shoe', { toProduce: 1, planned: 1 }),
        needs.get('l:stuck')!,
      ],
      printers: [K1, HI, OLD], jobs: [] as PlateJob[],
    };
    const plates = [
      plate('a', { sortOrder: 1, status: 'DONE', items: [it3('dress', 15, 12), it3('hat', 5, 5)] }),
      plate('b', { sortOrder: 2, printerId: 'old', printerName: 'Old', items: [it3('shoe', 1)] }),
    ];
    expect(planWarnings(plates, view, false)).toEqual([
      { code: 'SLICER_DOWN', message: 'The slicer is not running — plates cannot be sliced right now' },
      { code: 'BLOCKED', rowKey: 'l:stuck', message: '"stuck" has not been sliced yet — slice one unit on the product page first' },
      { code: 'PLATE_TOO_FULL', plateId: 'a', rowKey: 'l:dress', message: 'Plate 2 · K1 holds 12 of 15 dress — 3 still need a plate' },
      { code: 'NO_PRINTER', plateId: 'b', message: 'Plate 3 · Old has no printer that can slice it — choose another printer' },
      { code: 'SHORT', rowKey: 'l:dress', message: 'dress: 3 of 15 still need a plate' },
      { code: 'OVER', rowKey: 'l:hat', message: 'hat (Large): the plates hold 5, the order needs 2' },
    ]);
    expect(planWarnings([], { ...view, needs: [need('shoe', { toProduce: 1, planned: 1, open: 0 })] }, true)).toEqual([]);
  });

  it('what a suggestion cannot place is said on every read, while it is short: a part larger than every bed, a part with no usable plate', () => {
    const huge = need('huge', { toProduce: 2, planned: 0, footprint: { x: 400, y: 400 } });
    const bare = need('bare', { mode: 'LAYOUT', toProduce: 3, planned: 0, source: null, plannerLayouts: [] });
    const view = { needs: [huge, bare], printers: [K1, HI], jobs: [] as PlateJob[] };
    expect(planWarnings([], view, true)).toEqual([
      { code: 'SHORT', rowKey: 'l:huge', message: 'huge: 2 of 2 still need a plate' },
      { code: 'SHORT', rowKey: 'l:bare', message: 'bare: 3 of 3 still need a plate' },
      { code: 'BLOCKED', rowKey: 'l:bare', message: '"bare" has no plate that can be used — slice it or upload a file for it' },
      { code: 'NO_PRINTER', rowKey: 'l:huge', message: '"huge" is larger than the bed of every printer that can slice models' },
    ]);
    // Covered (put on a plate by hand): nothing more to say.
    expect(planWarnings([], { ...view, needs: [{ ...huge, planned: 2 }] }, true)).toEqual([]);
  });

  it('a plan that is full says so while something is short; a plate holding a removed part says what to do', () => {
    const view = { needs: [need('dress', { toProduce: 5, planned: 1 })], printers: [K1], jobs: [job('j', 'locked', 'gone', 1)] };
    const full = Array.from({ length: 200 }, (_, i) => plate(`p${i}`, { sortOrder: i, status: 'DONE', items: [] }));
    expect(planWarnings(full, view, true).map((w) => w.message)).toContain('The plan stops at 200 plates — create jobs for these first, then prepare the rest');
    const stale = [plate('a', { items: [it3('gone', 2)] }), plate('locked', { sortOrder: 1, items: [it3('gone', 1)] })];
    expect(planWarnings(stale, view, true).filter((w) => w.code === 'BLOCKED')).toEqual([
      { code: 'BLOCKED', plateId: 'a', message: 'Plate 1 · K1 holds a part that is no longer in this order — take the part off the plate or delete the plate' },
    ]);
  });
});

describe('toPlateDto', () => {
  const view = { needs: [...needs.values()], printers: [K1, HI, OLD], jobs: [job('j1', 'p', 'dress', 4), job('j0', 'p', 'hat', 1, 'CANCELLED')] };

  it('names the parts, sketches a draft on its printer\'s bed and says what locks it', () => {
    const dto = toPlateDto(plate('p', { sortOrder: 4, estMinutes: 40, items: [it3('dress', 4), it3('gone', 1)] }), view);
    expect(dto).toMatchObject({
      id: 'p', label: 'Plate 5 · K1', kind: 'MIXED', status: 'DRAFT', hasFile: false, locked: true, jobIds: ['j1'], estMinutes: 40, minutes: null,
      filaments: [{ slot: 0, materialId: 'black', name: 'PLA Black', type: 'PLA', colorHex: '#111111' }],
      items: [
        { rowKey: 'l:dress', productName: 'Doll', componentDescription: 'dress', optionLabel: '', units: 4, unitsSliced: null },
        { rowKey: 'l:gone', productName: '', componentDescription: 'Removed part' },
      ],
    });
    expect(dto.preview).toMatchObject({ exact: false, bed: { x: 220, y: 220 }, overflow: 0 });
    expect(dto.preview!.objects.filter((o) => o.rowKey === 'l:dress')).toHaveLength(4);
  });

  it('shows the slicer\'s own drawing once there is one, and no drawing without a bed', () => {
    const exact = { bed: { x: 220, y: 220 }, exact: true, objects: [], overflow: 0 };
    expect(toPlateDto(plate('q', { status: 'DONE', preview: exact, attachmentId: 'f', gcodeFilename: 'x.gcode', minutes: 50, grams: 9 }), view))
      .toMatchObject({ preview: exact, hasFile: true, gcodeFilename: 'x.gcode', minutes: 50, grams: 9, locked: false, jobIds: [] });
    expect(toPlateDto(plate('r', { printerId: 'old', printerName: 'Old', items: [it3('dress', 1)] }), view).preview).toBeNull();
  });

  it('printer totals: plates and minutes (sliced numbers where known), times the plate count', () => {
    const dtos = [
      toPlateDto(plate('a', { estMinutes: 100 }), view),
      toPlateDto(plate('b', { estMinutes: 100, minutes: 80, status: 'DONE' }), view),
      toPlateDto(plate('c', { kind: 'LAYOUT', printerId: 'hi', printerName: 'Hi', minutes: 30, plateCount: 3, status: 'DONE' }), view),
    ];
    expect(printerTotals(dtos, [K1, HI, OLD])).toEqual([
      { id: 'k1', name: 'K1', canSliceModels: true, plates: 2, minutes: 180 },
      { id: 'hi', name: 'Hi', canSliceModels: true, plates: 3, minutes: 90 },
      { id: 'old', name: 'Old', canSliceModels: false, plates: 0, minutes: 0 },
    ]);
  });

  it('a plate whose jobs are all finished, failed or cancelled is no work left for its printer', () => {
    const dtos = [toPlateDto(plate('a', { estMinutes: 100 }), view), toPlateDto(plate('b', { estMinutes: 60 }), view), toPlateDto(plate('c', { estMinutes: 30 }), view)];
    const jobs = [job('1', 'a', 'dress', 1, 'COMPLETED'), job('2', 'a', 'hat', 1, 'FAILED'), job('3', 'b', 'dress', 1, 'COMPLETED'), job('4', 'b', 'hat', 1, 'IN_PROGRESS')];
    expect(printerTotals(dtos, [K1], jobs)).toEqual([{ id: 'k1', name: 'K1', canSliceModels: true, plates: 2, minutes: 90 }]);
  });

  it('a plate that prints one of the part\'s plate files shows the file that plate has now', () => {
    const stand = need('stand', { mode: 'LAYOUT', source: null, plannerLayouts: [layout('x10', 10, { attachmentId: 'new-file', gcodeFilename: 'stand v2.gcode' }), layout('bare', 5, { attachmentId: null, gcodeFilename: null })] });
    const v = { needs: [stand], printers: [K1], jobs: [] as PlateJob[] };
    const base = { kind: 'LAYOUT' as const, status: 'DONE' as const, attachmentId: 'old-file', gcodeFilename: 'stand v1.gcode', items: [it3('stand', 10, 10)] };
    expect(toPlateDto(plate('a', { ...base, layoutId: 'x10' }), v)).toMatchObject({ hasFile: true, gcodeFilename: 'stand v2.gcode' });
    expect(toPlateDto(plate('b', { ...base, layoutId: 'bare' }), v)).toMatchObject({ hasFile: false, gcodeFilename: null });
  });
});
