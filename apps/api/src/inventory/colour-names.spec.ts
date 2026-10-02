import { approxColourHex, COLOUR_RGB, colourToRgb, SHADE_RGB } from '@printforge/types';
import { COLOUR_RGB as API_COLOUR_RGB, colourToRgb as apiColourToRgb } from '../common/utils/colour';

/** v2.17.3: a filament with a colour name but no hex gets an approximate dot. */
describe('approxColourHex', () => {
  const hexOf = (rgb: [number, number, number]) => rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

  it.each([
    ['Red', 'FF0000'],
    ['Fire Engine Red', hexOf(SHADE_RGB['Fire Engine Red'])],
    ['Haze Blue', hexOf(SHADE_RGB['Haze Blue'])],
    ['Light Blue', hexOf(SHADE_RGB['Light Blue'])],
    ['Cold White', hexOf(SHADE_RGB['Cold White'])],
    ['Bone White', hexOf(SHADE_RGB['Bone White'])],
    ['Matcha Green', hexOf(SHADE_RGB.Matcha)],
    ['Peach Pink', hexOf(SHADE_RGB['Peach Pink'])],
    ['Light Khaki', hexOf(SHADE_RGB['Light Khaki'])],
    ['Glowing Green', hexOf(SHADE_RGB['Glowing Green'])],
    ['Light Yellow', hexOf(SHADE_RGB['Light Yellow'])],
    ['Eggplant', hexOf(SHADE_RGB.Eggplant)],
    ['Violet', hexOf(SHADE_RGB.Violet)],
    ['Marble', hexOf(SHADE_RGB.Marble)],
    ['Dark Grey', hexOf(SHADE_RGB['Dark Grey'])],
    ['Gray', '808080'],
    ['Navy Blue', '000080'],
  ])('%s → %s (longest phrase wins)', (name, hex) => {
    expect(approxColourHex(name)).toBe(hex);
  });

  it('is case-insensitive and ignores punctuation', () => {
    expect(approxColourHex('  HAZE-blue ')).toBe(approxColourHex('Haze Blue'));
    expect(approxColourHex('fire engine red')).toBe(approxColourHex('Fire Engine Red'));
  });

  it('reads the colour word out of a filament name ("PLA Beige", "Jamg HE PLA Cyan")', () => {
    expect(approxColourHex('PLA Beige')).toBe(hexOf(COLOUR_RGB.Beige));
    expect(approxColourHex('Jamg HE PLA Cyan')).toBe(hexOf(COLOUR_RGB.Cyan));
    expect(approxColourHex('PLA Natural')).toBe(hexOf(COLOUR_RGB.Natural));
  });

  it('whole words only: "Tan" is not found inside "Transparent", "Red" not inside "Bored"', () => {
    expect(approxColourHex('Bored')).toBeNull();
    expect(approxColourHex('Transparent')).toBeNull();
  });

  it('"Transparent X" is X, tinted lighter', () => {
    const red = approxColourHex('Transparent Red')!;
    expect(red).toBe('FF7373');
    const purple = approxColourHex('Transparent Purple')!;
    expect(purple).not.toBe(hexOf(COLOUR_RGB.Purple));
    expect(parseInt(purple.slice(0, 2), 16)).toBeGreaterThan(COLOUR_RGB.Purple[0]);
  });

  it('unknown or blank names stay null (the dot stays hollow)', () => {
    expect(approxColourHex('Galaxy Sparkle')).toBeNull();
    expect(approxColourHex('')).toBeNull();
    expect(approxColourHex(null)).toBeNull();
    expect(approxColourHex(undefined)).toBeNull();
  });

  it('always returns bare upper-case six-digit hex', () => {
    for (const name of [...Object.keys(COLOUR_RGB), ...Object.keys(SHADE_RGB)]) {
      expect(approxColourHex(name)).toMatch(/^[0-9A-F]{6}$/);
      expect(approxColourHex(`Transparent ${name}`)).toMatch(/^[0-9A-F]{6}$/);
    }
  });
});

describe('the matching palette is shared, not duplicated, and unchanged', () => {
  it('the api re-exports the same table and lookup', () => {
    expect(API_COLOUR_RGB).toBe(COLOUR_RGB);
    expect(apiColourToRgb).toBe(colourToRgb);
  });

  it('keeps its 19 words, and the shade names never leak into matching', () => {
    expect(Object.keys(COLOUR_RGB)).toHaveLength(19);
    expect(colourToRgb('Navy Blue')).toEqual([0, 0, 128]);
    expect(colourToRgb('Haze Blue')).toEqual([0, 0, 255]);
    expect(colourToRgb('Matcha')).toBeNull();
  });
});
