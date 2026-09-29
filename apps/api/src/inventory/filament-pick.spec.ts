import {
  DEFAULT_FILAMENT_LIST_STATE,
  MaterialType,
  componentDryRunRequests,
  componentWriteRequests,
  filamentInStock,
  filamentPickWrite,
  filamentQueryMatcher,
  filterFilaments,
  rankFilamentChoices,
  writeResultMessage,
  type ComponentWrite,
  type FilamentStockRow,
  type FilamentStockSpool,
  type Problem,
  type SlotFilamentState,
} from '@printforge/types';

// ---------------------------------------------------------------- fixtures

let spoolSeq = 0;
function spool(printforgeId: string | null, extra: Partial<FilamentStockSpool> = {}): FilamentStockSpool {
  spoolSeq += 1;
  return {
    id: `s-${spoolSeq}`,
    printforgeId,
    currentWeight: 640,
    isActive: true,
    locationName: null,
    ...extra,
  };
}

function row(id: string, extra: Partial<FilamentStockRow> = {}): FilamentStockRow {
  return {
    id,
    name: `Filament ${id}`,
    type: MaterialType.PLA,
    color: null,
    colorHex: null,
    brand: null,
    costPerGram: 0.02,
    spoolPrice: 20,
    spoolWeightGrams: 1000,
    reorderPoint: 500,
    createdAt: '2026-01-01T00:00:00.000Z',
    totalStock: 1000,
    activeSpools: 1,
    stockStatus: 'ok',
    spools: [],
    ...extra,
  };
}

const esunBeige = row('esun-beige', { name: 'eSUN PLA Beige', color: 'Beige', brand: 'eSUN', colorHex: 'F5F5DC' });
const plaBeige = row('pla-beige', { name: 'PLA Beige', color: 'Beige', brand: null, totalStock: 0, activeSpools: 0, costPerGram: 0 });
const polyBlack = row('poly-black', {
  name: 'Polymaker PLA Black',
  color: 'Black',
  brand: 'Polymaker',
  spools: [
    spool('PF-A7X2', { locationName: 'Shelf B' }),
    spool('PF-OLD9', { isActive: false, locationName: 'Attic' }),
  ],
});
const petgRed = row('petg-red', { name: 'eSUN PETG Red', type: MaterialType.PETG, color: 'Red', brand: 'eSUN', colorHex: '91202B' });
const catalog = [esunBeige, plaBeige, polyBlack, petgRed];

const matched = (q: string, rows: FilamentStockRow[] = catalog) => rows.filter(filamentQueryMatcher(q)).map((r) => r.id);

// ---------------------------------------------------------------- filamentQueryMatcher

describe('filamentQueryMatcher', () => {
  it('an empty or whitespace-only query matches every row', () => {
    expect(matched('')).toEqual(catalog.map((r) => r.id));
    expect(matched('   ')).toEqual(catalog.map((r) => r.id));
  });

  it('ANDs the tokens: "beige esun" needs both words', () => {
    expect(matched('beige esun')).toEqual(['esun-beige']);
    expect(matched('beige')).toEqual(['esun-beige', 'pla-beige']);
  });

  it('ignores case and extra spaces', () => {
    expect(matched('  BEIGE    eSuN ')).toEqual(['esun-beige']);
  });

  it('matches a colour hex with or without "#"', () => {
    expect(matched('#f5f5dc')).toEqual(['esun-beige']);
    expect(matched('F5F5DC')).toEqual(['esun-beige']);
  });

  it('matches a spool PF-ID prefix', () => {
    expect(matched('pf-a7')).toEqual(['poly-black']);
  });

  it('matches the location of active spools only', () => {
    expect(matched('shelf')).toEqual(['poly-black']);
    expect(matched('attic')).toEqual([]);
  });

  it('cuts a query longer than 100 characters to 100, like the Filaments list', () => {
    // 'beige' + 95 spaces is exactly 100 characters, so 'zzzz' is cut off (with 94, a lone 'z' survives and matches nothing).
    expect(matched(`beige${' '.repeat(95)}zzzz`)).toEqual(['esun-beige', 'pla-beige']);
    expect(matched(`beige${' '.repeat(94)}zzzz`)).toEqual([]);
  });

  it.each(['', 'pla', '#f5f5dc', 'pf-a7', 'esun red', 'shelf b black'])('accepts exactly the rows filterFilaments lists for %p', (q) => {
    const first = filterFilaments(catalog, { ...DEFAULT_FILAMENT_LIST_STATE, q });
    const listed: string[] = [];
    for (let page = 1; page <= first.totalPages; page++) {
      listed.push(...filterFilaments(catalog, { ...DEFAULT_FILAMENT_LIST_STATE, q, page }).pageRows.map((r) => r.id));
    }
    expect([...matched(q)].sort()).toEqual([...listed].sort());
  });
});

