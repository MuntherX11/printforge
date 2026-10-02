import { filamentMatchText, type SlicerFilament } from '@printforge/types';
import { slicerFilament } from '../file-parser/slicer-filament';
import { brandKey, colourKey, matchMaterial, newMaterialData, planFilamentSlots, resolveSlot, slotFilament, type MatchableMaterial } from './slicer-materials';

/** Owner spec: "the 3MF will already have the correct filaments set" — match by the file's own filament first. */

const mat = (id: string, name: string, brand: string | null, color: string | null, colorHex: string | null, type = 'PLA'): MatchableMaterial =>
  ({ id, name, type, brand, color, colorHex });

/** A slot as a G-code header gives it: profile, vendor, type, hex. */
const slot = (profile: string | null, vendor: string | null, hex: string | null, type = 'PLA') =>
  slotFilament(type, hex, slicerFilament(profile, vendor, type, hex) as SlicerFilament);

// A slice of the owner's filaments: brands spelt inconsistently, names ≠ colours, half without a hex.
const SHOP = [
  mat('esun-fer', 'PLA Red', 'eSun', 'Fire Engine Red', '91202B'),
  mat('poly-red', 'PolyTerra Red', 'Polymaker', 'Red', 'C12E1F'),
  mat('esun-bone', 'eSUN PLA', 'Esun', 'Bone White', 'F2E9D8'),
  mat('bambu-white', 'PLA Basic', 'Bambu Lab', 'White', 'FFFFFF'),
  mat('crea-white', 'Hyper PLA White', 'Creality', 'Cold White', 'FFFFFF'),
  mat('plamore-khaki', 'PLA Light Khaki', 'Plamore', 'Light Khaki', null),
  mat('jamg-matcha', 'PLA Matcha', 'Jamg HE', 'Matcha Green', null),
  mat('esun-haze', 'eSUN PLA+', 'eSUN', 'Haze Blue', '6F8FAF'),
  mat('creat-haze', 'PLA Haze', 'Creat3D', 'Haze Blue', '7090B0'),
  mat('petg-fer', 'PETG Red', 'eSun', 'Fire Engine Red', '91202B', 'PETG'),
];

const hit = (s: ReturnType<typeof slot>, list = SHOP) => {
  const m = matchMaterial(list, s);
  return m ? [m.material.id, m.how] : null;
};

describe('brand and colour normalisation', () => {
  it('brands compare case- and space-insensitively; Bambu = Bambu Lab; Generic and blank are no brand', () => {
    expect(['eSUN', 'eSun', 'Esun', ' E Sun '].map(brandKey)).toEqual(['esun', 'esun', 'esun', 'esun']);
    expect(['Bambu', 'Bambu Lab', 'BambuLab', 'bambu lab'].map(brandKey)).toEqual(['bambulab', 'bambulab', 'bambulab', 'bambulab']);
    expect(['Generic', '(Undefined)', '', null].map(brandKey)).toEqual([null, null, null, null]);
    expect(brandKey('Jamg HE')).toBe(brandKey('JAMG he'));
  });

  it('colour names ignore case, spacing, line words and grey/gray', () => {
    expect(colourKey('Fire  Engine red')).toBe('fire engine red');
    expect(colourKey('Matte Ivory White')).toBe(colourKey('ivory white'));
    expect(colourKey('Grey')).toBe(colourKey('Gray'));
    expect(colourKey('Basic')).toBeNull();
  });
});

