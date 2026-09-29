import { identityFields, initialIdentity, otherModeFor, type CatalogueSwatchRef } from '@printforge/types';

/** Safety spec §4: how Edit Material opens a stored filament in the frozen dropdowns, and what a save sends. */

/** The same rule as the picker's toMaterialType (filament-swatch-picker.tsx), which apps/api can't import. */
const toType = (catalogueType: string) => {
  const t = (catalogueType || '').toUpperCase();
  return ['PETG', 'NYLON', 'RESIN', 'ASA', 'TPU', 'ABS', 'PLA'].find((k) => t.includes(k)) ?? 'OTHER';
};

const swatches: CatalogueSwatchRef[] = [
  { type: 'PLA', brand: 'eSUN', colour: 'Red' },
  { type: 'PLA Matte', brand: 'eSUN', colour: 'Black' },
  { type: 'PLA', brand: 'Polymaker', colour: 'Blue' },
  { type: 'PETG', brand: 'Bambu Lab', colour: 'Green' },
];

const mode = (type: string, brand: string, colour: string, list: CatalogueSwatchRef[] = swatches) =>
  otherModeFor({ swatches: list, toType, type, brand, colour });

describe('otherModeFor', () => {
  it('a listed brand and colour opens with both dropdowns selected', () => {
    expect(mode('PLA', 'eSUN', 'Red')).toBe('none');
    // A catalogue sub-type ('PLA Matte') counts as the material type it maps to.
    expect(mode('PLA', 'eSUN', 'Black')).toBe('none');
  });

  it('a brand with no swatch of this type opens Brand on Other', () => {
    expect(mode('PLA', 'Bambu Lab', 'Green')).toBe('brand');
    expect(mode('PLA', 'Hand Typed Co', '')).toBe('brand');
  });

  it("the brand compares exactly, as the select does: 'esun' is not 'eSUN'", () => {
    expect(mode('PLA', 'esun', 'Red')).toBe('brand');
  });

  it('a listed brand with an unlisted colour opens Color on Other', () => {
    expect(mode('PLA', 'eSUN', 'Fire Engine Red')).toBe('colour');
    // Listed for another brand of the type is not listed for this brand.
    expect(mode('PLA', 'eSUN', 'Blue')).toBe('colour');
    // Exact comparison here too.
    expect(mode('PLA', 'eSUN', 'red')).toBe('colour');
  });

  it('with no brand, a colour listed under any brand of the type is offered', () => {
    expect(mode('PLA', '', 'Blue')).toBe('none');
    expect(mode('PLA', '', 'Green')).toBe('colour');
  });

  it('with an empty catalogue (unreachable), non-empty values open on Other', () => {
    expect(mode('PLA', 'eSUN', 'Red', [])).toBe('brand');
    expect(mode('PLA', '', 'Red', [])).toBe('colour');
    expect(mode('PLA', '', '', [])).toBe('none');
  });

  it('all empty opens on Select… for both', () => {
    expect(mode('PLA', '', '')).toBe('none');
  });
});

describe('identityFields', () => {
  it('sends nothing while the user has not changed brand or colour', () => {
    expect(identityFields({ dirty: false, brand: 'eSUN', colour: 'Red', hex: '91202B' })).toBeNull();
  });

  it('sends trimmed strings with a bare hex once dirty', () => {
    expect(identityFields({ dirty: true, brand: ' eSUN ', colour: ' Fire Engine Red ', hex: '#91202B' }))
      .toEqual({ brand: 'eSUN', color: 'Fire Engine Red', colorHex: '91202B' });
  });

  it("keeps empty values as '' (the server stores them as null)", () => {
    expect(identityFields({ dirty: true, brand: '', colour: '  ', hex: '' }))
      .toEqual({ brand: '', color: '', colorHex: '' });
  });
});

describe('initialIdentity', () => {
  it('starts from the stored values, not dirty', () => {
    expect(initialIdentity({ brand: 'eSUN', color: 'Red', colorHex: '91202B' }))
      .toEqual({ dirty: false, brand: 'eSUN', colour: 'Red', hex: '91202B' });
  });

  it("maps a null or missing brand, colour or hex to ''", () => {
    expect(initialIdentity({ brand: null, color: null, colorHex: null }))
      .toEqual({ dirty: false, brand: '', colour: '', hex: '' });
    expect(initialIdentity({})).toEqual({ dirty: false, brand: '', colour: '', hex: '' });
  });
});
