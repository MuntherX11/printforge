import type { MaterialLite } from '@printforge/types';
import { matchPlateSlots, slotColourOf, type FileTool, type PartSlot } from './plate-slot-match';

/** Convert to plate: a converted plate's filament per colour (one slot per part colour, grams sum to the plate). */

const mat = (id: string, over: Partial<MaterialLite> = {}): MaterialLite => ({
  id, name: `PLA ${id}`, type: 'PLA', color: null, colorHex: null, brand: null, costPerGram: 0.01, ...over,
});
const CREAM = mat('Cream', { colorHex: 'F2E9D8' });
const BLUE = mat('Blue', { colorHex: '#1e5aa8' });
const RED = mat('Red', { colorHex: 'C0392B' });
const WHITE = mat('White', { colorHex: 'FFFFFF' });

const part = (colorIndex: number, material: MaterialLite | null, perUnitGrams = 1): PartSlot => ({ colorIndex, material, perUnitGrams });
const tool = (index: number, colorHex: string | null, grams: number): FileTool => ({ index, colorHex, grams });
const sum = (xs: Array<{ gramsUsed: number }>) => xs.reduce((s, x) => s + x.gramsUsed, 0);
const indexes = (xs: Array<{ colorIndex: number }>) => xs.map((x) => x.colorIndex);

// "BE THE RED FISH v3.0 engraved white reveal 60-23": four tools, 97.82 g.
const FISH_TOOLS = [tool(0, 'F2E9D8', 40), tool(1, '1E5AA8', 20), tool(2, 'C0392B', 30), tool(3, 'FFFFFF', 7.82)];

describe('SINGLE (a single-material part)', () => {
  it('books every gram on its one slot, and warns when the file prints several filaments', () => {
    const out = matchPlateSlots('Red fish', [part(0, WHITE, 5)], FISH_TOOLS, 97.82, []);
    expect(out.match).toBe('SINGLE');
    expect(out.slots).toHaveLength(1);
    expect(out.slots[0]).toMatchObject({ colorIndex: 0, gramsUsed: 97.82 });
    expect(out.slots[0].tools).toHaveLength(4);
    expect(out.warnings).toEqual([{ code: 'PLATE_EXTRA_FILAMENTS', message: '"Red fish" has one filament but the file prints 4 — all 97.82 g are booked on PLA White' }]);
  });

  it('one tool → no warning', () => {
    expect(matchPlateSlots('Box', [part(0, WHITE)], [tool(2, 'FFFFFF', 110)], 112.18, []).warnings).toEqual([]);
  });
});

describe('FILE_COLOURS', () => {
  it("matches each tool to the filament of its colour, whatever the order", () => {
    const S = [part(0, WHITE), part(1, RED), part(2, BLUE), part(3, CREAM)];
    const out = matchPlateSlots('Fish', S, FISH_TOOLS, 97.82, []);
    expect(out.match).toBe('FILE_COLOURS');
    expect(out.warnings).toEqual([]);
    expect(out.slots.map((s) => [s.colorIndex, s.gramsUsed, s.tools.map((t) => t.index)])).toEqual([
      [0, 7.82, [3]], [1, 30, [2]], [2, 20, [1]], [3, 40, [0]],
    ]);
    expect(out.slots[2].colour).toEqual({ hex: '1E5AA8', source: 'FILAMENT', swatch: null, name: null });
  });

  it('a filament without a hex is coloured by its catalogue swatch (brand + colour name)', () => {
    const jade = mat('Jade', { brand: 'Bambu Lab', color: 'Jade White', type: 'PLA' });
    const swatches = [{ brand: 'Bambu Lab', colour: 'Jade White', type: 'PLA', hex: '#FFFFFF' }];
    const out = matchPlateSlots('Lid', [part(0, jade), part(1, RED)], [tool(0, 'C0392B', 3), tool(1, 'FFFFFF', 9)], 12, swatches);
    expect(out.match).toBe('FILE_COLOURS');
    expect(out.slots[0]).toMatchObject({ gramsUsed: 9, colour: { hex: 'FFFFFF', source: 'CATALOGUE', swatch: 'Bambu Lab Jade White PLA' } });
    expect(out.slots[1]).toMatchObject({ gramsUsed: 3, colour: { source: 'FILAMENT' } });
  });

  it('failing that, by its colour name (the palette word of the tool colour)', () => {
    const navy = mat('Navy', { color: 'Navy Blue' });
    expect(slotColourOf(navy, [])).toEqual({ hex: null, source: 'NAME', swatch: null, name: 'Navy' });
    const out = matchPlateSlots('Lid', [part(0, WHITE), part(1, navy)], [tool(0, 'FFFFFF', 6), tool(1, '000080', 2)], 8, []);
    expect(out.match).toBe('FILE_COLOURS');
    expect(out.slots[1]).toMatchObject({ gramsUsed: 2, colour: { source: 'NAME' } });
  });

  it('several tools of one colour go to the same slot', () => {
    const out = matchPlateSlots('Lid', [part(0, WHITE), part(1, BLUE)], [tool(0, 'FFFFFF', 4), tool(1, '1E5AA8', 2), tool(2, 'FAFAFA', 4)], 10, []);
    expect(out.match).toBe('FILE_COLOURS');
    expect(out.slots.map((s) => [s.gramsUsed, s.tools.map((t) => t.index)])).toEqual([[8, [0, 2]], [2, [1]]]);
  });
});

