import { parseCreatePlate, parseNoBody, parseUpdatePlate } from './order-plate-input';
import { itemUnits, liveJobUnits, liveJobsOf, plateFinished, storedItemsOf, storedPreviewOf, type PlateJob } from './order-plate-model';

/** Bodies of the print-plan routes are allowlisted and bounded; stored JSON is read back defensively. */

const item = (units: unknown = 3, rowKey: unknown = 'line1:comp1') => ({ rowKey, units });
const bad = (fn: () => unknown, message?: string | RegExp) => {
  let err: any;
  try { fn(); } catch (e) { err = e; }
  expect(err?.getStatus?.()).toBe(400);
  if (message) expect(err.message).toMatch(message);
};

describe('parseCreatePlate', () => {
  it('reads a plate key by key', () => {
    expect(parseCreatePlate({ kind: 'mixed', printerId: ' pr-1 ', items: [item(3), item(500, 'line1:comp2')] })).toEqual({
      kind: 'MIXED', printerId: 'pr-1', layoutId: null, items: [{ rowKey: 'line1:comp1', units: 3 }, { rowKey: 'line1:comp2', units: 500 }],
    });
    expect(parseCreatePlate({ kind: 'LAYOUT', printerId: null, items: [item(1)], layoutId: 'l1', plateCount: 200 })).toEqual({
      kind: 'LAYOUT', printerId: null, layoutId: 'l1', plateCount: 200, items: [{ rowKey: 'line1:comp1', units: 1 }],
    });
  });

  it('refuses unknown keys, at every level', () => {
    bad(() => parseCreatePlate({ kind: 'MIXED', items: [item()], orderId: 'x' }), /orderId should not exist/);
    bad(() => parseCreatePlate({ kind: 'MIXED', items: [{ ...item(), unitsSliced: 9 }] }), /unitsSliced should not exist/);
    bad(() => parseCreatePlate({ kind: 'MIXED', items: [item()], status: 'DONE' }));
  });

  it('bounds every number and list', () => {
    for (const units of [0, -1, 501, 2.5, NaN, Infinity, 'many', null]) bad(() => parseCreatePlate({ kind: 'MIXED', items: [item(units)] }));
    for (const plateCount of [0, 201, 1.5, -3, Infinity]) bad(() => parseCreatePlate({ kind: 'LAYOUT', items: [item()], plateCount }));
    bad(() => parseCreatePlate({ kind: 'MIXED', items: [] }), 'at least one part');
    bad(() => parseCreatePlate({ kind: 'MIXED', items: Array.from({ length: 25 }, (_, i) => item(1, `l:c${i}`)) }), 'at most 24');
    bad(() => parseCreatePlate({ kind: 'MIXED', items: 'all' }));
    bad(() => parseCreatePlate({ kind: 'MIXED', items: [null] }));
    bad(() => parseCreatePlate({ kind: 'MIXED', items: [['line1:comp1', 3]] }));
  });

  it('refuses a kind, an id or a row key that is not one', () => {
    for (const kind of [undefined, '', 'SLICED', 7, null]) bad(() => parseCreatePlate({ kind, items: [item()] }), /"kind" must be one of/);
    for (const printerId of [7, {}, 'x'.repeat(65)]) bad(() => parseCreatePlate({ kind: 'MIXED', printerId, items: [item()] }));
    for (const rowKey of [null, 7, 'nocolon', 'a:b:c', "a:b'; DROP", `${'x'.repeat(65)}:c`]) bad(() => parseCreatePlate({ kind: 'MIXED', items: [item(1, rowKey)] }));
    bad(() => parseCreatePlate({ kind: 'MIXED', items: [item(1), item(2)] }), 'twice');
    bad(() => parseCreatePlate('MIXED'));
  });
});

describe('parseUpdatePlate', () => {
  it('reads only what was sent; printerId null means "no printer"', () => {
    expect(parseUpdatePlate({ printerId: 'pr-2' })).toEqual({ printerId: 'pr-2' });
    expect(parseUpdatePlate({ printerId: null })).toEqual({ printerId: null });
    expect(parseUpdatePlate({ items: [item(4)], plateCount: 2 })).toEqual({ items: [{ rowKey: 'line1:comp1', units: 4 }], plateCount: 2 });
  });

  it('refuses an empty change, unknown keys and bad numbers', () => {
    bad(() => parseUpdatePlate({}), 'Nothing to change');
    bad(() => parseUpdatePlate(undefined), 'Nothing to change');
    bad(() => parseUpdatePlate({ kind: 'PROJECT' }), /kind should not exist/);
    bad(() => parseUpdatePlate({ status: 'DONE', attachmentId: 'x' }));
    bad(() => parseUpdatePlate({ plateCount: 0 }));
    bad(() => parseUpdatePlate({ items: [item(0)] }));
  });
});

