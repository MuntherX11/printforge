/**
 * How a filament is named on screen: colour first, the way a spool is picked
 * off the shelf. One rule for the Filaments list, the BOM filament picker, the
 * BOM chip and the pick dialog, so they can't drift apart.
 *
 * - `primary` is the colour, or the name when the filament has no colour.
 * - `secondary` is the name, only when there is a colour and the name is not
 *   the same text (trimmed, spaces collapsed, case ignored: normText).
 *   "eSUN PLA" in Light Blue gives Light Blue / eSUN PLA; "Red" in red gives
 *   Red alone.
 *
 * Pure and DOM-free: the app runs it in the browser and the api jest suite
 * tests it (through the '@printforge/types' moduleNameMapper).
 */
import { normText } from './filament-filter';

export interface FilamentLabelSource {
  name: string;
  color?: string | null;
}

export interface FilamentLabel {
  /** The colour, or the name when there is no colour. */
  primary: string;
  /** The name when it says something the colour doesn't; else null. */
  secondary: string | null;
  /** One line: 'Light Blue (eSUN PLA)', or just the primary. */
  text: string;
}

/** Trim and collapse inner whitespace, keeping the case. */
function tidy(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ');
}

/** What a slot with no filament shows. */
export const NO_FILAMENT_LABEL = 'No filament';

/**
 * The filament's on-screen label (see the module comment for the rule).
 * null/undefined (a slot with no filament) reads 'No filament'.
 */
export function filamentLabel(filament: FilamentLabelSource | null | undefined): FilamentLabel {
  if (!filament) return { primary: NO_FILAMENT_LABEL, secondary: null, text: NO_FILAMENT_LABEL };
  const color = tidy(filament.color);
  const name = tidy(filament.name);
  if (color === '') return { primary: name, secondary: null, text: name };
  const secondary = name !== '' && normText(name) !== normText(color) ? name : null;
  return { primary: color, secondary, text: secondary ? `${color} (${secondary})` : color };
}
