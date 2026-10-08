'use client';

import { slicerFilamentLabel } from '@printforge/types';
import { Button } from '@/components/ui/button';
import { Swatch } from '@/components/ui/swatch';
import { FilamentPicker } from '@/components/filaments/FilamentPicker';
import type { SlotFilamentChoices } from './useSlotFilamentChoices';

interface Props {
  slots: SlotFilamentChoices;
  /** The file the slot belongs to, when the import has several. */
  fileName?: string | null;
}

/** Dialog title while a slot's filament is being chosen. */
export function slotChooserTitle(slots: SlotFilamentChoices): string | null {
  return slots.picking ? `Your filament for slot ${slots.picking.match.index + 1}` : null;
}

/**
 * The body of an import dialog while the owner chooses his own filament for
 * one slot: the slot as the file names it, then the searchable filament list
 * (the slot's type first, the closest colours on top, grams in stock). The
 * pick is only remembered; the import uses it and creates nothing for the slot.
 */
export function SlotFilamentChooser({ slots, fileName }: Props) {
  const { picking, stock } = slots;
  if (!picking) return null;
  const { group, match } = picking;
  const label = slicerFilamentLabel(match.file);
  const current = slots.choices[group]?.[match.index]?.id ?? match.material?.id ?? null;
  return (
    <div className="space-y-3">
      <p className="flex flex-wrap items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
        In the file: <Swatch hex={match.file.colorHex} title={label} decorative />
        <span className="min-w-0 break-words font-medium">{label}</span>
        {fileName && <span className="min-w-0 break-all text-xs text-gray-500 dark:text-gray-400">· {fileName}</span>}
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Pick the filament you print this slot with. The import uses it as it is and creates no new filament for the slot.
      </p>
      <FilamentPicker
        rows={stock.rows}
        loading={stock.loading}
        error={stock.error}
        onRetry={stock.refresh}
        preferType={match.materialType ?? match.material?.type ?? null}
        nearHex={match.file.colorHex}
        currentMaterialId={current}
        savingId={null}
        disabled={false}
        onPick={slots.pick}
      />
      <div className="flex justify-end border-t pt-3 dark:border-gray-700">
        <Button type="button" variant="outline" onClick={slots.close}>Back</Button>
      </div>
    </div>
  );
}
