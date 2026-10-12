import { PROJECT_FILL_UNITS, pastFillUnits, projectFillUnits } from './fill-units';

/** "Fill the plate" for a project: 100 copies until a run shows how many fit, then that many + 2. */
describe('projectFillUnits', () => {
  const run = (unitsRequested: number, unitsSliced: number | null) => ({ unitsRequested, unitsSliced });

  it('no earlier run → 100', () => {
    expect(projectFillUnits([])).toBe(100);
    expect(PROJECT_FILL_UNITS).toBe(100);
  });

  it('a run that placed fewer units than asked for → those units + 2', () => {
    expect(projectFillUnits([run(100, 15)])).toBe(17);
    expect(projectFillUnits([run(17, 15)])).toBe(17);
  });

  it('runs that placed everything they were asked for say nothing about capacity', () => {
    expect(projectFillUnits([run(12, 12), run(4, 4)])).toBe(100);
    expect(projectFillUnits([run(12, 12), run(100, 15)])).toBe(17);
  });

  it('the newest run that hit capacity wins', () => {
    expect(projectFillUnits([run(100, 20), run(100, 15)])).toBe(22);
  });

  it('the 1-unit validation run (whose count is bodies, not units) and unreadable counts are ignored', () => {
    expect(projectFillUnits([run(1, 3), run(1, 1)])).toBe(100);
    expect(projectFillUnits([run(100, null), run(100, 0), run(100, 14.5), run(100, -2)])).toBe(100);
  });

  it('never asks for more than 100', () => {
    expect(projectFillUnits([run(500, 99)])).toBe(100);
    expect(projectFillUnits([run(500, 98)])).toBe(100);
    expect(projectFillUnits([run(500, 97)])).toBe(99);
    expect(projectFillUnits([run(500, 300)])).toBe(100);
  });

  it('no run has hit capacity: the footprint estimate, capped at 100; an unreadable estimate is 100', () => {
    expect(projectFillUnits([], 18)).toBe(18);
    expect(projectFillUnits([run(12, 12), run(1, 3)], 18)).toBe(18);
    expect(projectFillUnits([], 240)).toBe(100);
    expect(projectFillUnits([], 1)).toBe(1);
    for (const bad of [null, 0, -4, 7.5, NaN, Infinity]) expect(projectFillUnits([], bad)).toBe(100);
  });

  it('a run that hit capacity wins over the estimate', () => {
    expect(projectFillUnits([run(18, 15)], 18)).toBe(17);
    expect(pastFillUnits([run(18, 15)])).toBe(17);
    expect(pastFillUnits([run(12, 12)])).toBeNull();
  });
});
