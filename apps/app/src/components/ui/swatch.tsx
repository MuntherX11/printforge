import { cn, cssHex } from '@/lib/utils';

/**
 * A filament colour dot; hollow when there is no colour ("as sliced"). `hex`
 * may be a stored bare "RRGGBB" or a "#RRGGBB" value; anything that is not a
 * hex colour draws hollow.
 */
export function Swatch({ hex, title, hollow }: { hex?: string | null; title: string; hollow?: boolean }) {
  const colour = cssHex(hex);
  const empty = hollow || !colour;
  return (
    <span
      title={title}
      aria-label={title}
      role="img"
      className={cn(
        'inline-block h-3.5 w-3.5 flex-shrink-0 rounded-full border',
        empty ? 'border-gray-400 bg-transparent dark:border-gray-500' : 'border-black/10 dark:border-white/20',
      )}
      style={empty ? undefined : { backgroundColor: colour ?? undefined }}
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
