import type { PlannerLayout } from '../catalog-core/plate-planner';
import {
  CONVERTED_BLOCKER, parseConversionActive, parseLayoutConversion, planningRows, plateChecks,
} from './option-conversion-rules';

/** Convert to plate: the plate checks, the planning table and the input parsers. */

const status = (fn: () => unknown) => {
  try {
    fn();
    return 200;
  } catch (e: any) {
    return e?.getStatus?.() ?? 500;
  }
};

describe('plateChecks', () => {
  const single = { gramsPerUnit: 10, minutesPerUnit: 10 };
  const codes = (grams: number, minutes: number, s = single) => plateChecks('Fish', 10, minutes, grams, s).warnings.map((w) => w.code);

  it('PLATE_GRAMS_DIFFER beyond 30 % either way (BF-1 rule), not within', () => {
    expect(codes(131, 50)).toEqual(['PLATE_GRAMS_DIFFER']);
    expect(codes(69, 50)).toEqual(['PLATE_GRAMS_DIFFER']);
    expect(codes(129, 50)).toEqual([]);
    expect(codes(71, 50)).toEqual([]);
  });

  it('PLATE_SLOWER_PER_UNIT beyond +10 % per unit, not at +9 % or when faster', () => {
    expect(codes(100, 111)).toEqual(['PLATE_SLOWER_PER_UNIT']);
    expect(codes(100, 109)).toEqual([]);
    expect(codes(100, 40)).toEqual([]);
  });

  it('PLATE_NO_SINGLE when the part has no per-unit grams or minutes', () => {
    expect(codes(100, 100, { gramsPerUnit: 0, minutesPerUnit: 10 })).toEqual(['PLATE_NO_SINGLE']);
    expect(codes(100, 100, { gramsPerUnit: 10, minutesPerUnit: 0 })).toEqual(['PLATE_NO_SINGLE']);
  });

  it('recommends switching the plate on only with none of the three', () => {
    expect(plateChecks('Fish', 10, 50, 100, single).recommendActive).toBe(true);
    expect(plateChecks('Fish', 10, 50, 131, single).recommendActive).toBe(false);
    expect(plateChecks('Fish', 10, 111, 100, single).recommendActive).toBe(false);
    expect(plateChecks('Fish', 10, 50, 100, { gramsPerUnit: 0, minutesPerUnit: 0 }).recommendActive).toBe(false);
  });

  it('the owner\'s suspicious ones: Fish Keychain 29 (−38 % g) and top15 on pull tab (+54 % g, +33 % time)', () => {
    const fish = plateChecks('Fish', 29, 144, 42.19, { gramsPerUnit: 2.36, minutesPerUnit: 24 });
    expect(fish.warnings).toEqual([
      { code: 'PLATE_GRAMS_DIFFER', message: '"Fish ×29": 1.45 g per unit on this plate vs 2.36 g for one (−38 %) — check the part and the units' },
    ]);
    const tab = plateChecks('pull tab', 15, 419, 22.6, { gramsPerUnit: 0.98, minutesPerUnit: 21 });
    expect(tab.warnings.map((w) => w.message)).toEqual([
      '"pull tab ×15": 1.51 g per unit on this plate vs 0.98 g for one (+54 %) — check the part and the units',
      '"pull tab ×15": 27.93 min per unit on this plate vs 21 min printing one at a time (+33 %) — every job of 2 or more would use this slower plate',
    ]);
    expect(plateChecks('BASE', 50, 421, 120.77, { gramsPerUnit: 2.47, minutesPerUnit: 12 }).recommendActive).toBe(true);
  });
});

