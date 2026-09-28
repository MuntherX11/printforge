/**
 * A filament's identity: brand + type + colour (safety spec §3). Two filaments
 * with the same identity are duplicates; the server refuses to create the
 * second one. Pure, shared by the API guard and anything that must agree with it.
 *
 * - Brand and colour compare with normText (trim, collapse spaces, lowercase),
 *   the same rule as the Filaments list and the Scan Label match.
 * - Type compares as the exact enum value.
 * - Exact colour names stay distinct: 'Red' and 'Fire Engine Red' never match.
 * - A filament without a colour has no identity and is never a duplicate.
 */
import { normText } from './filament-filter';

export interface FilamentIdentity {
  type: string;
  brand?: string | null;
  color?: string | null;
}

/** Trim and collapse inner whitespace, keeping the case. */
function tidy(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ');
}

/** `brand|TYPE|colour` after normText, or null when the colour is blank. */
export function filamentIdentityKey(identity: FilamentIdentity): string | null {
  const color = normText(identity.color);
  if (color === '') return null;
  return `${normText(identity.brand)}|${identity.type}|${color}`;
}

/** 'eSUN · PLA · Red', or 'No brand · PLA · Red'. Case kept, spaces tidied. */
export function filamentIdentityLabel(identity: FilamentIdentity): string {
  return `${tidy(identity.brand) || 'No brand'} · ${identity.type} · ${tidy(identity.color)}`;
}