describe('match order', () => {
  it('1 brand + colour name + type, before an exact hex of another brand (NAME)', () => {
    expect(hit(slot('eSUN PLA+ Fire Engine Red @BBL X1C', 'eSUN', '#C12E1F'))).toEqual(['esun-fer', 'NAME']);
  });

  it('1 the brand decides between two filaments with the same colour name', () => {
    expect(hit(slot('Creat3D PLA Haze Blue', 'Creat3D', '#000000'))).toEqual(['creat-haze', 'NAME']);
    expect(hit(slot('eSUN PLA+ Haze Blue', 'ESUN', '#000000'))).toEqual(['esun-haze', 'NAME']);
  });

  it('1 the colour name of a filament without one comes from its name ("PLA Red")', () => {
    const list = [mat('x', 'PLA Peach Pink', 'eSUN', null, null)];
    expect(hit(slot('eSUN PLA+ Peach Pink', 'eSun', '#F5B6A5'), list)).toEqual(['x', 'NAME']);
  });

  it('2 same type + exact hex, the slot brand first (HEX)', () => {
    expect(hit(slot('Bambu PLA Basic @BBL X1C', 'Bambu Lab', '#FFFFFF'))).toEqual(['bambu-white', 'HEX']);
    expect(hit(slot('Hyper PLA @Creality Hi 0.4 nozzle', 'Creality', '#FFFFFF'))).toEqual(['crea-white', 'HEX']);
    expect(hit(slot('Generic PLA', 'Generic', '#FFFFFF'))).toEqual(['bambu-white', 'HEX']);
  });

  it('3 same brand + same type + nearest ΔE ≤ 10, even when another brand is nearer (BRAND_CLOSEST)', () => {
    expect(hit(slot('eSUN PLA+ @System', 'eSUN', '#951F2C'))).toEqual(['esun-fer', 'BRAND_CLOSEST']);
    expect(hit(slot('Polymaker PLA', 'Polymaker', '#C02A22'))).toEqual(['poly-red', 'BRAND_CLOSEST']);
    // B32323 is ΔE 0.4 from the Polymaker red and 1.1 from the eSun one: the eSUN slot still takes eSun.
    const reds = [mat('poly', 'PLA Red', 'Polymaker', 'Red', 'B42424'), mat('esun', 'PLA Red', 'eSun', 'Red', 'B02020')];
    expect(hit(slot('eSUN PLA+ @System', 'eSUN', '#B32323'), reds)).toEqual(['esun', 'BRAND_CLOSEST']);
    expect(hit(slot('Sunlu PLA', 'SUNLU', '#B32323'), reds)).toEqual(['poly', 'CLOSEST']);
  });

  it('4 same type + nearest ΔE ≤ 10 of any brand (CLOSEST)', () => {
    expect(hit(slot('Sunlu PLA', 'SUNLU', '#C02A22'))).toEqual(['poly-red', 'CLOSEST']);
  });

  it('5 same type + colour name of any brand (COLOUR_NAME)', () => {
    expect(hit(slot('Elegoo PLA Matcha Green', 'Elegoo', '#00FF00'))).toEqual(['jamg-matcha', 'COLOUR_NAME']);
    expect(hit(slot('Elegoo PLA Light Khaki', 'Elegoo', null))).toEqual(['plamore-khaki', 'COLOUR_NAME']);
  });

  it('6 a file with no colour at all takes the first of the type by name, its brand first (TYPE_ONLY)', () => {
    expect(hit(slot('eSUN PLA+', 'eSUN', null))).toEqual(['esun-bone', 'TYPE_ONLY']);
  });

  it('otherwise no match; the type always has to agree', () => {
    expect(hit(slot('eSUN PLA+ Peach Pink', 'eSUN', '#F5B6A5'))).toBeNull();
    expect(hit(slot('eSUN PETG Haze Blue', 'eSUN', '#6F8FAF', 'PETG'))).toBeNull();
    expect(hit(slot('eSUN PETG Fire Engine Red', 'eSUN', '#00FF00', 'PETG'))).toEqual(['petg-fer', 'NAME']);
  });
});

