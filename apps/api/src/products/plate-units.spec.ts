import {
  detectionPrefill,
  detectPlateUnits,
  gcodePlateFigures,
  parsePlateUnits,
  perUnitFigures,
  plateLinkLabel,
  plateUnitsPrefill,
  plateUnitsProblem,
} from '@printforge/types';

/** Owner request: an uploaded plate G-code is scanned for the units on it. */

describe('detectPlateUnits', () => {
  it('reads twelve of one model as one part ×12', () => {
    expect(detectPlateUnits({ objectCount: 12, objectModels: [{ model: 'keychain', count: 12 }] })).toEqual({ kind: 'UNITS', units: 12 });
  });

  it('treats a count without model names as one part', () => {
    expect(detectPlateUnits({ objectCount: 6, objectModels: [] })).toEqual({ kind: 'UNITS', units: 6 });
    expect(detectPlateUnits({ objectCount: 6 })).toEqual({ kind: 'UNITS', units: 6 });
  });

  it('reads one object as a single unit', () => {
    expect(detectPlateUnits({ objectCount: 1, objectModels: [{ model: 'vase', count: 1 }] })).toEqual({ kind: 'SINGLE' });
  });

  it('reports a plate of different models as mixed, never as units', () => {
    const models = [{ model: 'body', count: 6 }, { model: 'lid', count: 6 }];
    expect(detectPlateUnits({ objectCount: 12, objectModels: models })).toEqual({ kind: 'MIXED', objectCount: 12, models });
  });

  it('is unknown without labels or with a count outside 1–500', () => {
    for (const objectCount of [null, undefined, 0, -3, 2.5, 501, Number.NaN]) {
      expect(detectPlateUnits({ objectCount, objectModels: [] })).toEqual({ kind: 'UNKNOWN' });
    }
    expect(detectPlateUnits({ objectCount: 500 })).toEqual({ kind: 'UNITS', units: 500 });
  });
});

describe('plateUnitsPrefill', () => {
  it('prefills only a count that is one part\'s units', () => {
    expect(plateUnitsPrefill({ objectCount: 12, objectModels: [{ model: 'a', count: 12 }] })).toBe('12');
    expect(plateUnitsPrefill({ objectCount: 1 })).toBe('1');
    expect(plateUnitsPrefill({ objectCount: null })).toBe('');
    expect(plateUnitsPrefill({ objectCount: 4, objectModels: [{ model: 'a', count: 2 }, { model: 'b', count: 2 }] })).toBe('');
  });

  it('gives the same text from a detection already made', () => {
    expect(detectionPrefill({ kind: 'UNITS', units: 8 })).toBe('8');
    expect(detectionPrefill({ kind: 'SINGLE' })).toBe('1');
    expect(detectionPrefill({ kind: 'UNKNOWN' })).toBe('');
    expect(detectionPrefill({ kind: 'MIXED', objectCount: 2, models: [] })).toBe('');
  });
});

describe('parsePlateUnits', () => {
  it('accepts whole numbers 1–500 and empty', () => {
    expect(parsePlateUnits('')).toBeNull();
    expect(parsePlateUnits('  ')).toBeNull();
    expect(parsePlateUnits('12')).toBe(12);
    expect(parsePlateUnits(' 500 ')).toBe(500);
  });

  it('rejects zero, negatives, decimals, overlarge and text as NaN', () => {
    for (const raw of ['0', '-1', '2.5', '501', '1e2', 'twelve', 'Infinity']) expect(parsePlateUnits(raw)).toBeNaN();
  });
});

describe('gcodePlateFigures / perUnitFigures', () => {
  it('uses the header total and whole minutes, as the import does', () => {
    expect(gcodePlateFigures({ filamentUsedGrams: 111.6, estimatedTimeSeconds: 14_430, tools: [] })).toEqual({ grams: 111.6, minutes: 241 });
  });

  it('falls back to the tools\' grams and treats missing time as 0', () => {
    const tools = [{ filamentGrams: 10 }, { filamentGrams: 5.5 }, { filamentGrams: 0 }, {}];
    expect(gcodePlateFigures({ filamentUsedGrams: null, estimatedTimeSeconds: null, tools })).toEqual({ grams: 15.5, minutes: 0 });
    expect(gcodePlateFigures({ filamentUsedGrams: 0, estimatedTimeSeconds: 0, tools: null })).toEqual({ grams: 0, minutes: 0 });
  });

  it('splits a plate into one unit\'s share, rounded as stored', () => {
    expect(perUnitFigures({ grams: 111.6, minutes: 241 }, 12)).toEqual({ grams: 9.3, minutes: 20.1 });
    expect(perUnitFigures({ grams: 10, minutes: 10 }, 3)).toEqual({ grams: 3.33, minutes: 3.3 });
  });

  it('never divides by a bad count', () => {
    expect(perUnitFigures({ grams: 10, minutes: 10 }, 0)).toEqual({ grams: 10, minutes: 10 });
    expect(perUnitFigures({ grams: 10, minutes: 10 }, Number.NaN)).toEqual({ grams: 10, minutes: 10 });
  });
});

describe('plateUnitsProblem', () => {
  it('lets a single unit or no count through', () => {
    expect(plateUnitsProblem({ grams: 10, minutes: 0 }, null)).toBeNull();
    expect(plateUnitsProblem({ grams: 10, minutes: 0 }, 1)).toBeNull();
    expect(plateUnitsProblem({ grams: 10, minutes: 0 }, Number.NaN)).toBeNull();
  });

  it('refuses ×N without a print time, as the server does', () => {
    expect(plateUnitsProblem({ grams: 10, minutes: 0 }, 12)).toMatch(/No print time/);
    expect(plateUnitsProblem({ grams: 10, minutes: 30 }, 12)).toBeNull();
  });

  it('leaves an unsliced file (skipped by the import) alone', () => {
    expect(plateUnitsProblem({ grams: 0, minutes: 0 }, 12)).toBeNull();
  });
});

describe('plateLinkLabel', () => {
  it('reads "Calibrate plate" until the part has an active layout', () => {
    expect(plateLinkLabel([])).toBe('Calibrate plate');
    expect(plateLinkLabel([{ unitsPerPlate: 12, isActive: false }])).toBe('Calibrate plate');
  });

  it('lists the active layouts smallest first, once each', () => {
    expect(plateLinkLabel([{ unitsPerPlate: 12, isActive: true }])).toBe('Plate layouts (×12)');
    expect(plateLinkLabel([
      { unitsPerPlate: 12, isActive: true }, { unitsPerPlate: 6, isActive: true },
      { unitsPerPlate: 6, isActive: true }, { unitsPerPlate: 20, isActive: false },
    ])).toBe('Plate layouts (×6, ×12)');
  });
});