// ---------------------------------------------------------------- rankFilamentChoices

describe('rankFilamentChoices', () => {
  const plaOut = row('pla-out', { name: 'apple PLA', totalStock: 0 });
  const plaIn = row('pla-in', { name: 'Zebra PLA', totalStock: 250 });
  const plaIn2 = row('pla-in-2', { name: 'banana PLA', totalStock: 10 });
  const petgIn = row('petg-in', { name: 'Aardvark PETG', type: MaterialType.PETG, totalStock: 900 });
  const petgOut = row('petg-out', { name: 'Aaa PETG', type: MaterialType.PETG, totalStock: -5 });
  const mixed = [plaOut, petgIn, plaIn, petgOut, plaIn2];
  const order = (rows: FilamentStockRow[], preferType: string | null, q = '', currentMaterialId: string | null = null) =>
    rankFilamentChoices(rows, { q, preferType, currentMaterialId }).map((c) => c.row.id);

  it('orders same type first, then in stock, then name A–Z ignoring case', () => {
    expect(order(mixed, 'PLA')).toEqual(['pla-in-2', 'pla-in', 'pla-out', 'petg-in', 'petg-out']);
    expect(order(mixed, 'PETG')).toEqual(['petg-in', 'petg-out', 'pla-in-2', 'pla-in', 'pla-out']);
  });

  it('breaks a name tie on id', () => {
    const a = row('b-id', { name: 'Same' });
    const b = row('a-id', { name: 'same' });
    expect(order([a, b], null)).toEqual(['a-id', 'b-id']);
  });

  it('without a preferred type: in stock first, then name', () => {
    expect(order(mixed, null)).toEqual(['petg-in', 'pla-in-2', 'pla-in', 'petg-out', 'pla-out']);
    expect(order(mixed, '  ')).toEqual(['petg-in', 'pla-in-2', 'pla-in', 'petg-out', 'pla-out']);
  });

  it('matches the preferred type case-insensitively', () => {
    expect(order(mixed, 'pla')).toEqual(order(mixed, 'PLA'));
    expect(rankFilamentChoices(mixed, { q: '', preferType: ' pla ', currentMaterialId: null })[0].sameType).toBe(true);
  });

  it('a preferred type no row has gives the plain in-stock / name order', () => {
    expect(order(mixed, 'TPU')).toEqual(order(mixed, null));
  });

  it('counts only grams above zero as in stock, whatever stockStatus says', () => {
    const zeroOk = row('zero-ok', { totalStock: 0, reorderPoint: 0, stockStatus: 'ok' });
    const [choice] = rankFilamentChoices([zeroOk], { q: '', preferType: null, currentMaterialId: null });
    expect(choice.inStock).toBe(false);
    expect(filamentInStock({ totalStock: 0 })).toBe(false);
    expect(filamentInStock({ totalStock: 0.4 })).toBe(true);
    expect(filamentInStock({ totalStock: Number.NaN })).toBe(false);
    expect(filamentInStock({ totalStock: Number.POSITIVE_INFINITY })).toBe(false);
  });

  it('flags the current filament and leaves it in place', () => {
    const choices = rankFilamentChoices(mixed, { q: '', preferType: 'PLA', currentMaterialId: 'pla-out' });
    expect(choices.map((c) => c.row.id)).toEqual(order(mixed, 'PLA'));
    expect(choices.filter((c) => c.current).map((c) => c.row.id)).toEqual(['pla-out']);
    expect(choices.find((c) => c.row.id === 'pla-out')).toMatchObject({ sameType: true, inStock: false, current: true });
  });

  it('applies the search; no match gives []', () => {
    expect(order(catalog, 'PLA', 'beige')).toEqual(['esun-beige', 'pla-beige']);
    expect(order(catalog, 'PLA', 'nothing like this')).toEqual([]);
  });

  it('does not mutate its input', () => {
    const rows = [...mixed];
    const before = JSON.stringify(rows);
    rankFilamentChoices(rows, { q: '', preferType: 'PLA', currentMaterialId: null });
    expect(rows.map((r) => r.id)).toEqual(mixed.map((r) => r.id));
    expect(JSON.stringify(rows)).toBe(before);
  });
});

