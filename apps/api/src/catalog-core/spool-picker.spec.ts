import { pickSpools, type SpoolRow } from './spool-picker';

const mat = (id: string, type = 'PLA', color: string | null = null, colorHex: string | null = null) => ({ id, type, color, colorHex });
const spool = (id: string, materialId: string, currentWeight: number, m = mat(materialId)): SpoolRow => ({ id, materialId, currentWeight, material: m });

describe('pickSpools (today\'s pickSpoolsForNeeds behaviour + netting)', () => {
  const red = mat('red', 'PLA', 'Red', '#C4402A');

  it('exact material first, the smallest spool that covers the need', () => {
    const [p] = pickSpools([{ material: red, grams: 150 }], [spool('big', 'red', 900, red), spool('small', 'red', 200, red), spool('tiny', 'red', 100, red)]);
    expect(p.spool!.id).toBe('small');
    expect(p.substituted).toBe(false);
    expect(p.hasEnough).toBe(true);
  });

  it('falls back to the largest exact spool that does not cover', () => {
    const [p] = pickSpools([{ material: red, grams: 500 }], [spool('a', 'red', 100, red), spool('b', 'red', 300, red)]);
    expect(p.spool!.id).toBe('b');
    expect(p.hasEnough).toBe(false);
  });

  it('same type ranked by hex distance when no exact spool exists; substituted flag set', () => {
    const crimson = mat('crimson', 'PLA', 'Red', '#91202B');
    const blue = mat('blue', 'PLA', 'Blue', '#2040C0');
    const petgRed = mat('petg-red', 'PETG', 'Red', '#C4402A');
    const [p] = pickSpools([{ material: red, grams: 100 }], [spool('b', 'blue', 500, blue), spool('c', 'crimson', 500, crimson), spool('pg', 'petg-red', 500, petgRed)]);
    expect(p.spool!.id).toBe('c');
    expect(p.substituted).toBe(true);
  });

  it('the hex pool excludes name-only candidates', () => {
    const nameOnlyRed = mat('red2', 'PLA', 'Red', null);
    const hexOrange = mat('orange', 'PLA', 'Orange', '#FF8000');
    const [p] = pickSpools([{ material: red, grams: 100 }], [spool('n', 'red2', 500, nameOnlyRed), spool('o', 'orange', 500, hexOrange)]);
    expect(p.spool!.id).toBe('o');
  });

  it('one spool per line: a spool promised to one filament is never another filament\'s substitute', () => {
    const crimson = mat('crimson', 'PLA', 'Red', '#91202B');
    const picks = pickSpools([{ material: red, grams: 100 }, { material: crimson, grams: 100 }], [spool('a', 'red', 500, red)]);
    expect(picks[0].spool!.id).toBe('a');
    expect(picks[1].spool).toBeNull();
    expect(picks[1].hasEnough).toBe(false);
  });

  describe('one filament on several lines (needs split by planned identity, §3.6.1)', () => {
    it('the lines share the exact spool, netted line by line', () => {
      const reserved = new Map<string, number>();
      const picks = pickSpools([{ material: red, grams: 100 }, { material: red, grams: 100 }], [spool('a', 'red', 500, red)], { reservedBySpool: reserved });
      expect(picks.map((p) => [p.spool?.id, p.substituted, p.effectiveRemaining, p.hasEnough])).toEqual([
        ['a', false, 500, true],
        ['a', false, 400, true],
      ]);
      expect(reserved.get('a')).toBe(200);
    });

    it('Sardine (Regular, Blue): both White lines get the one White spool, never the nearest colour (Silver)', () => {
      const [black, silver, white, orange, blue, gold] = [
        mat('m-black', 'PLA', 'Black', '#111111'), mat('m-silver', 'PLA', 'Silver', '#C0C0C0'), mat('m-white', 'PLA', 'White', '#FFFFFF'),
        mat('m-orange', 'PLA', 'Orange', '#FF8000'), mat('m-blue', 'PLA', 'Blue', '#2040C0'), mat('m-gold', 'PLA', 'Gold', '#D4AF37'),
      ];
      const stock = [
        spool('PF-BLACK', black.id, 900, black), spool('PF-SILVER', silver.id, 700, silver), spool('PF-WHITE', white.id, 800, white),
        spool('PF-ORANGE', orange.id, 500, orange), spool('PF-BLUE', blue.id, 900, blue), spool('PF-GOLD', gold.id, 600, gold),
      ];
      // planFromBom order: Blue / sliced Black, White / sliced Silver (Lid trim, Key), White / — (Fish, Band), Orange, Gold / sliced Black.
      const picks = pickSpools(
        [{ material: blue, grams: 150 }, { material: white, grams: 27 }, { material: white, grams: 38.4 }, { material: orange, grams: 10 }, { material: gold, grams: 30 }],
        stock,
      );
      expect(picks.map((p) => [p.material.id, p.spool?.id, p.substituted, p.hasEnough])).toEqual([
        ['m-blue', 'PF-BLUE', false, true],
        ['m-white', 'PF-WHITE', false, true],
        ['m-white', 'PF-WHITE', false, true],
        ['m-orange', 'PF-ORANGE', false, true],
        ['m-gold', 'PF-GOLD', false, true],
      ]);
      expect(picks[2].effectiveRemaining).toBe(773);
    });

    it('a later line that no longer fits the shared spool moves to a larger exact spool, not a substitute', () => {
      const crimson = mat('crimson', 'PLA', 'Red', '#91202B');
      const picks = pickSpools(
        [{ material: red, grams: 80 }, { material: red, grams: 60 }],
        [spool('s100', 'red', 100, red), spool('s500', 'red', 500, red), spool('c', 'crimson', 900, crimson)],
      );
      expect(picks.map((p) => [p.spool?.id, p.substituted, p.hasEnough])).toEqual([['s100', false, true], ['s500', false, true]]);
    });

    it('with one exact spool too small for both lines, the second stays on it (short) rather than taking another colour', () => {
      const crimson = mat('crimson', 'PLA', 'Red', '#91202B');
      const picks = pickSpools(
        [{ material: red, grams: 30 }, { material: red, grams: 40 }],
        [spool('a', 'red', 50, red), spool('c', 'crimson', 900, crimson)],
      );
      expect(picks.map((p) => [p.spool?.id, p.substituted, p.effectiveRemaining, p.hasEnough])).toEqual([
        ['a', false, 50, true],
        ['a', false, 20, false],
      ]);
    });

    it('"smallest that covers" is judged on what is left after the earlier lines', () => {
      const picks = pickSpools([{ material: red, grams: 120 }, { material: red, grams: 20 }], [spool('A', 'red', 100, red), spool('B', 'red', 150, red)]);
      expect(picks.map((p) => p.spool?.id)).toEqual(['B', 'B']);
      expect(picks[1].effectiveRemaining).toBe(30);
    });

    it('with no exact spool, the lines share the same substitute', () => {
      const white = mat('white', 'PLA', 'White', '#FFFFFF');
      const silver = mat('silver', 'PLA', 'Silver', '#C0C0C0');
      const orange = mat('orange', 'PLA', 'Orange', '#FF8000');
      const picks = pickSpools(
        [{ material: white, grams: 27 }, { material: white, grams: 38.4 }],
        [spool('s', 'silver', 700, silver), spool('o', 'orange', 500, orange)],
      );
      expect(picks.map((p) => [p.spool?.id, p.substituted])).toEqual([['s', true], ['s', true]]);
    });
  });

  it('netting: a 300 g spool with 250 g reserved is skipped for a 100 g need', () => {
    const reserved = new Map([['s300', 250]]);
    const [p] = pickSpools([{ material: red, grams: 100 }], [spool('s300', 'red', 300, red), spool('s500', 'red', 500, red)], { reservedBySpool: reserved });
    expect(p.spool!.id).toBe('s500');
    expect(p.effectiveRemaining).toBe(500);
    const [q] = pickSpools([{ material: red, grams: 100 }], [spool('s300', 'red', 300, red), spool('s500', 'red', 500, red)]);
    expect(q.spool!.id).toBe('s300');
  });

  it('grams picked earlier in the same request are netted too', () => {
    const reserved = new Map<string, number>();
    pickSpools([{ material: red, grams: 250 }], [spool('s300', 'red', 300, red)], { reservedBySpool: reserved });
    const [p] = pickSpools([{ material: red, grams: 100 }], [spool('s300', 'red', 300, red), spool('s500', 'red', 500, red)], { reservedBySpool: reserved });
    expect(p.spool!.id).toBe('s500');
  });
});
