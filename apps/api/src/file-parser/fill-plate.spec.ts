import {
  FILL_PLATE_DEFAULT_CAP,
  FILL_PLATE_DEFAULT_GAP_MM,
  FILL_PLATE_DEFAULT_MARGIN_PCT,
  fillPlateEstimate,
  printableAreaSize,
} from '@printforge/types';

/** The formula, spelled out, so each expectation below is derived from explicit values. */
function expected(bed: { x: number; y: number }, part: { x: number; y: number }, gap: number, marginPct: number): number {
  const upright = Math.floor(bed.x / (part.x + gap)) * Math.floor(bed.y / (part.y + gap));
  const rotated = Math.floor(bed.x / (part.y + gap)) * Math.floor(bed.y / (part.x + gap));
  return Math.ceil(Math.max(upright, rotated) * (1 + marginPct / 100));
}

// Orca printable_area of the owner's Ender-3 V3 (220 x 220).
const ENDER_AREA = ['0x0', '220x0', '220x220', '0x220'];
const ENDER = { x: 220, y: 220 };
const KEYCHAIN = { x: 40, y: 20 };

describe('fillPlateEstimate', () => {
  it('uses the documented defaults', () => {
    expect(FILL_PLATE_DEFAULT_GAP_MM).toBe(5);
    expect(FILL_PLATE_DEFAULT_MARGIN_PCT).toBe(20);
    expect(FILL_PLATE_DEFAULT_CAP).toBe(500);
  });

  it('keychain 40x20 on the Ender bed: floor(220/45) x floor(220/25) = 4 x 8 = 32 copies, +20 % = 39', () => {
    expect(Math.floor(220 / 45) * Math.floor(220 / 25)).toBe(32);
    expect(expected(ENDER, KEYCHAIN, 5, 20)).toBe(39);
    expect(fillPlateEstimate(KEYCHAIN, ENDER)).toBe(39);
    expect(fillPlateEstimate(KEYCHAIN, ENDER, { marginPct: 0 })).toBe(32);
  });

  it('parses Orca\'s 4-point printable_area string form', () => {
    expect(printableAreaSize(ENDER_AREA)).toEqual({ x: 220, y: 220 });
    expect(fillPlateEstimate(KEYCHAIN, ENDER_AREA)).toBe(fillPlateEstimate(KEYCHAIN, ENDER));
    // An offset origin still gives the bed's extent.
    expect(printableAreaSize(['-110x-110', '110x-110', '110x110', '-110x110'])).toEqual({ x: 220, y: 220 });
    // Case and whitespace are tolerated; a malformed point is not.
    expect(printableAreaSize(['0X0', ' 300 x 0 ', '300x300', '0x300'])).toEqual({ x: 300, y: 300 });
    expect(printableAreaSize(['0x0', 'wide'])).toBeNull();
    expect(printableAreaSize(['0x0'])).toBeNull();
  });

  it('takes the rotated orientation when it fits more', () => {
    const bed = { x: 100, y: 95 };
    // upright 40x20: floor(100/45)=2 x floor(95/25)=3 = 6; rotated 20x40: floor(100/25)=4 x floor(95/45)=2 = 8
    expect(Math.floor(100 / 45) * Math.floor(95 / 25)).toBe(6);
    expect(Math.floor(100 / 25) * Math.floor(95 / 45)).toBe(8);
    expect(fillPlateEstimate(KEYCHAIN, bed, { marginPct: 0 })).toBe(8);
    expect(fillPlateEstimate(KEYCHAIN, bed)).toBe(expected(bed, KEYCHAIN, 5, 20));
    expect(fillPlateEstimate(KEYCHAIN, bed)).toBe(10);
  });

  it('applies the margin and rounds up', () => {
    // 32 grid copies: x1.5 = 48; x1.03 = 32.96 → 33
    expect(fillPlateEstimate(KEYCHAIN, ENDER, { marginPct: 50 })).toBe(48);
    expect(fillPlateEstimate(KEYCHAIN, ENDER, { marginPct: 3 })).toBe(33);
  });

  it('honours the gap', () => {
    // gap 0: floor(220/40)=5 x floor(220/20)=11 = 55 (rotated the same), +20 % = 66
    expect(expected(ENDER, KEYCHAIN, 0, 20)).toBe(66);
    expect(fillPlateEstimate(KEYCHAIN, ENDER, { gapMm: 0 })).toBe(66);
  });

  it('caps at 500 by default, or at the given cap', () => {
    const tiny = { x: 1, y: 1 };
    // gap 0: 220 x 220 = 48400 copies before the margin.
    expect(fillPlateEstimate(tiny, ENDER, { gapMm: 0 })).toBe(500);
    expect(fillPlateEstimate(tiny, ENDER, { gapMm: 0, cap: 120 })).toBe(120);
  });

  it('never estimates below 1: a part larger than the bed, or a degenerate bbox or bed', () => {
    expect(fillPlateEstimate({ x: 300, y: 300 }, ENDER)).toBe(1);
    expect(fillPlateEstimate({ x: 0, y: 20 }, ENDER)).toBe(1);
    expect(fillPlateEstimate({ x: -40, y: 20 }, ENDER)).toBe(1);
    expect(fillPlateEstimate({ x: NaN, y: 20 }, ENDER)).toBe(1);
    expect(fillPlateEstimate({ x: Infinity, y: 20 }, ENDER)).toBe(1);
    expect(fillPlateEstimate(KEYCHAIN, { x: 0, y: 220 })).toBe(1);
    expect(fillPlateEstimate(KEYCHAIN, { x: NaN, y: 220 })).toBe(1);
    expect(fillPlateEstimate(KEYCHAIN, [])).toBe(1);
    expect(fillPlateEstimate(KEYCHAIN, ['0x0', '0x0', '0x0', '0x0'])).toBe(1);
    expect(fillPlateEstimate(KEYCHAIN, ['0x0', 'oops'])).toBe(1);
  });
});