describe('fallbacks', () => {
  it('two filaments known only by the same colour word are ambiguous → by position', () => {
    const S = [part(0, mat('A', { color: 'Red' })), part(1, mat('B', { color: 'Crimson Red' }))];
    const out = matchPlateSlots('Tin', S, [tool(0, 'FF0000', 6), tool(1, 'FF0000', 2)], 16, []);
    expect(out.match).toBe('FILE_ORDER');
    expect(out.slots.map((s) => s.gramsUsed)).toEqual([12, 4]);
    expect(out.warnings.map((w) => w.code)).toEqual(['PLATE_COLOURS_BY_POSITION']);
    expect(out.warnings[0].message).toBe('"Tin": the file\'s colours couldn\'t be matched to its filaments — matched by position (tool 1 → colour 1, …)');
  });

  it("colours that match no filament, with the file's tools on the part's colour numbers → by position", () => {
    const out = matchPlateSlots('Lid', [part(0, WHITE), part(1, BLUE)], [tool(0, '00FF00', 3), tool(1, 'FF00FF', 1)], 8, []);
    expect(out.match).toBe('FILE_ORDER');
    expect(out.slots.map((s) => s.gramsUsed)).toEqual([6, 2]);
  });

  it('a tool without a colour cannot be matched by colour', () => {
    const out = matchPlateSlots('Lid', [part(0, WHITE), part(1, BLUE)], [tool(0, null, 3), tool(1, '1E5AA8', 1)], 8, []);
    expect(out.match).toBe('FILE_ORDER');
  });

  it("otherwise the part's per-unit split, with a warning", () => {
    const out = matchPlateSlots('Lid', [part(0, WHITE, 5.2), part(1, BLUE, 0.8)], [tool(0, '00FF00', 3), tool(3, 'FF00FF', 1)], 120, []);
    expect(out.match).toBe('SPLIT');
    expect(out.slots.map((s) => s.gramsUsed)).toEqual([104, 16]);
    expect(out.warnings).toEqual([{ code: 'PLATE_COLOURS_SPLIT', message: '"Lid": the file\'s filaments don\'t match its colours — filament per colour is split like one unit' }]);
  });

  it('no file tools → the per-unit split, no warning; an equal split when the part has no grams per colour', () => {
    const a = matchPlateSlots('Lid', [part(0, WHITE, 5.2), part(1, BLUE, 0.8)], [], 120, []);
    expect(a).toMatchObject({ match: 'SPLIT', warnings: [] });
    expect(a.slots.map((s) => s.gramsUsed)).toEqual([104, 16]);
    const b = matchPlateSlots('Lid', [part(0, WHITE, 0), part(1, BLUE, 0), part(2, RED, 0)], [], 30, []);
    expect(b.slots.map((s) => s.gramsUsed)).toEqual([10, 10, 10]);
  });
});

it("always one slot per part colour, and the slots add up to the plate's grams", () => {
  const S = [part(0, WHITE, 1.2), part(1, RED, 0.3), part(3, CREAM, 0.7)];
  const cases: FileTool[][] = [
    [], FISH_TOOLS, [tool(0, 'FFFFFF', 1), tool(1, 'C0392B', 1), tool(3, 'F2E9D8', 1)],
    [tool(0, '00FF00', 3), tool(1, 'FF00FF', 1), tool(3, '0000FF', 1)], [tool(7, null, 2)],
  ];
  for (const T of cases) {
    const out = matchPlateSlots('Fish', S, T, 36.37, []);
    expect(indexes(out.slots)).toEqual([0, 1, 3]);
    expect(Math.abs(sum(out.slots) - 36.37)).toBeLessThanOrEqual(0.01 * out.slots.length);
  }
});
