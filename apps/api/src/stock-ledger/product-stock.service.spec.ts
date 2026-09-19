import { ConflictException } from '@nestjs/common';
import { ProductStockService, suggestFromStock, type JobForCredit } from './product-stock.service';
import { fakeStockDb } from './__fixtures__/fake-stock-db';

const BLACK = 'black', RED = 'red', BLUE = 'blue', GREY = 'grey', WHITE = 'white', ORANGE = 'orange';

function setup() {
  const db = fakeStockDb();
  db.addComponent({ id: 'box', description: 'Box', materialId: BLACK });
  db.addComponent({ id: 'fish', description: 'Fish', isMultiColor: true, materials: [{ colorIndex: 0, materialId: WHITE }, { colorIndex: 1, materialId: ORANGE }] });
  return { db, svc: new ProductStockService({} as any) };
}

/** A Box job: one ×12 plate for R units, planned Red sliced Black (a colour option). */
function job(over: Partial<JobForCredit> = {}, R = 10): JobForCredit {
  return {
    id: 'job-1', purpose: 'CUSTOMER', orderId: null, componentId: null, quantityToProduce: R,
    stockMode: null, surplusPolicy: 'KEEP_FOR_STOCK', variantId: null, sizeOptionId: null, colourOptionId: 'v-red',
    materials: [{ materialId: RED, plannedMaterialId: RED, plannedSlicedMaterialId: BLACK }],
    plates: [{ componentId: 'box', label: 'Box ×12', unitsPerPlate: 12, plateCount: 1, unitsRequired: R, slots: [{ colorIndex: 0, materialId: RED, slicedMaterialId: BLACK }] }],
    ...over,
  };
}

describe('ProductStockService.allocate', () => {
  it('guarded decrement on the column for the base key', async () => {
    const { db, svc } = setup();
    db.comps.get('box')!.stockOnHand = 5;
    const r = await svc.allocate(db.tx, { componentId: 'box', colourKey: `0:${BLACK}`, quantity: 3, orderItemId: 'oi-1' });
    expect(db.column('box')).toBe(2);
    expect(r.balanceAfter).toBe(2);
    expect(db.movements).toEqual([expect.objectContaining({ reason: 'PLAN_ALLOCATE', delta: -3, colourKey: `0:${BLACK}`, baseColumn: true, orderItemId: 'oi-1', balanceAfter: 2 })]);
  });

  it('a colour row bucket for any other key', async () => {
    const { db, svc } = setup();
    db.rows.set(`box|0:${RED}`, 2);
    await svc.allocate(db.tx, { componentId: 'box', colourKey: `0:${RED}`, quantity: 2, orderItemId: 'oi-1' });
    expect(db.row('box', `0:${RED}`)).toBe(0);
    expect(db.movements[0]).toMatchObject({ baseColumn: false, colourKey: `0:${RED}` });
  });

  it('409 when the bucket changed under the plan', async () => {
    const { db, svc } = setup();
    db.rows.set(`box|0:${RED}`, 1);
    await expect(svc.allocate(db.tx, { componentId: 'box', colourKey: `0:${RED}`, quantity: 2, orderItemId: 'oi-1', description: 'Large Box' }))
      .rejects.toThrow(new ConflictException('Printed stock of "Large Box" changed — reload the plan'));
    expect(db.movements).toEqual([]);
  });
});

