'use client';

import { filamentLabel, type SlotKey } from '@printforge/types';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { FilamentPicker } from '@/components/filaments/FilamentPicker';
import type { FilamentStock } from '@/components/filaments/useFilamentStock';
import type { FilamentStockRow, MaterialLite } from '@/lib/types/api';
import { Swatch } from './options-ui';
import type { SliceSlotSpec } from './slice-ui';

/** A filament as the slot rows show it: a product-page MaterialLite or a stock row. */
export type FilamentChoice = { id: string; name: string; type: string; color: string | null; colorHex: string | null; brand: string | null };

export type SlotChoices = Partial<Record<SlotKey, FilamentChoice>>;

/** The filament of an id, from what the product page knows or the stock list. */
export function pickOf(id: string | null, materials: Map<string, MaterialLite>, rows: FilamentStockRow[] | null): FilamentChoice | null {
  if (!id) return null;
  return materials.get(id) ?? rows?.find(r => r.id === id) ?? null;
}

export function choiceIds(chosen: SlotChoices): Partial<Record<SlotKey, string>> {
  const out: Partial<Record<SlotKey, string>> = {};
  for (const [k, v] of Object.entries(chosen)) if (v) out[k as SlotKey] = v.id;
  return out;
}

/**
 * One row per slot a slice needs a filament for: the chosen filament (or
 * "No filament yet"), Change / Choose, and what the project names for the
 * slot. Shared by "Slice a plate" and "Add from model".
 */
export function SliceSlotRows({ slots, chosen, disabled, showSlotNumber, showFileSwatch = false, onPick }: {
  slots: SliceSlotSpec[];
  chosen: SlotChoices;
  disabled: boolean;
  /** "Slot N:" in front of each row. */
  showSlotNumber: boolean;
  /** The project's colour dot beside its profile name. */
  showFileSwatch?: boolean;
  onPick: (slot: SliceSlotSpec) => void;
}) {
  return (
    <ul className="mt-1 space-y-1">
      {slots.map(s => {
        const m = chosen[s.key] ?? null;
        const label = filamentLabel(m);
        const slotNo = Number(s.key) + 1;
        const secondary = m ? [label.secondary, [m.brand, m.type].filter(Boolean).join(' ')].filter(Boolean).join(' · ') : '';
        return (
          <li key={s.key} className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
            {showSlotNumber && <span className="flex-shrink-0 text-gray-500 dark:text-gray-400">Slot {slotNo}:</span>}
            {m
              ? (
                <>
                  <Swatch hex={m.colorHex} name={m.color || m.name} title={label.primary} />
                  <span className="min-w-0 max-w-full truncate text-gray-800 dark:text-gray-200" title={label.primary}>{label.primary}</span>
                  {secondary && <span className="min-w-0 max-w-full truncate text-xs text-gray-500 dark:text-gray-400" title={secondary}>{secondary}</span>}
                </>
              )
              : <span className="text-amber-700 dark:text-amber-300">No filament yet</span>}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(s)}
              aria-label={m ? `Change the filament for slot ${slotNo}` : `Choose a filament for slot ${slotNo}`}
              className="ml-1 inline-flex min-h-[24px] flex-shrink-0 items-center rounded px-1 text-xs font-medium text-brand-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50 dark:text-brand-400"
            >
              {m ? 'Change' : 'Choose'}
            </button>
            {s.fileLabel && (showFileSwatch ? (
              <span className="flex w-full min-w-0 items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                <span className="flex-shrink-0">In the project:</span> <Swatch hex={s.fileHex} title={s.fileLabel} decorative />
                <span className="min-w-0 truncate" title={s.fileLabel}>{s.fileLabel}</span>
              </span>
            ) : (
              <span className="w-full min-w-0 truncate text-xs text-gray-500 dark:text-gray-400" title={s.fileLabel}>In the project: {s.fileLabel}</span>
            ))}
          </li>
        );
      })}
    </ul>
  );
}

/** The filament picker of one slot, as its own dialog; Back returns to the form. */
export function SlotFilamentPickerDialog({ slot, current, stock, onPick, onBack }: {
  slot: SliceSlotSpec;
  current: FilamentChoice | null;
  stock: FilamentStock;
  onPick: (row: FilamentStockRow) => void;
  onBack: () => void;
}) {
  return (
    <Dialog open onClose={onBack} title={`Your filament for slot ${Number(slot.key) + 1}`} className="max-w-2xl">
      <div className="space-y-3">
        {slot.fileLabel && (
          <p className="flex flex-wrap items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
            In the project: <Swatch hex={slot.fileHex} title={slot.fileLabel} decorative />
            <span className="min-w-0 break-words font-medium">{slot.fileLabel}</span>
          </p>
        )}
        <FilamentPicker
          rows={stock.rows}
          loading={stock.loading}
          error={stock.error}
          onRetry={stock.refresh}
          preferType={current?.type ?? null}
          nearHex={slot.fileHex}
          currentMaterialId={current?.id ?? null}
          savingId={null}
          disabled={false}
          onPick={onPick}
        />
        <div className="flex justify-end border-t pt-3 dark:border-gray-700">
          <Button type="button" variant="outline" onClick={onBack}>Back</Button>
        </div>
      </div>
    </Dialog>
  );
}
