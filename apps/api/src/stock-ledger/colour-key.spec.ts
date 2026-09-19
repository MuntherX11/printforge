import { baseColourKeyOf, colourKeyHasMaterial, colourKeyOf, colourLabel, parseColourKey } from './colour-key';

describe('colour keys', () => {
  it('sorts by colorIndex', () => {
    expect(colourKeyOf([{ colorIndex: 1, materialId: 'orange' }, { colorIndex: 0, materialId: 'white' }])).toBe('0:white|1:orange');
    expect(colourKeyOf([{ colorIndex: 0, materialId: 'red' }])).toBe('0:red');
  });

  it('parse/format round trip', () => {
    for (const k of ['0:red', '0:cmW|1:cmO', '0:a|2:b|3:c']) expect(colourKeyOf(parseColourKey(k))).toBe(k);
  });

  it.each(['', '0', ':red', '0:', '0:red|', '1:a|0:b', '0:a|0:b', 'x:red', '0:re d', '0:red;DROP'])('rejects malformed key %p', (k) => {
    expect(() => parseColourKey(k)).toThrow('Invalid colour key');
  });

  it('rejects bad slots when building', () => {
    expect(() => colourKeyOf([{ colorIndex: 0, materialId: 'a' }, { colorIndex: 0, materialId: 'b' }])).toThrow();
    expect(() => colourKeyOf([{ colorIndex: -1, materialId: 'a' }])).toThrow();
    expect(() => colourKeyOf([{ colorIndex: 0, materialId: 'a|b' }])).toThrow();
  });

  it('labels: PLA Red, White + Silk Orange', () => {
    const mats = new Map([['red', { name: 'PLA Red' }], ['w', { name: 'White' }], ['o', { name: 'Silk Orange' }]]);
    expect(colourLabel('0:red', mats)).toBe('PLA Red');
    expect(colourLabel('0:w|1:o', mats)).toBe('White + Silk Orange');
    expect(colourLabel('0:w|1:w', mats)).toBe('White');
  });

  it('base key of single and multicolour components; material membership', () => {
    expect(baseColourKeyOf({ materialId: 'black', isMultiColor: false, materials: [] })).toBe('0:black');
    expect(baseColourKeyOf({ materialId: null, isMultiColor: true, materials: [{ colorIndex: 1, materialId: 'o' }, { colorIndex: 0, materialId: 'w' }] })).toBe('0:w|1:o');
    expect(baseColourKeyOf({ materialId: null, isMultiColor: false, materials: [] })).toBe('');
    expect(colourKeyHasMaterial('0:w|1:o', 'o')).toBe(true);
    expect(colourKeyHasMaterial('0:w|1:oo', 'o')).toBe(false);
  });
});