describe('planningRows (BASE: 12 min and 2.47 g each; ×50 = 421 min, 120.77 g)', () => {
  const single: PlannerLayout = { layoutId: null, label: 'BASE single', unitsPerPlate: 1, plateMinutes: 12, plateGrams: 2.47, slotGrams: new Map([[0, 2.47]]) };
  const x50: PlannerLayout = { layoutId: 'new', label: 'BASE ×50', unitsPerPlate: 50, plateMinutes: 421, plateGrams: 120.77, slotGrams: new Map([[0, 120.77]]) };

  it('rows for 2, ⌈U/2⌉, U and U+1 — today and with the plate (keep extras)', () => {
    const rows = planningRows([single], x50, 50, 'KEEP_FOR_STOCK', [0]);
    expect(rows.map((r) => r.units)).toEqual([2, 25, 50, 51]);
    expect(rows[0].now).toEqual({ plates: [{ unitsPerPlate: 1, plateCount: 2 }], minutes: 24, grams: 4.94, extra: 0 });
    expect(rows[0].withPlate).toEqual({ plates: [{ unitsPerPlate: 50, plateCount: 1 }], minutes: 421, grams: 120.77, extra: 48 });
    expect(rows[3].withPlate).toMatchObject({ plates: [{ unitsPerPlate: 50, plateCount: 1 }, { unitsPerPlate: 1, plateCount: 1 }], minutes: 433, extra: 0 });
  });

  it('cancel extras: 2 needed print only 2 of the 50', () => {
    const [two] = planningRows([single], x50, 50, 'CANCEL_ON_PRINTER', [0]);
    expect(Math.round(two.withPlate.minutes)).toBe(17);
    expect(two.withPlate.grams).toBeCloseTo(4.831, 3);
    expect(two.withPlate.extra).toBe(48);
  });

  it('U = 2 gives rows [2, 3]; no usable layout today → now null', () => {
    const x2 = { ...x50, unitsPerPlate: 2, plateMinutes: 20, plateGrams: 4.8, slotGrams: new Map([[0, 4.8]]) };
    expect(planningRows([single], x2, 2, 'KEEP_FOR_STOCK', [0]).map((r) => r.units)).toEqual([2, 3]);
    const rows = planningRows([], x50, 50, 'KEEP_FOR_STOCK', [0]);
    expect(rows.every((r) => r.now === null)).toBe(true);
    expect(rows[3].withPlate.plates).toEqual([{ unitsPerPlate: 50, plateCount: 2 }]);
  });

  it('grams add up over every colour of the part', () => {
    const two: PlannerLayout = { ...single, plateGrams: 3, slotGrams: new Map([[0, 2], [1, 1]]) };
    const plate: PlannerLayout = { ...x50, plateGrams: 150, slotGrams: new Map([[0, 100], [1, 50]]) };
    expect(planningRows([two], plate, 50, 'KEEP_FOR_STOCK', [0, 1])[0].withPlate.grams).toBe(150);
  });
});

describe('parsers', () => {
  it('parseLayoutConversion takes numeric strings (a query) and ignores unknown keys', () => {
    expect(parseLayoutConversion({ componentId: 'c1', unitsPerPlate: '50', plateMinutes: '421', plateGrams: '120.77', colorChanges: '3', x: 1 }))
      .toEqual({ componentId: 'c1', unitsPerPlate: 50, plateMinutes: 421, plateGrams: 120.77, colorChanges: 3 });
    expect(parseLayoutConversion({ componentId: 'c1', unitsPerPlate: 2, plateMinutes: 1, plateGrams: 0.1, assembledUploadId: 'u1' }))
      .toMatchObject({ assembledUploadId: 'u1' });
  });

  it('refuses a bad id or number with a 400 naming the field', () => {
    const ok = { componentId: 'c1', unitsPerPlate: 50, plateMinutes: 421, plateGrams: 120.77 };
    for (const bad of [undefined, '', 5, 'x'.repeat(65)]) expect(status(() => parseLayoutConversion({ ...ok, componentId: bad }))).toBe(400);
    expect(() => parseLayoutConversion({ ...ok, componentId: 7 })).toThrow('"componentId" must be an id');
    expect(() => parseLayoutConversion({ ...ok, unitsPerPlate: undefined })).toThrow('"unitsPerPlate" is required');
    expect(() => parseLayoutConversion({ ...ok, unitsPerPlate: '2.5' })).toThrow('"unitsPerPlate" must be a whole number');
    expect(() => parseLayoutConversion({ ...ok, unitsPerPlate: 501 })).toThrow('"unitsPerPlate" must be between 1 and 500');
    expect(() => parseLayoutConversion({ ...ok, plateMinutes: 'abc' })).toThrow('"plateMinutes" must be a number');
    expect(() => parseLayoutConversion({ ...ok, plateGrams: 0 })).toThrow('"plateGrams"');
    expect(() => parseLayoutConversion({ ...ok, colorChanges: 10001 })).toThrow('"colorChanges"');
  });

  it('parseConversionActive: omitted → undefined; true/false; anything else → 400', () => {
    expect(parseConversionActive({})).toBeUndefined();
    expect(parseConversionActive({ isActive: false })).toBe(false);
    expect(status(() => parseConversionActive({ isActive: 'yes' }))).toBe(400);
    expect(() => parseConversionActive({ isActive: 'yes' })).toThrow('"isActive" must be true or false');
  });

  it('CONVERTED_BLOCKER wording', () => {
    expect(CONVERTED_BLOCKER('b50', 'activate it to change its kind.')).toBe('"b50" was converted to a plate layout — activate it to change its kind.');
  });
});