describe('ProductStockService.creditOnComplete (§3.6 credit table)', () => {
  const credit = async (over: Partial<JobForCredit>) => {
    const { db, svc } = setup();
    const res = await svc.creditOnComplete(db.tx, job(over));
    return { db, res, total: res.credits.reduce((s, c) => s + c.quantity, 0) };
  };

  it.each([
    ['purpose ≠ CUSTOMER', { purpose: 'TEST' }, 0, null],
    ['order job KEEP → S', { orderId: 'o1' }, 2, 'JOB_COMPLETE_SURPLUS'],
    ['order job without orderItemId is an order job', { orderId: 'o1', stockMode: 'BUILD_STOCK' }, 2, 'JOB_COMPLETE_SURPLUS'],
    ['order job CANCEL → 0', { orderId: 'o1', surplusPolicy: 'CANCEL_ON_PRINTER' }, 0, null],
    ['BUILD_STOCK KEEP → R + S', { stockMode: 'BUILD_STOCK' }, 12, 'JOB_COMPLETE_STOCK'],
    ['BUILD_STOCK CANCEL → R', { stockMode: 'BUILD_STOCK', surplusPolicy: 'CANCEL_ON_PRINTER' }, 10, 'JOB_COMPLETE_STOCK'],
    ['DIRECT_SALE KEEP → S', { stockMode: 'DIRECT_SALE' }, 2, 'JOB_COMPLETE_SURPLUS'],
    ['stockMode null = DIRECT_SALE, KEEP → S', { stockMode: null }, 2, 'JOB_COMPLETE_SURPLUS'],
    ['DIRECT_SALE CANCEL → 0', { stockMode: 'DIRECT_SALE', surplusPolicy: 'CANCEL_ON_PRINTER' }, 0, null],
  ])('%s', async (_name, over, n, reason) => {
    const { db, total } = await credit(over as Partial<JobForCredit>);
    expect(total).toBe(n);
    if (reason) expect(db.movements).toEqual([expect.objectContaining({ reason, delta: n, colourKey: `0:${RED}`, baseColumn: false, jobId: 'job-1' })]);
    else expect(db.movements).toEqual([]);
  });

  it('credits the colour actually printed: a Red→Blue swap on a KEEP build-stock job goes to the Blue key', async () => {
    const { db } = await credit({ stockMode: 'BUILD_STOCK', materials: [{ materialId: BLUE, plannedMaterialId: RED, plannedSlicedMaterialId: BLACK }] });
    expect(db.row('box', `0:${BLUE}`)).toBe(12);
    expect(db.row('box', `0:${RED}`)).toBe(0);
  });

  it('a spool substitution credits the substituted colour; the own colour credits the column', async () => {
    const { db } = await credit({ stockMode: 'BUILD_STOCK', materials: [{ materialId: BLACK, plannedMaterialId: RED, plannedSlicedMaterialId: BLACK }] });
    expect(db.column('box')).toBe(12);
    expect(db.movements[0]).toMatchObject({ baseColumn: true, colourKey: `0:${BLACK}` });
  });

  it('a removed planned line → STOCK_CREDIT_NEEDS_REVIEW and 0', async () => {
    const { db, res } = await credit({ stockMode: 'BUILD_STOCK', materials: [] });
    expect(res.credits).toEqual([]);
    expect(res.warnings).toEqual([expect.objectContaining({ code: 'STOCK_CREDIT_NEEDS_REVIEW', message: '"Box": filament lines were changed on this job — add the 12 printed units to stock by hand' })]);
    expect(db.movements).toEqual([]);
  });

  it('a group whose component was removed → COMPONENT_REMOVED, credit 0', async () => {
    const { res } = await credit({ stockMode: 'BUILD_STOCK', plates: [{ ...job().plates[0], componentId: null }] });
    expect(res.warnings.map((w) => w.code)).toEqual(['COMPONENT_REMOVED']);
  });

  describe('legacy jobs (no JobPlate rows)', () => {
    const legacy = (over: Partial<JobForCredit>) => job({ plates: [], materials: [], colourOptionId: null, componentId: 'box', quantityToProduce: 7, ...over });
    it('SIZE variantId, no order → quantityToProduce to the column', async () => {
      const { db, svc } = setup();
      db.variants.set('v-large', { kind: 'SIZE' });
      const r = await svc.creditOnComplete(db.tx, legacy({ variantId: 'v-large' }));
      expect(r.credits).toEqual([expect.objectContaining({ quantity: 7, baseColumn: true, reason: 'JOB_COMPLETE_STOCK' })]);
      expect(db.column('box')).toBe(7);
    });
    it('variantId now a COLOUR → 0 with STOCK_CREDIT_NEEDS_REVIEW', async () => {
      const { db, svc } = setup();
      db.variants.set('v-red', { kind: 'COLOUR' });
      const r = await svc.creditOnComplete(db.tx, legacy({ variantId: 'v-red' }));
      expect(r.credits).toEqual([]);
      expect(r.warnings.map((w) => w.code)).toEqual(['STOCK_CREDIT_NEEDS_REVIEW']);
      expect(db.column('box')).toBe(0);
    });
    it('a legacy job with orderId → 0 (units made for an order are not free stock)', async () => {
      const { db, svc } = setup();
      const r = await svc.creditOnComplete(db.tx, legacy({ orderId: 'o1' }));
      expect(r.credits).toEqual([]);
      expect(db.movements).toEqual([]);
    });
  });

  it('balanceAfter equals the RETURNING value under two concurrent credits (both applied)', async () => {
    const { db, svc } = setup();
    await Promise.all([
      svc.creditOnComplete(db.tx, job({ id: 'j1', stockMode: 'BUILD_STOCK' })),
      svc.creditOnComplete(db.tx, job({ id: 'j2', stockMode: 'BUILD_STOCK' })),
    ]);
    expect(db.row('box', `0:${RED}`)).toBe(24);
    expect(db.movements.map((m) => m.balanceAfter).sort((a, b) => a - b)).toEqual([12, 24]);
  });
});

