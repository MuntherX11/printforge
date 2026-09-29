'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { FILAMENT_QUERY_MAX, MATERIAL_TYPE_OPTIONS, rankFilamentChoices } from '@printforge/types';
import { Swatch, swatchHex } from '@/components/ui/swatch';
import { formatGrams } from '@/lib/product-format';
import type { FilamentStockRow } from '@/lib/types/api';
import { cn } from '@/lib/utils';

export interface FilamentPickerProps {
  /** GET /materials/stock rows; null until loaded. */
  rows: FilamentStockRow[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** Material type listed first (the slot's current filament type). */
  preferType: string | null;
  currentMaterialId: string | null;
  /** The row being saved: it shows "Saving…". */
  savingId: string | null;
  /** A save is running: the options ignore clicks (they keep the focus). */
  disabled: boolean;
  inputRef?: React.RefObject<HTMLInputElement>;
  onPick: (row: FilamentStockRow) => void;
}

function typeLabel(type: string): string {
  return MATERIAL_TYPE_OPTIONS.find((o) => o.value === type)?.label ?? type;
}

/**
 * Search the filaments and pick one: colour dot, name, brand · type and grams
 * in stock per row. Same type first, then in stock, then name A–Z; out of
 * stock rows are marked but can still be picked. Search follows the Filaments
 * list rules (colour, name, brand, type, location, hex, PF-ID).
 */
export function FilamentPicker(props: FilamentPickerProps) {
  const { rows, loading, error, preferType, currentMaterialId, savingId, disabled, onPick } = props;
  const busy = disabled || savingId !== null;
  const [q, setQ] = useState('');
  const ownInput = useRef<HTMLInputElement>(null);
  const inputRef = props.inputRef ?? ownInput;
  const listRef = useRef<HTMLUListElement>(null);

  const choices = useMemo(
    () => (rows ? rankFilamentChoices(rows, { q, preferType, currentMaterialId }) : []),
    [rows, q, preferType, currentMaterialId],
  );

  // After the dialog's own first-focus; not on touch screens, where the keyboard would cover the list.
  useEffect(() => {
    if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) return;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [inputRef]);

  const options = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-filament]') ?? []);

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'Enter') return;
    e.preventDefault();
    options()[0]?.focus();
  }

  function onOptionKey(e: React.KeyboardEvent<HTMLButtonElement>, i: number) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      options()[i + 1]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (i === 0) inputRef.current?.focus();
      else options()[i - 1]?.focus();
    }
  }

  let status: React.ReactNode = null;
  // A Retry in flight shows "Loading…" again rather than the old error.
  if (rows === null && error && !loading) {
    status = (
      <p className="text-red-600 dark:text-red-400">
        Couldn&apos;t load filaments{' '}
        <button type="button" onClick={props.onRetry} className="font-medium text-brand-600 hover:underline dark:text-brand-400">Retry</button>
      </p>
    );
  } else if (rows === null) {
    status = <p className="text-gray-500 dark:text-gray-400">Loading filaments…</p>;
  } else if (rows.length === 0) {
    status = <p className="text-gray-500 dark:text-gray-400">No filaments yet. Add one on the Filaments page.</p>;
  } else if (choices.length === 0) {
    status = <p className="text-gray-500 dark:text-gray-400">No filament matches &quot;{q.trim()}&quot;.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden="true" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onInputKey}
          aria-label="Search filaments"
          placeholder="Search colour, brand or type…"
          maxLength={FILAMENT_QUERY_MAX}
          enterKeyHint="search"
          autoComplete="off"
          className="h-10 w-full rounded-md border border-gray-300 bg-white pl-9 pr-9 text-sm placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-500"
        />
        {q && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => { setQ(''); inputRef.current?.focus(); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:text-gray-200"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
      {status ? (
        <div className="py-2 text-sm" aria-live="polite">{status}</div>
      ) : (
        <ul ref={listRef} aria-label="Filaments" className="max-h-[50vh] divide-y divide-gray-100 overflow-y-auto rounded-md border border-gray-200 dark:divide-gray-800 dark:border-gray-700">
          {choices.map(({ row, inStock, current }, i) => (
            <li key={row.id}>
              {/* aria-disabled, not disabled: a disabled button drops the focus, so a failed save would strand the keyboard. */}
              <button
                type="button"
                data-filament
                aria-current={current ? 'true' : undefined}
                aria-disabled={busy || undefined}
                onClick={() => { if (!busy) onPick(row); }}
                onKeyDown={(e) => onOptionKey(e, i)}
                className={cn(
                  'flex min-h-[44px] w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800',
                  'aria-disabled:cursor-not-allowed aria-disabled:opacity-60',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500',
                  current && 'bg-brand-50/60 dark:bg-brand-900/20',
                )}
              >
                <Swatch hex={swatchHex(row.colorHex)} title={row.color || row.name} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-gray-900 dark:text-gray-100">{row.name}</span>
                  <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                    {[row.brand, typeLabel(row.type), current ? 'Current' : null].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="shrink-0 text-right text-xs tabular-nums">
                  {savingId === row.id
                    ? <span className="text-gray-700 dark:text-gray-300">Saving…</span>
                    : inStock
                      ? <span className="text-gray-700 dark:text-gray-300">{formatGrams(row.totalStock)}</span>
                      : <span className="font-medium text-amber-700 dark:text-amber-300">Out of stock</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
