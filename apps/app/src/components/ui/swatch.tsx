import { approxColourHex } from '@printforge/types';
import { cn, cssHex } from '@/lib/utils';

/**
 * A filament colour dot; hollow when there is no colour ("as sliced"). `hex`
 * may be a stored bare "RRGGBB" or a "#RRGGBB" value; anything that is not a
 * hex colour draws hollow. `decorative` hides the dot from screen readers
 * (the hover title stays) where the text beside it already says the colour.
 *
 * `name` is the filament's colour name (or its name): when there is no hex,
 * the dot shows an approximate colour from it with a dashed border, and the
 * title says it is approximate (`approxTitle` overrides that title). Only a
 * name with no colour word in it stays hollow. Nothing here is stored.
 */
export function Swatch({ hex, name, title, approxTitle, hollow, decorative }: {
  hex?: string | null;
  name?: string | null;
  title: string;
  approxTitle?: string;
  hollow?: boolean;
  decorative?: boolean;
}) {
  const own = hollow ? null : cssHex(hex);
  const approx = hollow || own ? null : cssHex(approxColourHex(name));
  const colour = own ?? approx;
  const label = approx ? approxTitle ?? `${title} (approximate colour)` : title;
  return (
    <span
      title={label}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
      role={decorative ? undefined : 'img'}
      className={cn(
        'inline-block h-3.5 w-3.5 flex-shrink-0 rounded-full border',
        !colour && 'border-gray-400 bg-transparent dark:border-gray-500',
        own && 'border-black/10 dark:border-white/20',
        approx && 'border-dashed border-gray-500 dark:border-gray-300',
      )}
      style={colour ? { backgroundColor: colour } : undefined}
    />
  );
}

/**
 * A stored colorHex ('91202B', stored bare) as a CSS colour ('#91202B'), or
 * null when there is none or it is not a hex colour, so <Swatch> shows a
 * hollow dot. The same rule as cssHex; <Swatch> also applies it itself.
 */
export function swatchHex(raw?: string | null): string | null {
  return cssHex(raw);
}
