'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FilamentSlotMatch } from '@printforge/types';
import { useFilamentStock, type FilamentStock } from '@/components/filaments/useFilamentStock';
import type { FilamentStockRow } from '@/lib/types/api';

/** Slot index → the owner's own filament for it, instead of the automatic match. */
export type SlotChoices = Record<number, FilamentStockRow>;

/** The slot whose filament is being chosen. `group` tells files apart (0 for a 3MF project). */
export interface SlotPicking {
  group: number;
  match: FilamentSlotMatch;
}

/** DOM id of a slot's "Change" control: the focus returns to it after the picker. */
export function slotControlId(group: number, index: number): string {
  return `import-slot-${group}-${index}`;
}

/**
 * The `filaments` entry of one file or plate: its chosen slots among the ones
 * it uses, as slot → filament id. null when none is chosen.
 */
export function chosenSlotIds(choices: SlotChoices | undefined, usedSlots: readonly number[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const index of usedSlots) {
    const row = choices?.[index];
    if (row) out[String(index)] = row.id;
  }
  return Object.keys(out).length ? out : null;
}

export interface SlotFilamentChoices {
  /** group → slot → chosen filament. */
  choices: Record<number, SlotChoices>;
  picking: SlotPicking | null;
  /** Loaded the first time a picker opens, and again for each later import. */
  stock: FilamentStock;
  open: (group: number, match: FilamentSlotMatch) => void;
  close: () => void;
  pick: (row: FilamentStockRow) => void;
  undo: (group: number, index: number) => void;
}

/**
 * "Choose my filament" for the slots of an import (owner: "I should be able to
 * override on import to avoid the system creating phantom colors"). Choices
 * live until `importState` changes (another import, or the dialog closing);
 * picking the filament the import would use anyway is the same as no choice.
 */
export function useSlotFilamentChoices(importState: object | null): SlotFilamentChoices {
  const [choices, setChoices] = useState<Record<number, SlotChoices>>({});
  const [picking, setPicking] = useState<SlotPicking | null>(null);
  const [refocus, setRefocus] = useState<{ id: string } | null>(null);
  const [wanted, setWanted] = useState(false);
  const stock = useFilamentStock(wanted && importState !== null, importState);

  useEffect(() => {
    setChoices({});
    setPicking(null);
    setRefocus(null);
  }, [importState]);

  // Back from the picker, or after an undo removed its own button: focus the slot's control.
  useEffect(() => {
    if (!refocus || picking) return;
    const t = setTimeout(() => document.getElementById(refocus.id)?.focus(), 0);
    return () => clearTimeout(t);
  }, [refocus, picking]);

  const open = useCallback((group: number, match: FilamentSlotMatch) => {
    setWanted(true);
    setPicking({ group, match });
  }, []);

  const undo = useCallback((group: number, index: number) => {
    setChoices(prev => {
      const next = { ...prev[group] };
      delete next[index];
      return { ...prev, [group]: next };
    });
    setRefocus({ id: slotControlId(group, index) });
  }, []);

  const close = useCallback(() => {
    if (picking) setRefocus({ id: slotControlId(picking.group, picking.match.index) });
    setPicking(null);
  }, [picking]);

  const pick = useCallback((row: FilamentStockRow) => {
    if (!picking) return;
    const { group, match } = picking;
    if (match.material?.id === row.id) undo(group, match.index);
    else setChoices(prev => ({ ...prev, [group]: { ...prev[group], [match.index]: row } }));
    setRefocus({ id: slotControlId(group, match.index) });
    setPicking(null);
  }, [picking, undo]);

  return { choices, picking, stock, open, close, pick, undo };
}
