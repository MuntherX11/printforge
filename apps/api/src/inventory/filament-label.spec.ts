import { NO_FILAMENT_LABEL, filamentLabel, type FilamentLabel, type MaterialLite } from '@printforge/types';

/**
 * The one on-screen filament label the Filaments list, the BOM filament
 * picker, the BOM chip and the pick dialog share: colour first, the name only
 * when it says something the colour doesn't.
 */

const label = (name: string, color: string | null | undefined): FilamentLabel => filamentLabel({ name, color });

describe('filamentLabel', () => {
  it('leads with the colour and keeps a name that is not the colour (the live filaments)', () => {
    const live: Array<[string, string]> = [
      ['eSUN PLA', 'Light Blue'],
      ['eSUN PLA', 'Dark grey'],
      ['PLA', 'Light Yellow'],
      ['PLA', 'Orange'],
      ['PLA Basic', 'Blue Grey'],
      ['PLA Matcha', 'Matcha Green'],
      ['PLA Red', 'Fire Engine Red'],
    ];
    for (const [name, color] of live) {
      expect(label(name, color)).toEqual({ primary: color, secondary: name, text: `${color} (${name})` });
    }
  });

  it('two filaments with the same name read apart by their colour', () => {
    const a = label('eSUN PLA', 'Light Blue');
    const b = label('eSUN PLA', 'Dark grey');
    expect(a.primary).not.toBe(b.primary);
    expect(a.text).not.toBe(b.text);
  });

  it('drops the name when it is the colour, ignoring case and spaces', () => {
    expect(label('Red', 'Red')).toEqual({ primary: 'Red', secondary: null, text: 'Red' });
    expect(label('red', 'Red')).toEqual({ primary: 'Red', secondary: null, text: 'Red' });
    expect(label('  LIGHT   blue ', 'Light Blue')).toEqual({ primary: 'Light Blue', secondary: null, text: 'Light Blue' });
    expect(label('Light Blue', ' light blue ')).toEqual({ primary: 'light blue', secondary: null, text: 'light blue' });
  });

  it('keeps a name that only contains the colour (exact text, not a substring match)', () => {
    expect(label('Red', 'Fire Engine Red').secondary).toBe('Red');
    expect(label('Fire Engine Red', 'Red').secondary).toBe('Fire Engine Red');
  });

  it('falls back to the name when there is no colour, and never repeats it', () => {
    for (const color of [null, undefined, '', '   ']) {
      expect(label('eSUN PLA', color)).toEqual({ primary: 'eSUN PLA', secondary: null, text: 'eSUN PLA' });
    }
  });

  it('tidies spaces in what it shows and keeps the case', () => {
    expect(label('  eSUN   PLA ', '  Light   Blue ')).toEqual({ primary: 'Light Blue', secondary: 'eSUN PLA', text: 'Light Blue (eSUN PLA)' });
    expect(label(' PLA  Basic ', null)).toEqual({ primary: 'PLA Basic', secondary: null, text: 'PLA Basic' });
  });

  it('shows no secondary for a blank name under a colour', () => {
    expect(label('   ', 'Orange')).toEqual({ primary: 'Orange', secondary: null, text: 'Orange' });
  });

  it('reads "No filament" for a slot without one', () => {
    expect(NO_FILAMENT_LABEL).toBe('No filament');
    expect(filamentLabel(null)).toEqual({ primary: 'No filament', secondary: null, text: 'No filament' });
    expect(filamentLabel(undefined)).toEqual({ primary: 'No filament', secondary: null, text: 'No filament' });
  });

  it('takes a BOM material as it is and does not change it', () => {
    const material: MaterialLite = {
      id: 'm1', name: 'PLA Matcha', type: 'PLA', color: 'Matcha Green', colorHex: null, brand: 'eSUN', costPerGram: 0.02,
    };
    const before = { ...material };
    expect(filamentLabel(material)).toEqual({ primary: 'Matcha Green', secondary: 'PLA Matcha', text: 'Matcha Green (PLA Matcha)' });
    expect(material).toEqual(before);
  });
});
