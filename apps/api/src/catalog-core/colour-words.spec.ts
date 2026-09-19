import { colourPartOfMaterialName, likelyColour } from './colour-words';

describe('likelyColour', () => {
  it.each(['Red', 'red', 'Navy Blue', 'grey', 'Gray', 'أحمر', 'فضي', ' Gold '])('%p looks like a colour', (n) => {
    expect(likelyColour(n)).toBe(true);
  });

  it.each(['Large', 'Small', 'Regular', 'Redwood', 'Gift box', ''])('%p does not', (n) => {
    expect(likelyColour(n)).toBe(false);
  });

  it('uses every Material.color and the colour part of material names', () => {
    const materials = [{ name: 'PLA Mint', color: null }, { name: 'PETG-CF Charcoal', color: 'Graphite' }];
    expect(likelyColour('Mint', materials)).toBe(true);
    expect(likelyColour('charcoal', materials)).toBe(true);
    expect(likelyColour('Graphite', materials)).toBe(true);
    expect(likelyColour('Mint')).toBe(false);
  });

  it('strips material type tokens', () => {
    expect(colourPartOfMaterialName('PLA+ Silk Orange')).toBe('silk orange');
    expect(colourPartOfMaterialName('PA12 Black')).toBe('black');
  });
});