// ---------------------------------------------------------------- filamentPickWrite

describe('filamentPickWrite', () => {
  const single: SlotFilamentState = { multi: false, materialId: 'm1', slots: [] };
  const multi: SlotFilamentState = {
    multi: true,
    materialId: null,
    slots: [
      { colorIndex: 2, materialId: 'm3' },
      { colorIndex: 0, materialId: 'm1' },
      { colorIndex: 1, materialId: 'm2' },
    ],
  };

  it('single material: writes materialId only', () => {
    expect(filamentPickWrite(single, 0, 'm2')).toEqual({ fields: {}, materialId: 'm2', slots: null });
  });

  it('single material: null for the same filament, another colour index or no pick', () => {
    expect(filamentPickWrite(single, 0, 'm1')).toBeNull();
    expect(filamentPickWrite(single, 1, 'm2')).toBeNull();
    expect(filamentPickWrite(single, 0, '')).toBeNull();
  });

  it('single material with no filament yet: a pick writes it', () => {
    expect(filamentPickWrite({ multi: false, materialId: null, slots: [] }, 0, 'm2')).toEqual({ fields: {}, materialId: 'm2', slots: null });
  });

  it('multicolour: sends only the picked slot, so the other slots are left as the server has them', () => {
    expect(filamentPickWrite(multi, 1, 'm9')).toEqual({
      fields: {},
      materialId: null,
      slots: [{ colorIndex: 1, materialId: 'm9' }],
    });
  });

  it('multicolour: the request plan carries only the picked slot (dry run, then the write)', () => {
    const w = filamentPickWrite(multi, 2, 'm9');
    expect(w).not.toBeNull();
    const base = '/products/p1/components/c1';
    expect(componentDryRunRequests(base, w!)).toEqual([
      { method: 'PUT', path: `${base}/materials?dryRun=1`, body: { slots: [{ colorIndex: 2, materialId: 'm9' }] } },
    ]);
    expect(componentWriteRequests(base, w!, false)).toEqual([
      { method: 'PUT', path: `${base}/materials`, body: { slots: [{ colorIndex: 2, materialId: 'm9' }] } },
    ]);
  });

  it('multicolour: null when the slot already uses it or the colour index is unknown', () => {
    expect(filamentPickWrite(multi, 1, 'm2')).toBeNull();
    expect(filamentPickWrite(multi, 7, 'm9')).toBeNull();
    expect(filamentPickWrite(multi, 1, '')).toBeNull();
  });

  it('does not mutate the state', () => {
    const before = JSON.stringify(multi);
    const w = filamentPickWrite(multi, 2, 'm9');
    expect(JSON.stringify(multi)).toBe(before);
    w?.slots?.push({ colorIndex: 9, materialId: 'x' });
    expect(multi.slots).toHaveLength(3);
  });
});

// ---------------------------------------------------------------- request plans

const BASE = '/products/p1/components/c1';
const write = (patch: Partial<ComponentWrite> = {}): ComponentWrite => ({ fields: {}, materialId: null, slots: null, ...patch });
const slots = [{ colorIndex: 0, materialId: 'm1' }, { colorIndex: 1, materialId: 'm2' }];

