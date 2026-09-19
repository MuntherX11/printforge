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

  it('one spool per line', () => {
    const picks = pickSpools([{ material: red, grams: 100 }, { material: red, grams: 100 }], [spool('a', 'red', 500, red)]);
    expect(picks[0].spool!.id).toBe('a');
    expect(picks[1].spool).toBeNull();
    expect(picks[1].hasEnough).toBe(false);
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
