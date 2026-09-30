import { catalogueSwatchFor, normSwatch } from './catalogue-swatch';
import { FilamentCatalogService } from './filament-catalog.service';

const SWATCHES = [
  { brand: 'Bambu Lab', colour: 'Jade White', type: 'PETG', hex: 'F0F0E8' },
  { brand: 'Bambu Lab', colour: 'Jade White', type: 'PLA', hex: 'FFFFFF' },
  { brand: 'eSUN', colour: 'Fire-Engine Red', type: 'PLA+', hex: '91202B' },
  { brand: 'Polymaker', colour: 'Jade White', type: 'PLA', hex: 'EEEEEE' },
];

describe('catalogueSwatchFor', () => {
  it('matches brand and colour ignoring case and punctuation', () => {
    expect(catalogueSwatchFor({ brand: 'ESUN', color: 'fire engine red', type: 'PLA' }, SWATCHES)?.hex).toBe('91202B');
    expect(catalogueSwatchFor({ brand: 'bambu-lab', color: 'JADE WHITE', type: null }, SWATCHES)?.brand).toBe('Bambu Lab');
  });

  it('prefers the same filament type, else the first of the brand and colour', () => {
    expect(catalogueSwatchFor({ brand: 'Bambu Lab', color: 'Jade White', type: 'PLA' }, SWATCHES)?.hex).toBe('FFFFFF');
    expect(catalogueSwatchFor({ brand: 'Bambu Lab', color: 'Jade White', type: 'ABS' }, SWATCHES)?.hex).toBe('F0F0E8');
  });

  it('a missing brand or colour → null (never a guess from the name alone)', () => {
    expect(catalogueSwatchFor({ brand: null, color: 'Jade White', type: 'PLA' }, SWATCHES)).toBeNull();
    expect(catalogueSwatchFor({ brand: 'Bambu Lab', color: '  ', type: 'PLA' }, SWATCHES)).toBeNull();
  });

  it('the brand with another colour → null', () => {
    expect(catalogueSwatchFor({ brand: 'eSUN', color: 'Jade White', type: 'PLA' }, SWATCHES)).toBeNull();
    expect(catalogueSwatchFor({ brand: 'Sunlu', color: 'Jade White', type: 'PLA' }, SWATCHES)).toBeNull();
  });

  it('normSwatch keeps letters and digits only', () => {
    expect(normSwatch(' Bambu Lab ')).toBe('bambulab');
    expect(normSwatch('PLA+')).toBe('pla');
    expect(normSwatch(null)).toBe('');
  });
});

describe('FilamentCatalogService.suggestHexForMaterials (uses catalogueSwatchFor; behaviour unchanged)', () => {
  const materials = [
    { id: 'm1', name: 'PLA Jade', type: 'PLA', color: 'Jade White', brand: 'Bambu Lab' },
    { id: 'm2', name: 'ABS Jade', type: 'ABS', color: 'Jade White', brand: 'Bambu Lab' },
    { id: 'm3', name: 'No brand', type: 'PLA', color: 'Red', brand: null },
    { id: 'm4', name: 'Unknown', type: 'PLA', color: 'Mauve', brand: 'eSUN' },
  ];
  const prisma = {
    material: { findMany: jest.fn(async () => materials) },
    filamentCatalog: { findMany: jest.fn(async () => SWATCHES) },
  };

  it('proposes brand + colour swatches, exact only when the type agrees, and says why the rest are unmatched', async () => {
    const out = await new FilamentCatalogService(prisma as never).suggestHexForMaterials();
    expect(out.candidates).toEqual([
      { materialId: 'm1', material: 'Jade White · PLA · Bambu Lab', hex: 'FFFFFF', swatch: 'Bambu Lab Jade White PLA', exact: true },
      { materialId: 'm2', material: 'Jade White · ABS · Bambu Lab', hex: 'F0F0E8', swatch: 'Bambu Lab Jade White PETG', exact: false },
    ]);
    expect(out.unmatched.map((u: { id: string; reason: string }) => [u.id, u.reason])).toEqual([
      ['m3', 'no brand or colour recorded'],
      ['m4', 'no catalogue swatch for that brand and colour'],
    ]);
  });
});