describe('ProductStockService.rekeyBase', () => {
  it('base 5 Black → material Red: 5 move to the Black row, an existing Red row of 3 moves into the column', async () => {
    const { db, svc } = setup();
    db.comps.get('box')!.stockOnHand = 5;
    db.rows.set(`box|0:${RED}`, 3);
    db.comps.get('box')!.materialId = RED; // P10 changed the own filament in the same transaction
    const r = await svc.rekeyBase(db.tx, 'box', `0:${BLACK}`, `0:${RED}`, { materials: new Map([[BLACK, { name: 'PLA Black' }]]) });
    expect(db.column('box')).toBe(3);
    expect(db.row('box', `0:${BLACK}`)).toBe(5);
    expect(db.row('box', `0:${RED}`)).toBe(0);
    expect(db.movements.map((m) => [m.reason, m.delta, m.colourKey, m.baseColumn])).toEqual([
      ['FILAMENT_REKEY', -5, `0:${BLACK}`, true],
      ['FILAMENT_REKEY', 5, `0:${BLACK}`, false],
      ['FILAMENT_REKEY', -3, `0:${RED}`, false],
      ['FILAMENT_REKEY', 3, `0:${RED}`, true],
    ]);
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'STOCK_REKEYED', message: '5 printed units in the old colour kept as PLA Black' })]);
    // invariant: no row duplicates the (new) base key
    expect(db.row('box', `0:${RED}`)).toBe(0);
  });

  it('an unconfirmed column moves the same way, stays unconfirmed, and the row is noted', async () => {
    const { db, svc } = setup();
    Object.assign(db.comps.get('box')!, { stockOnHand: 4, stockConfirmedAt: null });
    await svc.rekeyBase(db.tx, 'box', `0:${BLACK}`, `0:${GREY}`);
    expect(db.comps.get('box')!.stockConfirmedAt).toBeNull();
    expect(db.movements[1].note).toMatch(/unconfirmed — may include other colours/);
  });
});

describe('ProductStockService release', () => {
  it('releaseForOrder returns the net allocation once; a second cancel returns 0', async () => {
    const { db, svc } = setup();
    db.orderItems.push({ id: 'oi-1', orderId: 'o1' });
    db.rows.set(`box|0:${RED}`, 2);
    await svc.allocate(db.tx, { componentId: 'box', colourKey: `0:${RED}`, quantity: 2, orderItemId: 'oi-1' });
    const first = await svc.releaseForOrder(db.tx, 'o1');
    expect(first.map((r) => r.quantity)).toEqual([2]);
    expect(db.row('box', `0:${RED}`)).toBe(2);
    expect(await svc.releaseForOrder(db.tx, 'o1')).toEqual([]);
    expect(db.movements.map((m) => [m.reason, m.delta])).toEqual([['PLAN_ALLOCATE', -2], ['PLAN_RELEASE', 2]]);
  });

  it('release after a filament change goes to the PHYSICAL colour, not the new column', async () => {
    const { db, svc } = setup();
    db.orderItems.push({ id: 'oi-1', orderId: 'o1' });
    db.comps.get('box')!.stockOnHand = 5;
    await svc.allocate(db.tx, { componentId: 'box', colourKey: `0:${BLACK}`, quantity: 5, orderItemId: 'oi-1' });
    expect(db.movements[0]).toMatchObject({ colourKey: `0:${BLACK}`, baseColumn: true });
    db.comps.get('box')!.materialId = GREY; // P10: Box re-sliced in PLA Grey
    const rk = await svc.rekeyBase(db.tx, 'box', `0:${BLACK}`, `0:${GREY}`);
    expect(rk.moved).toBe(0);
    await svc.releaseForOrder(db.tx, 'o1');
    expect(db.row('box', `0:${BLACK}`)).toBe(5);
    expect(db.column('box')).toBe(0);
    expect(db.movements.at(-1)).toMatchObject({ reason: 'PLAN_RELEASE', delta: 5, colourKey: `0:${BLACK}`, baseColumn: false });
    expect(db.movements.every((m) => typeof m.colourKey === 'string' && m.colourKey.length > 0)).toBe(true);
  });

  it('releaseForItem releases only that item', async () => {
    const { db, svc } = setup();
    db.rows.set(`box|0:${RED}`, 5);
    await svc.allocate(db.tx, { componentId: 'box', colourKey: `0:${RED}`, quantity: 2, orderItemId: 'oi-1' });
    await svc.allocate(db.tx, { componentId: 'box', colourKey: `0:${RED}`, quantity: 3, orderItemId: 'oi-2' });
    const r = await svc.releaseForItem(db.tx, 'oi-1');
    expect(r.map((x) => x.quantity)).toEqual([2]);
    expect(db.row('box', `0:${RED}`)).toBe(2);
  });
});