describe('what an unmatched slot creates', () => {
  it('a vendor\'d profile with a colour name: the vendor as brand, the profile as name, the file hex, cost 0', () => {
    expect(newMaterialData(slot('eSUN PLA+ Peach Pink @BBL X1C', 'eSUN', '#F5B6A5'))).toEqual({
      name: 'eSUN PLA+ Peach Pink', type: 'PLA', brand: 'eSUN', color: 'Peach Pink', colorHex: 'F5B6A5', costPerGram: 0, density: 1.24,
    });
  });

  it('the vendor is not repeated when the profile already names it (Bambu PLA … for Bambu Lab)', () => {
    expect(newMaterialData(slot('Bambu PLA Grey Matte(coffee side B.3mf)', 'Bambu Lab', '#8E9089'))).toMatchObject({
      name: 'Bambu PLA Grey Matte', brand: 'Bambu Lab', color: 'Grey',
    });
  });

  it('the brand is spelt as the shop already spells it', () => {
    expect(newMaterialData(slot('eSUN PLA+ Peach Pink', 'ESUN', '#F5B6A5'), SHOP).brand).toBe('eSun');
  });

  it('a profile that names no colour: the nearest colour word, and never a brandless "PLA Beige"', () => {
    expect(newMaterialData(slot('eSUN PLA+ @System', 'eSUN', '#F5DEB3'))).toMatchObject({ name: 'eSUN PLA+ Beige', brand: 'eSUN', color: 'Beige' });
    expect(newMaterialData(slot('Hyper PLA @Creality Hi 0.4 nozzle', 'Creality', '#00CED1'))).toMatchObject({ name: 'Creality Hyper PLA Cyan', brand: 'Creality' });
    expect(newMaterialData(slot('Generic PLA', 'Generic', '#F5DEB3'))).toMatchObject({ name: 'Generic PLA Beige', brand: null });
  });

  it('a file with no vendor and no profile keeps the old name', () => {
    expect(newMaterialData(slotFilament('PLA', '#F5DEB3'))).toMatchObject({ name: 'PLA Beige', brand: null, color: 'Beige' });
  });

  it('an identity that already exists (brand + type + colour) is reused, not created (SAME_IDENTITY)', () => {
    const list = [mat('esun-pink', 'eSun PLA Pink', 'eSun', 'Pink', null)];
    const r = resolveSlot(list, slot('eSUN PLA+ @System', 'eSUN', '#FFBDC4'));
    expect([r.material?.id, r.how, r.create]).toEqual(['esun-pink', 'SAME_IDENTITY', null]);
  });
});

describe('the import plan shown before an import', () => {
  it('maps every slot; a new filament made for one slot serves the next one too', () => {
    const plan = planFilamentSlots(SHOP, [
      { index: 0, rawType: 'PLA', rawHex: '#C12E1F', file: slicerFilament('eSUN PLA+ Fire Engine Red @BBL X1C', 'eSUN', 'PLA', '#C12E1F') },
      { index: 1, rawType: 'PLA', rawHex: '#F5B6A5', file: slicerFilament('eSUN PLA+ Peach Pink @BBL X1C', 'eSUN', 'PLA', '#F5B6A5') },
      { index: 2, rawType: 'PLA', rawHex: '#F5B6A5', file: slicerFilament('eSUN PLA+ Peach Pink @BBL X1C', 'eSUN', 'PLA', '#F5B6A5') },
      { index: 3, rawType: 'PLA', rawHex: '#C02A22', file: null },
    ]);
    expect(plan.map(filamentMatchText)).toEqual([
      'eSUN PLA+ Fire Engine Red → your eSun PLA Fire Engine Red (exact)',
      'eSUN PLA+ Peach Pink → new filament eSUN PLA+ Peach Pink (cost 0 — set it after)',
      'eSUN PLA+ Peach Pink → new filament eSUN PLA+ Peach Pink (cost 0 — set it after)',
      'PLA #C02A22 → your Polymaker PLA Red (closest colour)',
    ]);
    expect(plan[0].material).toEqual({ id: 'esun-fer', name: 'PLA Red', type: 'PLA', brand: 'eSun', color: 'Fire Engine Red', colorHex: '91202B' });
  });
});

describe('nameColourForHex', () => {
  it('names a sardine red by perceptual distance, not RGB distance', () => {
    const { nameColourForHex } = require('./slicer-materials');
    expect(nameColourForHex('CC3A2F')).toBe('Fire Engine Red');
    expect(nameColourForHex('F2E9D8')).toMatch(/White|Beige|Ivory/);
    expect(nameColourForHex('000000')).toBe('Black');
  });
});
