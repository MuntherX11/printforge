'use client';

import { filamentMatchText, isExactFilamentMatch, slicerFilamentLabel, type FilamentSlotMatch } from '@printforge/types';
import { Swatch } from '@/components/ui/swatch';
import { cn } from '@/lib/utils';

/**
 * Each slot of the file and the filament the import will use for it:
 * "● eSUN PLA+ Fire Engine Red → your eSun PLA Fire Engine Red (exact)", or
 * "→ new filament … (cost 0 — set it after)". A wrong match is fixed after the
 * import with the bill of materials' filament picker.
 */
export function FilamentMappingList({ matches, title = 'Filaments' }: { matches: FilamentSlotMatch[]; title?: string }) {
  if (!matches.length) return null;
  return (
    <div>
      <p className="text-xs font-medium text-gray-700 dark:text-gray-300">{title}</p>
      <ul className="mt-1 space-y-1">
        {matches.map(m => (
          <li
            key={m.index}
            className={cn(
              'flex items-start gap-2 text-sm',
              m.create ? 'text-amber-700 dark:text-amber-300' : isExactFilamentMatch(m) ? 'text-gray-800 dark:text-gray-200' : 'text-gray-700 dark:text-gray-300',
            )}
          >
            <span className="mt-0.5"><Swatch hex={m.file.colorHex} title={slicerFilamentLabel(m.file)} decorative /></span>
            <span className="min-w-0 break-words">
              <span className="text-gray-500 dark:text-gray-400">Slot {m.index + 1}: </span>
              {filamentMatchText(m)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
