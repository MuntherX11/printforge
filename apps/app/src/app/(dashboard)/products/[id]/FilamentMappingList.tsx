'use client';

import { filamentChoiceText, filamentMatchText, isExactFilamentMatch, slicerFilamentLabel, type FilamentSlotMatch } from '@printforge/types';
import { Swatch } from '@/components/ui/swatch';
import { cn } from '@/lib/utils';
import { slotControlId, type SlotChoices } from './useSlotFilamentChoices';

interface Props {
  matches: FilamentSlotMatch[];
  title?: string;
  /** The owner's own filament per slot index (with `onChoose`). */
  choices?: SlotChoices;
  /** Given: each slot gets "Change" ("Choose mine instead" where a filament would be created). */
  onChoose?: (match: FilamentSlotMatch) => void;
  /** Back to the automatic match. */
  onUndo?: (index: number) => void;
  disabled?: boolean;
  /** Tells the slots of several files apart (see slotControlId). */
  group?: number;
}

const LINK = 'ml-1 inline-flex min-h-[24px] items-center rounded px-1 text-xs font-medium text-brand-600 hover:underline '
  + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50 dark:text-brand-400';

/**
 * Each slot of the file and the filament the import will use for it:
 * "● eSUN PLA+ Fire Engine Red → your eSun PLA Fire Engine Red (exact)", or
 * "→ new filament … (cost 0 — set it after)". With `onChoose` the owner can
 * put his own filament on a slot before importing ("… (your choice)", with
 * undo), so a slicer's default colour never becomes a new filament.
 */
export function FilamentMappingList({ matches, title = 'Filaments', choices, onChoose, onUndo, disabled, group = 0 }: Props) {
  if (!matches.length) return null;
  return (
    <div>
      <p className="text-xs font-medium text-gray-700 dark:text-gray-300">{title}</p>
      <ul className="mt-1 space-y-1">
        {matches.map(m => {
          const picked = onChoose ? choices?.[m.index] : undefined;
          const slot = m.index + 1;
          return (
            <li
              key={m.index}
              className={cn(
                'flex items-start gap-2 text-sm',
                picked || isExactFilamentMatch(m) ? 'text-gray-800 dark:text-gray-200'
                  : m.create ? 'text-amber-700 dark:text-amber-300' : 'text-gray-700 dark:text-gray-300',
              )}
            >
              <span className="mt-0.5"><Swatch hex={m.file.colorHex} title={slicerFilamentLabel(m.file)} decorative /></span>
              <span className="min-w-0 break-words">
                <span className="text-gray-500 dark:text-gray-400">Slot {slot}: </span>
                {picked ? filamentChoiceText(m.file, picked) : filamentMatchText(m)}
                {onChoose && (
                  <button
                    type="button"
                    id={slotControlId(group, m.index)}
                    disabled={disabled}
                    onClick={() => onChoose(m)}
                    aria-label={picked || !m.create ? `Change the filament for slot ${slot}` : `Choose my own filament for slot ${slot}`}
                    className={LINK}
                  >
                    {picked || !m.create ? 'Change' : 'Choose mine instead'}
                  </button>
                )}
                {picked && onUndo && (
                  <button type="button" disabled={disabled} onClick={() => onUndo(m.index)} aria-label={`Undo your choice for slot ${slot}`} className={LINK}>
                    undo
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
