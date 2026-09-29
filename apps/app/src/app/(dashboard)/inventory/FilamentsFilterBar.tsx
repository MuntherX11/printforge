'use client';

import type { RefObject } from 'react';
import { Search, X } from 'lucide-react';
import { Select } from '@/components/ui/select';
import {
  FILAMENT_QUERY_MAX,
  MATERIAL_TYPE_OPTIONS,
  NO_BRAND,
  type FilamentFilterResult,
  type FilamentListState,
  type FilamentSort,
  type FilamentStockCounts,
  type FilamentStockFilter,
} from '@printforge/types';

const SORT_OPTIONS: Array<{ value: FilamentSort; label: string }> = [
  { value: '', label: 'Colour A–Z' },
  { value: 'brand', label: 'Brand A–Z' },
  { value: 'type', label: 'Type' },
  { value: 'stock-asc', label: 'Stock: lowest first' },
  { value: 'stock-desc', label: 'Stock: highest first' },
  { value: 'newest', label: 'Newest first' },
];

const STOCK_CHIPS: Array<{ value: FilamentStockFilter; label: string; count: keyof FilamentStockCounts; title?: string }> = [
  { value: '', label: 'All', count: 'all' },
  { value: 'low', label: 'Low stock', count: 'low', title: 'Below reorder point (same count as the dashboard)' },
  { value: 'out', label: 'Out of stock', count: 'out' },
];

/** The controls that write the URL at once (the search box is debounced). */
export type FilamentFilterPatch = Partial<Pick<FilamentListState, 'type' | 'brand' | 'stock' | 'sort'>>;

interface FilamentsFilterBarProps {
  /** q is the search text as typed. */
  state: FilamentListState;
  result: FilamentFilterResult;
  /** False until the first load finishes: counts are hidden until then. */
  loaded: boolean;
  onQuery: (q: string) => void;
  onChange: (patch: FilamentFilterPatch) => void;
  /** Resets the filters; the page then puts focus back in the search box. */
  onClearFilters: () => void;
  /** The search input, owned by the page so Clear filters can focus it. */
  inputRef: RefObject<HTMLInputElement>;
  /** Enter in the search box. */
  onSubmit: () => void;
}

const plural = (n: number) => `${n.toLocaleString('en-US')} filament${n === 1 ? '' : 's'}`;

/** Search, Type, Brand and Sort, then the stock chips and the count line. */
export function FilamentsFilterBar({ state, result, loaded, onQuery, onChange, onClearFilters, onSubmit, inputRef }: FilamentsFilterBarProps) {
  const typeValues = [...result.typesPresent];
  if (state.type && !typeValues.includes(state.type)) typeValues.push(state.type);
  const typeOptions = [
    { value: '', label: 'All types' },
    ...MATERIAL_TYPE_OPTIONS.filter((o) => typeValues.includes(o.value)),
  ];
  const brandOptions = [
    { value: '', label: 'All brands' },
    ...result.brandOptions,
    ...(result.hasNoBrand ? [{ value: NO_BRAND, label: '(No brand)' }] : []),
  ];
  const filtered = state.q.trim() !== '' || state.type !== '' || state.brand !== '' || state.stock !== '';

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSubmit();
    } else if (e.key === 'Escape' && state.q) {
      e.preventDefault();
      onQuery('');
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" aria-hidden="true" />
          <input
            ref={inputRef}
            value={state.q}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Search filaments"
            placeholder="Search colour, brand, type, PF-ID or location…"
            maxLength={FILAMENT_QUERY_MAX}
            enterKeyHint="search"
            autoComplete="off"
            className="h-10 w-full sm:w-72 pl-9 pr-9 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
          {state.q && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => { onQuery(''); inputRef.current?.focus(); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <div className="sm:w-40">
            <Select
              aria-label="Type"
              value={state.type}
              options={typeOptions}
              onChange={(e) => onChange({ type: MATERIAL_TYPE_OPTIONS.find((o) => o.value === e.target.value)?.value ?? '' })}
            />
          </div>
          <div className="sm:w-44">
            <Select
              aria-label="Brand"
              value={state.brand}
              options={brandOptions}
              onChange={(e) => onChange({ brand: e.target.value })}
            />
          </div>
        </div>
        <div className="sm:w-48">
          <Select
            aria-label="Sort"
            value={state.sort}
            options={SORT_OPTIONS}
            onChange={(e) => onChange({ sort: SORT_OPTIONS.find((o) => o.value === e.target.value)?.value ?? '' })}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {STOCK_CHIPS.map((chip) => (
          <button
            key={chip.count}
            type="button"
            onClick={() => onChange({ stock: chip.value })}
            aria-pressed={state.stock === chip.value}
            title={chip.title}
            className={`px-3 py-2 min-h-[36px] text-xs rounded-full border transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${
              state.stock === chip.value ? 'bg-brand-600 text-white border-brand-600' : 'bg-white dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600 text-gray-600 border-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
            }`}
          >
            {loaded ? `${chip.label} (${result.counts[chip.count].toLocaleString('en-US')})` : chip.label}
          </button>
        ))}
        {loaded && (
          <p className="text-sm text-gray-500 dark:text-gray-400 sm:ml-2" aria-live="polite">
            {filtered ? (
              <>
                {result.matchedCount.toLocaleString('en-US')} of {plural(result.totalCount)} ·{' '}
                <button type="button" onClick={onClearFilters} className="text-brand-600 dark:text-brand-400 hover:underline">
                  Clear filters
                </button>
              </>
            ) : plural(result.totalCount)}
          </p>
        )}
      </div>
    </div>
  );
}