describe('manual set and unconfirmed stock', () => {
  it('a pre-release column of 10 is suggested as 0 with STOCK_UNCONFIRMED; an explicit fromStock is still accepted', async () => {
    const { db, svc } = setup();
    Object.assign(db.comps.get('box')!, { stockOnHand: 10, stockConfirmedAt: null });
    const s = suggestFromStock({ onHand: 10, remaining: 4, isBaseColumn: true, stockConfirmedAt: null, description: 'Box' });
    expect(s.fromStock).toBe(0);
    expect(s.warning).toEqual({ code: 'STOCK_UNCONFIRMED', message: '"Box": printed stock predates the update and may include other colours — confirm it on the product page first' });
    await svc.allocate(db.tx, { componentId: 'box', colourKey: `0:${BLACK}`, quantity: 2, orderItemId: 'oi-1' });
    expect(db.column('box')).toBe(8);
  });

  it('P13 with the same value writes a 0-delta MANUAL_ADJUST and confirms; then the suggestion is min(onHand, remaining)', async () => {
    const { db, svc } = setup();
    Object.assign(db.comps.get('box')!, { stockOnHand: 10, stockConfirmedAt: null });
    await svc.manualSet(db.tx, { componentId: 'box', colourKey: null, stockOnHand: 10, expectedStockOnHand: 10 });
    expect(db.movements).toEqual([expect.objectContaining({ reason: 'MANUAL_ADJUST', delta: 0, note: 'confirmed', baseColumn: true, colourKey: `0:${BLACK}` })]);
    const c = db.comps.get('box')!;
    expect(c.stockConfirmedAt).not.toBeNull();
    expect(suggestFromStock({ onHand: 10, remaining: 4, isBaseColumn: true, stockConfirmedAt: c.stockConfirmedAt, description: 'Box' })).toEqual({ fromStock: 4, warning: null });
  });

  it('a stale expectedStockOnHand → 409; delta = new − expected', async () => {
    const { db, svc } = setup();
    db.comps.get('box')!.stockOnHand = 7;
    await expect(svc.manualSet(db.tx, { componentId: 'box', colourKey: null, stockOnHand: 3, expectedStockOnHand: 5 })).rejects.toThrow('Printed stock is now 7 — reload');
    const r = await svc.manualSet(db.tx, { componentId: 'box', colourKey: null, stockOnHand: 3, expectedStockOnHand: 7 });
    expect(r.quantity).toBe(-4);
    expect(db.column('box')).toBe(3);
  });

  it('a colour row: missing row with expected 0 is created, then set', async () => {
    const { db, svc } = setup();
    await svc.manualSet(db.tx, { componentId: 'box', colourKey: `0:${RED}`, stockOnHand: 6, expectedStockOnHand: 0 });
    expect(db.row('box', `0:${RED}`)).toBe(6);
    expect(db.movements[0]).toMatchObject({ baseColumn: false, delta: 6 });
    await expect(svc.manualSet(db.tx, { componentId: 'box', colourKey: '0:bad key', stockOnHand: 1, expectedStockOnHand: 0 })).rejects.toThrow('Invalid colour key');
  });

  it.each([-1, 1.5, 1000001, NaN, 'abc'])('rejects stockOnHand %p', async (n) => {
    const { db, svc } = setup();
    await expect(svc.manualSet(db.tx, { componentId: 'box', colourKey: null, stockOnHand: n, expectedStockOnHand: 0 })).rejects.toThrow(/stockOnHand/);
  });
});
