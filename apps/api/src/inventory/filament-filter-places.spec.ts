import { MaterialType, type FilamentStockRow, type FilamentStockSpool } from '@printforge/types';
import { catalog, ids, polyBlack, row, spool } from './__fixtures__/filament-rows';

/**
 * filterFilaments: location and colour-hex search. A location matches only
 * through ACTIVE spools, and a run of words that is part of a location name
 * ('shelf b') matches as one phrase, never word by word.
 */

describe('filterFilaments location and hex', () => {
  it("matches a location only through ACTIVE spools: the inactive spool in the 'Attic' does not match", () => {
    expect(ids(catalog, { q: 'attic' })).toEqual([]);
    expect(ids(catalog, { q: 'shelf b' })).toEqual(['poly-black']);
    const inactiveOnly = row('inactive-b', { color: 'Green', spools: [spool('PF-GRN2', { isActive: false, locationName: 'Shelf B' })] });
    expect(ids([inactiveOnly, polyBlack], { q: 'shelf b' })).toEqual(['poly-black']);
  });

  describe('a shelf name on shelves A to D', () => {
    const shelved = (id: string, extra: Partial<FilamentStockRow>, ...spools: FilamentStockSpool[]) => row(id, { ...extra, spools });
    const shelves = [
      shelved('white', { name: 'eSUN PLA White', color: 'White', brand: 'eSUN' }, spool('PF-WHT1', { locationName: 'Shelf B' })),
      shelved('black', { name: 'eSUN PLA Black', color: 'Black', brand: 'eSUN' }, spool('PF-BLK1', { locationName: 'Shelf A' })),
      shelved('abs-grey', { name: 'Polymaker ABS Grey', type: MaterialType.ABS, color: 'Grey', brand: 'Polymaker' }, spool('PF-GRY1', { locationName: 'Shelf C' })),
      shelved('bambu-green', { name: 'Bambu Lab PLA Green', color: 'Green', brand: 'Bambu Lab' }, spool('PF-GRN1', { locationName: 'Shelf A' })),
      shelved(
        'blue',
        { name: 'eSUN PLA Blue', color: 'Blue', brand: 'eSUN' },
        spool('PF-BLU1', { isActive: false, locationName: 'Shelf B' }),
        spool('PF-BLU2', { locationName: 'Shelf D' }),
      ),
    ];

    it("'shelf b' lists only the filament with an active spool on Shelf B, not Black, ABS, Bambu or Blue", () => {
      expect(ids(shelves, { q: 'shelf b' })).toEqual(['white']);
      expect(ids(shelves, { q: '  SHELF   B ' })).toEqual(['white']);
    });

    it('an inactive spool on Shelf B does not make its filament match, even with an active spool elsewhere', () => {
      expect(ids(shelves, { q: 'shelf b' })).not.toContain('blue');
      expect(ids(shelves, { q: 'shelf d' })).toEqual(['blue']);
    });

    it('a shelf name combines with other words: the shelf as a phrase, the rest word by word', () => {
      expect(ids(shelves, { q: 'shelf b white' })).toEqual(['white']);
      expect(ids(shelves, { q: 'shelf b black' })).toEqual([]);
      expect(ids(shelves, { q: 'black shelf a' })).toEqual(['black']);
      expect(ids(shelves, { q: 'esun shelf a' })).toEqual(['black']);
    });

    it("a single word still matches locations: 'shelf' lists every shelved filament", () => {
      expect(ids(shelves, { q: 'shelf' })).toHaveLength(5);
    });

    it('words that are not part of one location name are matched one by one', () => {
      // 'green shelf' is in no location: 'green' is the colour, 'shelf' any active shelf.
      expect(ids(shelves, { q: 'green shelf' })).toEqual(['bambu-green']);
    });
  });

  it.each(['#91202B', '91202b', '#91202b'])('%s matches the row whose colorHex is 91202B', (q) => {
    expect(ids(catalog, { q })).toEqual(['esun-red']);
  });

  it('a phrase that is part of a location still finds a filament whose own fields hold every word', () => {
    const bin = row('bin', { color: 'Red', spools: [spool('PF-BIN1', { locationName: 'Silk Gold Bin' })] });
    const gold = row('silk-gold', { name: 'eSUN PLA Silk Gold', color: 'Silk Gold', brand: 'eSUN' });
    expect(ids([bin, gold], { q: 'silk gold' })).toEqual(['bin', 'silk-gold']);
    expect(ids([bin, gold], { q: 'silk gold bin' })).toEqual(['bin']);
  });

  it('a colorHex stored with a leading # still matches', () => {
    const hashed = row('hashed', { colorHex: '#00FF00' });
    expect(ids([hashed], { q: '00ff00' })).toEqual(['hashed']);
  });
});

