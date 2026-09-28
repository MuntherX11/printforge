import { cn } from '@/lib/utils';

/** A filament colour dot; hollow when there is no colour ("as sliced"). */
export function Swatch({ hex, title, hollow }: { hex?: string | null; title: string; hollow?: boolean }) {
  const empty = hollow || !hex;
  return (
    <span
      title={title}
      aria-label={title}
      role="img"
      className={cn(
        'inline-block h-3.5 w-3.5 flex-shrink-0 rounded-full border',
        empty ? 'border-gray-400 bg-transparent dark:border-gray-500' : 'border-black/10 dark:border-white/20',
      )}
      style={empty ? undefined : { backgroundColor: hex ?? undefined }}
    />
  );
}

/**
 * A stored colorHex ('91202B', stored bare) as a CSS colour ('#91202B'), or
 * null when there is none, so <Swatch> shows a hollow dot.
 */
export function swatchHex(raw?: string | null): string | null {
  const bare = (raw ?? '').trim().replace(/^#/, '');
  return bare ? `#${bare}` : null;
}
