import { boxConfig } from './__fixtures__/box-product';
import { resolveInConfig } from './bom-resolve';
import { noGcodeOnFile, PLATE_CHANGE_MINUTES, quickestPlan, suggestJobPlates } from './job-plate-suggestion';
import { PlanError, suggestPlan, type PlannerLayout } from './plate-planner';
import { planFromBom } from './production-planner.service';

/** Owner spec 2026-10-02 item 4: a new job suggests the best plates that have a print file. */

const L = (units: number, minutes: number, file: string | null, id: string | null = file ? `l${units}` : null): PlannerLayout => ({
  layoutId: id, label: `×${units}`, unitsPerPlate: units, plateMinutes: minutes, plateGrams: units * 5,
  slotGrams: new Map([[0, units * 5]]), attachmentId: file, gcodeFilename: file ? `${file}.gcode` : null,
});
const shape = (plan: ReturnType<typeof quickestPlan>) => plan.map((p) => `${p.plateCount}×${p.layout.unitsPerPlate}`);

describe('suggestJobPlates', () => {
  const x20 = L(20, 300, 'a20');
  const x1 = L(1, 20, 'a1', null);

  it("owner's example: 45 with ×20 and ×1 files → ×20 + ×20 + 5 × ×1", () => {
    expect(shape(suggestJobPlates(45, [x20, x1]).plates)).toEqual(['2×20', '5×1']);
  });

  it('a big remainder goes on a big plate: 59 → 3 × ×20 (not ×20, ×20 and 19 singles)', () => {
    expect(shape(suggestJobPlates(59, [x20, x1]).plates)).toEqual(['3×20']);
  });

  it('equal time → the fewest plates: 40 → 2 × ×20, never 40 singles', () => {
    expect(shape(suggestJobPlates(40, [L(20, 400, 'a20'), L(1, 20, 'a1', null)]).plates)).toEqual(['2×20']);
  });

  it('counts a changeover per plate, so a small run stays on one plate when singles barely save time', () => {
    // 7 singles: 7 × 34 = 238 min of printing, but 7 plates; one ×12 plate is 243 min.
    expect(PLATE_CHANGE_MINUTES).toBeGreaterThan(0);
    expect(shape(suggestJobPlates(7, [L(12, 243, 'a12'), L(1, 34, 'a1', null)]).plates)).toEqual(['1×12']);
    expect(shape(suggestJobPlates(13, [L(12, 243, 'a12'), L(1, 34, 'a1', null)]).plates)).toEqual(['1×12', '1×1']);
  });

  it('a layout without a file is never suggested: the ×12 file covers 13 with two plates even though a ×1 exists', () => {
    const out = suggestJobPlates(13, [L(12, 243, 'a12'), L(1, 34, null)]);
    expect(out.noFile).toBe(false);
    expect(shape(out.plates)).toEqual(['2×12']);
    expect(out.plates.every((p) => !!p.layout.attachmentId)).toBe(true);
  });

  it('no plate with a file → the old fewest-plates suggestion over every plate, flagged noFile', () => {
    const layouts = [L(12, 243, null, 'l12'), L(1, 34, null)];
    const out = suggestJobPlates(26, layouts);
    expect(out.noFile).toBe(true);
    expect(shape(out.plates)).toEqual(shape(suggestPlan(26, layouts)));
    expect(shape(out.plates)).toEqual(['3×12']);
  });

  it('nothing usable at all → PlanError; nothing needed → no plates', () => {
    expect(() => suggestJobPlates(5, [])).toThrow(PlanError);
    expect(suggestJobPlates(0, [x20])).toEqual({ plates: [], noFile: false });
  });

  it('handles a very large run quickly and covers it', () => {
    const t = Date.now();
    const plan = suggestJobPlates(100_000, [L(500, 3000, 'a500'), L(7, 50, 'a7'), L(1, 9, 'a1', null)]).plates;
    expect(Date.now() - t).toBeLessThan(1000);
    expect(plan.reduce((s, p) => s + p.plateCount * p.layout.unitsPerPlate, 0)).toBeGreaterThanOrEqual(100_000);
  });
});

describe('planFromBom uses it', () => {
  it('warns "No G-code on file for …" when a part has no file at all, and plans with files otherwise', () => {
    const noFiles = resolveInConfig(boxConfig(), null, null);
    const plan = planFromBom(noFiles, { quantity: 13, surplusPolicy: 'KEEP_FOR_STOCK' }, new Map());
    expect(plan.warnings).toContainEqual({ code: 'NO_GCODE_ON_FILE', componentId: 'box', message: noGcodeOnFile('Box') });
    expect(noGcodeOnFile('Box')).toBe('No G-code on file for "Box" — upload one');

    const withFiles = resolveInConfig(boxConfig({}, (row) => {
      row.components[0].attachmentId = 'a-box';
      row.components[0].plateLayouts[0].attachmentId = 'a-box12';
    }), null, null);
    const filed = planFromBom(withFiles, { quantity: 13, surplusPolicy: 'KEEP_FOR_STOCK' }, new Map());
    expect(filed.warnings.some((w) => w.code === 'NO_GCODE_ON_FILE')).toBe(false);
    // ×12 243 min + one single 34 min beats two ×12 plates.
    expect(filed.components[0].plates.map((p) => [p.layout.unitsPerPlate, p.plateCount, p.layout.attachmentId])).toEqual([[12, 1, 'a-box12'], [1, 1, 'a-box']]);
  });
});