describe('componentDryRunRequests', () => {
  it('a fields-only write has no dry run', () => {
    expect(componentDryRunRequests(BASE, write({ fields: { description: 'Lid', quantity: 2 } }))).toEqual([]);
  });

  it('a single filament change checks PATCH ?dryRun=1 with exactly { materialId }', () => {
    const reqs = componentDryRunRequests(BASE, write({ fields: { gramsUsed: 12 }, materialId: 'm2' }));
    expect(reqs).toEqual([{ method: 'PATCH', path: `${BASE}?dryRun=1`, body: { materialId: 'm2' } }]);
    expect(Object.keys(reqs[0].body)).toEqual(['materialId']);
  });

  it('a slots change checks PUT /materials?dryRun=1 with exactly { slots }', () => {
    const reqs = componentDryRunRequests(BASE, write({ slots }));
    expect(reqs).toEqual([{ method: 'PUT', path: `${BASE}/materials?dryRun=1`, body: { slots } }]);
    expect(Object.keys(reqs[0].body)).toEqual(['slots']);
  });
});

describe('componentWriteRequests', () => {
  it('fields only: one PATCH with the fields and no confirm key', () => {
    const reqs = componentWriteRequests(BASE, write({ fields: { description: 'Lid', printMinutes: 30 } }), false);
    expect(reqs).toEqual([{ method: 'PATCH', path: BASE, body: { description: 'Lid', printMinutes: 30 } }]);
    expect('confirm' in reqs[0].body).toBe(false);
  });

  it('fields + materialId + confirm: PATCH { …fields, materialId, confirm: true }', () => {
    expect(componentWriteRequests(BASE, write({ fields: { quantity: 3 }, materialId: 'm2' }), true)).toEqual([
      { method: 'PATCH', path: BASE, body: { quantity: 3, materialId: 'm2', confirm: true } },
    ]);
  });

  it('materialId alone: PATCH { materialId } without confirm', () => {
    const reqs = componentWriteRequests(BASE, write({ materialId: 'm2' }), false);
    expect(reqs).toEqual([{ method: 'PATCH', path: BASE, body: { materialId: 'm2' } }]);
  });

  it('slots: a PUT with no confirm key, or confirm: true when confirmed', () => {
    const plain = componentWriteRequests(BASE, write({ slots }), false);
    expect(plain).toEqual([{ method: 'PUT', path: `${BASE}/materials`, body: { slots } }]);
    expect('confirm' in plain[0].body).toBe(false);
    expect(componentWriteRequests(BASE, write({ slots }), true)).toEqual([
      { method: 'PUT', path: `${BASE}/materials`, body: { slots, confirm: true } },
    ]);
  });

  it('fields + slots: PATCH first, then PUT', () => {
    const reqs = componentWriteRequests(BASE, write({ fields: { gramsUsed: 9.5 }, slots }), false);
    expect(reqs.map((r) => `${r.method} ${r.path}`)).toEqual([`PATCH ${BASE}`, `PUT ${BASE}/materials`]);
    expect(reqs[0].body).toEqual({ gramsUsed: 9.5 });
  });

  it('an empty write sends nothing', () => {
    expect(componentWriteRequests(BASE, write(), false)).toEqual([]);
    expect(componentWriteRequests(BASE, write(), true)).toEqual([]);
    expect(componentWriteRequests(BASE, write({ fields: { description: undefined } }), false)).toEqual([]);
  });
});

// ---------------------------------------------------------------- writeResultMessage

describe('writeResultMessage', () => {
  const impact: Problem = { code: 'OPEN_LINES_AFFECTED', message: '2 open lines will print differently.' };
  const rekeyed: Problem = { code: 'STOCK_REKEYED', message: 'Printed stock moved to the new colour.' };
  const other: Problem = { code: 'SOMETHING_ELSE', message: 'Check the plate layouts.' };

  it('no warnings: success with the success text', () => {
    expect(writeResultMessage([], 'Saved "Lid"')).toEqual({ tone: 'success', text: 'Saved "Lid"' });
  });

  it('only OPEN_LINES_AFFECTED: still success', () => {
    expect(writeResultMessage([impact], 'Saved "Lid"')).toEqual({ tone: 'success', text: 'Saved "Lid"' });
  });

  it('STOCK_REKEYED + OPEN_LINES_AFFECTED: a warning with the STOCK_REKEYED message only', () => {
    expect(writeResultMessage([impact, rekeyed], 'Saved')).toEqual({ tone: 'warning', text: rekeyed.message });
  });

  it('joins two warnings with a single space', () => {
    expect(writeResultMessage([rekeyed, other], 'Saved')).toEqual({ tone: 'warning', text: `${rekeyed.message} ${other.message}` });
  });
});