describe('parseNoBody', () => {
  it('accepts nothing or {} and refuses anything else', () => {
    expect(() => parseNoBody(undefined)).not.toThrow();
    expect(() => parseNoBody({})).not.toThrow();
    bad(() => parseNoBody({ force: true }));
    bad(() => parseNoBody([1]));
  });
});

describe('stored JSON', () => {
  it('storedItemsOf keeps well-formed items and drops the rest', () => {
    expect(storedItemsOf([
      { rowKey: 'l:c', orderItemId: 'l', componentId: 'c', units: 3, unitsSliced: 2, minutes: 10.5, grams: 4, slotGrams: { '0': 3, '1': 1, '9': 5, x: 'y' }, extra: 1 },
      { rowKey: 'l:d', orderItemId: 'l', componentId: 'd', units: 2 },
      { rowKey: 'l:e', orderItemId: 'l', componentId: 'e', units: 0 },
      { rowKey: 7 }, null, 'x',
    ])).toEqual([
      { rowKey: 'l:c', orderItemId: 'l', componentId: 'c', units: 3, unitsSliced: 2, minutes: 10.5, grams: 4, slotGrams: { '0': 3, '1': 1 } },
      { rowKey: 'l:d', orderItemId: 'l', componentId: 'd', units: 2, unitsSliced: null, minutes: null, grams: null },
    ]);
    for (const junk of [null, undefined, 'x', {}, 5]) expect(storedItemsOf(junk)).toEqual([]);
  });

  it('storedPreviewOf needs a bed and objects', () => {
    expect(storedPreviewOf({ bed: { x: 220, y: 220 }, exact: true, objects: [], overflow: 0 })).toEqual({ bed: { x: 220, y: 220 }, exact: true, objects: [], overflow: 0 });
    for (const junk of [null, {}, [], { bed: { x: 'a', y: 1 }, objects: [] }, { bed: { x: 1, y: 1 } }]) expect(storedPreviewOf(junk)).toBeNull();
  });

  it('itemUnits: what the slicer placed once known, times the plate count', () => {
    expect(itemUnits({ units: 15, unitsSliced: null }, 1)).toBe(15);
    expect(itemUnits({ units: 15, unitsSliced: 12 }, 1)).toBe(12);
    expect(itemUnits({ units: 10, unitsSliced: 10 }, 3)).toBe(30);
    expect(itemUnits({ units: 4, unitsSliced: 0 }, 0)).toBe(0);
  });

  it('a plate is locked by its jobs that are neither failed nor cancelled; a failed or cancelled job stands for no units', () => {
    const job = (id: string, status: string, o: Partial<PlateJob> = {}): PlateJob => ({ id, status, orderPlateId: 'p1', orderItemId: 'l', componentId: 'c', quantityToProduce: 5, ...o });
    const jobs = [job('a', 'QUEUED'), job('b', 'CANCELLED'), job('c', 'FAILED'), job('d', 'COMPLETED', { componentId: 'd', quantityToProduce: 2 }), job('e', 'QUEUED', { orderPlateId: 'p2' })];
    expect(liveJobsOf(jobs, 'p1').map((j) => j.id)).toEqual(['a', 'd']);
    // Every job failed or cancelled: the plate is free again — unless a reprint (it carries the plate's id) is open.
    expect(liveJobsOf([job('b', 'CANCELLED'), job('c', 'FAILED')], 'p1')).toEqual([]);
    expect(liveJobsOf([job('c', 'FAILED'), job('r', 'QUEUED')], 'p1').map((j) => j.id)).toEqual(['r']);
    expect([...liveJobUnits(jobs)]).toEqual([['l:c', 10], ['l:d', 2]]);
  });

  it('plateFinished: it has jobs and none is open', () => {
    const job = (id: string, status: string): PlateJob => ({ id, status, orderPlateId: 'p1', orderItemId: 'l', componentId: 'c', quantityToProduce: 1 });
    expect(plateFinished([job('a', 'COMPLETED'), job('b', 'FAILED'), job('c', 'CANCELLED')], 'p1')).toBe(true);
    expect(plateFinished([job('a', 'COMPLETED'), job('b', 'PAUSED')], 'p1')).toBe(false);
    expect(plateFinished([job('a', 'QUEUED')], 'p1')).toBe(false);
    expect(plateFinished([], 'p1')).toBe(false);
    expect(plateFinished([job('a', 'COMPLETED')], 'other')).toBe(false);
  });
});
