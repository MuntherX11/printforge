import { gramsForPlan, minutesForPlan, PlanCache, PlanError, suggestPlan, unitsOf, validatePlan, type PlannerLayout } from './plate-planner';

const L = (units: number, minutes = units * 10, grams = units, slots?: Record<number, number>, id?: string | null): PlannerLayout => ({
  layoutId: id === undefined ? (units === 1 ? null : `x${units}`) : id,
  label: `×${units}`,
  unitsPerPlate: units,
  plateMinutes: minutes,
  plateGrams: grams,
  slotGrams: new Map(Object.entries(slots ?? { 0: grams }).map(([k, v]) => [Number(k), v])),
});

const shape = (plan: ReturnType<typeof suggestPlan>) => plan.flatMap((p) => Array(p.plateCount).fill(p.layout.unitsPerPlate));

describe('suggestPlan (§3.5 table)', () => {
  const x12 = L(12), x8 = L(8), one = L(1), x24 = L(24);
  const rows: Array<[number, PlannerLayout[], number[], number]> = [
    [30, [x12, x8, one], [12, 12, 8], 2],
    [30, [x12, one], [12, 12, 12], 6],
    [28, [x12, x8, one], [12, 8, 8], 0],
    [26, [x12, one], [12, 12, 12], 10],
    [25, [x12, one], [12, 12, 1], 0],
    [24, [x12, x8, one], [12, 12], 0],
    [13, [x12, one], [12, 1], 0],
    [5, [x12, x8, one], [8], 3],
    [5, [x12, one], [12], 7],
    [2, [x24, one], [24], 22],
    [1, [x12, one], [1], 0],
    [1, [x12], [12], 11],
  ];
  it.each(rows)('N=%i', (N, layouts, plates, surplus) => {
    const plan = suggestPlan(N, layouts);
    expect(shape(plan)).toEqual(plates);
    expect(unitsOf(plan) - N).toBe(surplus);
  });

  it('returns [] for N <= 0 and throws NO_USABLE_LAYOUT without layouts', () => {
    expect(suggestPlan(0, [x12])).toEqual([]);
    expect(() => suggestPlan(3, [])).toThrow(PlanError);
  });

  it('keeps the lower minutes per unit when two layouts share a size', () => {
    const slow = { ...L(12, 300), layoutId: 'slow' };
    const fast = { ...L(12, 240), layoutId: 'fast' };
    expect(suggestPlan(12, [slow, fast])[0].layout.layoutId).toBe('fast');
    expect(suggestPlan(12, [fast, slow])[0].layout.layoutId).toBe('fast');
  });

  it('N=100000 with ×500, ×7 and a single in under 50 ms, table built once per layout set', () => {
    const cache = new PlanCache();
    const layouts = [L(500), L(7), L(1)];
    suggestPlan(99_999, layouts, cache); // warm-up
    const t0 = performance.now();
    const plan = suggestPlan(100_000, layouts, cache);
    const ms = performance.now() - t0;
    expect(unitsOf(plan)).toBeGreaterThanOrEqual(100_000);
    expect(ms).toBeLessThan(50);
    for (let n = 1; n < 2000; n++) suggestPlan(n, layouts, cache);
    expect(cache.tablesBuilt).toBe(1);
  });
});

describe('gramsForPlan / minutesForPlan (§3.6)', () => {
  // Box ×12: 243 min / 112.8 g; ×8: 170 min / 75.2 g
  const box12 = L(12, 243, 112.8);
  const box8 = L(8, 170, 75.2);
  const boxOne = L(1, 34, 9.4);

  it('30 boxes planned 12, 12, 8: KEEP 300.8 g, CANCEL 282.0 g', () => {
    const plan = suggestPlan(30, [box12, box8, boxOne]);
    expect(gramsForPlan(plan, 0, 30, 'KEEP_FOR_STOCK')).toBeCloseTo(300.8, 6);
    expect(gramsForPlan(plan, 0, 30, 'CANCEL_ON_PRINTER')).toBeCloseTo(282.0, 6);
  });

  it('Fish CANCEL: R=20 on one ×24 plate → White 24.0 g, Orange 6.0 g', () => {
    const fish = L(24, 175, 36, { 0: 28.8, 1: 7.2 });
    const plan = suggestPlan(20, [fish]);
    expect(gramsForPlan(plan, 0, 20, 'CANCEL_ON_PRINTER')).toBeCloseTo(24.0, 6);
    expect(gramsForPlan(plan, 1, 20, 'CANCEL_ON_PRINTER')).toBeCloseTo(6.0, 6);
    expect(gramsForPlan(plan, 0, 20, 'KEEP_FOR_STOCK')).toBeCloseTo(28.8, 6);
  });

  it('CANCEL spans two trailing plates on an edited plan (12, 1, 1 for R=12)', () => {
    const plan = [
      { layout: box12, plateCount: 1 },
      { layout: boxOne, plateCount: 1 },
      { layout: boxOne, plateCount: 1 },
    ];
    expect(gramsForPlan(plan, 0, 12, 'CANCEL_ON_PRINTER')).toBeCloseTo(112.8, 6);
    expect(minutesForPlan(plan, 12, 'CANCEL_ON_PRINTER')).toBeCloseTo(243, 6);
    expect(gramsForPlan(plan, 0, 12, 'KEEP_FOR_STOCK')).toBeCloseTo(131.6, 6);
  });

  it('minutesForPlan CANCEL for 26 boxes on 12×3 = 526.5', () => {
    const plan = suggestPlan(26, [box12, boxOne]);
    expect(shape(plan)).toEqual([12, 12, 12]);
    expect(minutesForPlan(plan, 26, 'CANCEL_ON_PRINTER')).toBeCloseTo(526.5, 6);
    expect(minutesForPlan(plan, 26, 'KEEP_FOR_STOCK')).toBeCloseTo(729, 6);
  });
});

describe('validatePlan', () => {
  const comp = {
    componentId: 'c1',
    description: 'Box',
    layouts: [L(12, 243, 112.8, undefined, 'l12'), L(1, 34, 9.4, undefined, null)],
    inactiveLayoutIds: ['l-old'],
  };

  it('accepts a covering plan', () => {
    const plan = validatePlan(comp, 13, [{ componentId: 'c1', layoutId: 'l12', plateCount: 1 }, { componentId: 'c1', layoutId: null, plateCount: 1 }]);
    expect(unitsOf(plan)).toBe(13);
  });

  it('rejects plates that do not cover R', () => {
    expect(() => validatePlan(comp, 30, [{ componentId: 'c1', layoutId: 'l12', plateCount: 2 }])).toThrow('"Box": plates cover 24 units but 30 are needed');
  });

  it('rejects a foreign layout and an inactive layout', () => {
    expect(() => validatePlan(comp, 1, [{ componentId: 'c1', layoutId: 'l-other', plateCount: 1 }])).toThrow(/another component/);
    expect(() => validatePlan(comp, 1, [{ componentId: 'c1', layoutId: 'l-old', plateCount: 1 }])).toThrow(/no longer active/);
  });

  it.each([0, 10001, 1.5, NaN, '2'])('rejects plateCount %p', (n) => {
    expect(() => validatePlan(comp, 1, [{ componentId: 'c1', layoutId: 'l12', plateCount: n }])).toThrow(/plate count/);
  });

  it('rejects a null layout without an implicit single', () => {
    const noSingle = { ...comp, layouts: [comp.layouts[0]] };
    expect(() => validatePlan(noSingle, 1, [{ componentId: 'c1', layoutId: null, plateCount: 1 }])).toThrow(/no single-unit plate/);
  });
});
