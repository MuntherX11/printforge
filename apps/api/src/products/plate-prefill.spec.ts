import { defaultPartFor, isConverted, plateCountInName, unitsPerPlatePrefill } from '@printforge/types';

/**
 * Convert to plate: the dialog's prefills (packages/types, pure), against the
 * production options of the owner's 30 Sep list (spec §9).
 */

describe('plateCountInName', () => {
  it.each([
    ['b50', 50], ['Box x 12', 12], ['top15', 15], ['zip 35', 35], ['f22', 22], ['fish 2', 2], ['c25', 25], ['23', 23],
  ])('%s → %s', (name, n) => expect(plateCountInName(name)).toBe(n));

  it.each(['fish 1', '60%', '0.4', 'PLA', '1 of 50', '600', 'Size 11 of 2', ''])('%s → null', (name) => {
    expect(plateCountInName(name)).toBeNull();
  });
});

describe('unitsPerPlatePrefill (band 0.5–3, rounded down)', () => {
  const p = (optionName: string, optionGrams: number | null, componentGrams: number | null, objectCount: number | null = null) =>
    unitsPerPlatePrefill({ optionName, optionGrams, componentGrams, objectCount });

  it('Chasen Clicker b50 on BASE (2.47 g) → 50 from the name (48 by weight)', () => {
    const r = p('b50', 120.77, 2.47);
    expect(r).toMatchObject({ units: 50, source: 'NAME' });
    expect(Math.floor(r.ratio!)).toBe(48);
  });

  it('Sardine fish 1 → 31 and fish 2 → 27 by weight (the "2" is 13.8× too heavy per unit)', () => {
    expect(p('fish 1', 89.4, 2.87)).toMatchObject({ units: 31, source: 'WEIGHT' });
    expect(p('fish 2', 78.99, 2.87)).toMatchObject({ units: 27, source: 'WEIGHT' });
  });

  it('zip 35 on pull tab (2.47× per unit, inside the band) → 35 NAME; top15 on Cover Graphics → 4 WEIGHT', () => {
    expect(p('zip 35', 84.82, 0.98)).toMatchObject({ units: 35, source: 'NAME' });
    expect(p('top15', 22.6, 0.98)).toMatchObject({ units: 15, source: 'NAME' });
    expect(p('top15', 22.6, 4.68)).toMatchObject({ units: 4, source: 'WEIGHT' });
  });

  it('real sizes get no number: Fish Keychain 50, Red Fish Keychain 60%', () => {
    expect(p('50', 2.05, 2.36)).toEqual({ units: null, source: null, ratio: 2.05 / 2.36 });
    expect(p('60%', 4.73, 5.33).units).toBeNull();
  });

  it('single-unit duplicates read 1 by weight (cover 1)', () => {
    expect(p('cover 1', 3.72, 3.72)).toMatchObject({ units: 1, source: 'WEIGHT' });
  });

  it("the file's object labels win", () => {
    expect(p('23', 97.82, 5, 23)).toMatchObject({ units: 23, source: 'FILE' });
    expect(p('b50', 120.77, 2.47, 12)).toMatchObject({ units: 12, source: 'FILE' });
  });

  it('a name count is taken as is without grams to compare; the weight is capped at 500; below 1 → null', () => {
    expect(p('b50', null, 2.47)).toEqual({ units: 50, source: 'NAME', ratio: null });
    expect(p('big', 5000, 1)).toMatchObject({ units: 500, source: 'WEIGHT' });
    expect(p('small', 1, 2)).toMatchObject({ units: null, source: null });
    expect(p('small', null, null)).toEqual({ units: null, source: null, ratio: null });
  });
});

describe('defaultPartFor', () => {
  const sardine = [
    { id: 'tab', description: 'pull tab' }, { id: 'gfx', description: 'Cover Graphics' }, { id: 'box', description: 'Box' },
    { id: 'fish', description: 'Fish' }, { id: 'base', description: 'Cover Base' },
  ];
  it('the only part whose words are all in the name', () => {
    expect(defaultPartFor('Box x 12', sardine)?.id).toBe('box');
    expect(defaultPartFor('fish 1', sardine)?.id).toBe('fish');
    expect(defaultPartFor('fish 2', sardine)?.id).toBe('fish');
  });
  it('none or several → null', () => {
    expect(defaultPartFor('cover 15', sardine)).toBeNull();
    expect(defaultPartFor('b50', [{ id: 'b', description: 'BASE' }, { id: 't', description: 'TOP' }])).toBeNull();
    expect(defaultPartFor('x', [])).toBeNull();
  });
  it('a product with one part → that part', () => {
    expect(defaultPartFor('23', [{ id: 'f', description: 'Red fish' }])?.id).toBe('f');
  });
});

it('isConverted: marked and the layout still exists', () => {
  expect(isConverted({ convertedTo: null })).toBe(false);
  expect(isConverted({ convertedTo: { layoutId: 'l', label: 'BASE ×50', layoutActive: false } })).toBe(true);
  expect(isConverted({ convertedTo: { layoutId: 'l', label: null, layoutActive: false } })).toBe(false);
});
