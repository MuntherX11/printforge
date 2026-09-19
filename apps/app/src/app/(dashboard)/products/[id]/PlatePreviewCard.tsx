'use client';

import { Printer } from 'lucide-react';
import Image from 'next/image';
import { cn } from '@/lib/utils';
import { formatGrams, formatMinutes } from '@/lib/product-format';
import type { ComponentDetail, ThreeMfPlateInfo } from '@/lib/types/api';
import { Swatch } from './options-ui';

export const NEW_COMPONENT = '__new';

export interface PlateChoice {
  selected: boolean;
  name: string;
  /** "Units on this plate" as typed; '' = not entered. */
  units: string;
  /** NEW_COMPONENT or the id of an existing component of the target scope. */
  addAs: string;
}

export function isSliced(plate: ThreeMfPlateInfo): boolean {
  return plate.weightGrams > 0 || plate.printSeconds > 0;
}

/** Units parsed from the input: a whole number 1–500, null when empty, NaN when invalid. */
export function unitsOf(choice: PlateChoice): number | null {
  const t = choice.units.trim();
  if (t === '') return null;
  const n = /^\d+$/.test(t) ? Number(t) : NaN;
  return n >= 1 && n <= 500 ? n : NaN;
}

interface Props {
  plate: ThreeMfPlateInfo;
  choice: PlateChoice;
  /** Components of the target scope, for `Plate layout of <component>`. */
  components: ComponentDetail[];
  onChange: (next: Partial<PlateChoice>) => void;
}

/** One 3MF plate in the import wizard (spec §5.1 PlatePreviewCard). */
export function PlatePreviewCard({ plate, choice, components, onChange }: Props) {
  const sliced = isSliced(plate);
  const usedTools = plate.tools.filter(t => t.filamentGrams > 0);
  const units = unitsOf(choice);
  const models = plate.objectModels ?? [];
  const inputId = `plate-${plate.plateIndex}-units`;

  return (
    <div
      className={cn(
        'rounded-lg border p-3 transition-colors',
        choice.selected ? 'border-brand-500 ring-1 ring-brand-500 dark:border-brand-400' : 'border-gray-200 dark:border-gray-700',
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <input
          type="checkbox"
          checked={choice.selected}
          onChange={() => onChange({ selected: !choice.selected })}
          aria-label={`Import plate ${plate.plateIndex}`}
          className="h-4 w-4 cursor-pointer rounded border-gray-300 text-brand-600"
        />
        <input
          type="text"
          value={choice.name}
          aria-label={`Name of plate ${plate.plateIndex}`}
          maxLength={120}
          onChange={e => onChange({ name: e.target.value })}
          className="min-w-0 flex-1 border-b border-gray-200 bg-transparent px-0.5 py-0.5 text-sm font-medium text-gray-900 outline-none focus:border-brand-500 dark:border-gray-700 dark:text-gray-100"
        />
      </div>

      <button
        type="button"
        onClick={() => onChange({ selected: !choice.selected })}
        className={cn('relative mb-2 flex aspect-video w-full items-center justify-center overflow-hidden rounded bg-gray-100 dark:bg-gray-800', !choice.selected && 'opacity-60')}
        aria-label={choice.selected ? `Unselect plate ${plate.plateIndex}` : `Select plate ${plate.plateIndex}`}
      >
        {plate.thumbnailBase64
          ? <Image src={plate.thumbnailBase64} alt={choice.name} fill loading="lazy" className="object-contain" unoptimized />
          : <Printer className="h-8 w-8 text-gray-400 dark:text-gray-500" />}
      </button>

      {sliced ? (
        <div className="mb-1.5 flex items-center justify-between text-xs text-gray-600 dark:text-gray-400">
          <span>{formatMinutes(plate.printSeconds / 60)} · {formatGrams(plate.weightGrams)}</span>
          {plate.toolChanges > 0 && <span>{plate.toolChanges} colour changes</span>}
        </div>
      ) : (
        <p className="mb-1.5 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          Not sliced — 0 g, 0 min · imported as a placeholder
        </p>
      )}

      {usedTools.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {usedTools.map(t => (
            <Swatch key={t.index} hex={t.colorHex} title={`Colour ${t.index + 1}: ${t.materialType || 'Unknown'} — ${formatGrams(t.filamentGrams)}`} />
          ))}
        </div>
      )}

      {sliced && choice.selected && (
        <div className="space-y-2 border-t border-gray-100 pt-2 dark:border-gray-800">
          <div>
            <label htmlFor={inputId} className="text-xs font-medium text-gray-700 dark:text-gray-300">Units on this plate</label>
            <input
              id={inputId}
              type="number"
              min={1}
              max={500}
              step={1}
              value={choice.units}
              placeholder={plate.objectCount == null ? 'e.g. 12' : undefined}
              onChange={e => onChange({ units: e.target.value })}
              className={cn(
                'mt-0.5 block h-8 w-24 rounded-md border bg-white px-2 text-sm dark:bg-gray-800 dark:text-gray-100',
                Number.isNaN(units) ? 'border-red-500' : 'border-gray-300 dark:border-gray-600',
              )}
            />
            {plate.objectCount == null && <p className="text-xs text-gray-500 dark:text-gray-400">No object labels — enter how many</p>}
            {Number.isNaN(units) && <p className="text-xs text-red-600 dark:text-red-400">Whole number from 1 to 500</p>}
            {models.length > 1 && (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Mixed plate: {models.map(m => `${m.count} × ${m.model}`).join(', ')} — enter the units of one component
              </p>
            )}
          </div>
          <div>
            <label htmlFor={`${inputId}-as`} className="text-xs font-medium text-gray-700 dark:text-gray-300">Add as</label>
            <select
              id={`${inputId}-as`}
              value={choice.addAs}
              onChange={e => onChange({ addAs: e.target.value })}
              className="mt-0.5 block h-8 w-full rounded-md border border-gray-300 bg-white px-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            >
              <option value={NEW_COMPONENT}>New component</option>
              {components.map(c => <option key={c.id} value={c.id}>Plate layout of {c.description}</option>)}
            </select>
            {choice.addAs === NEW_COMPONENT && units !== null && units > 1 && (
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Per-unit weight and time will be estimated from this plate</p>
            )}
            {choice.addAs !== NEW_COMPONENT && units === null && (
              <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">Enter the units on this plate</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ legacy
// Quick quote (quick-quote/FileQuotePanel.tsx) still imports the default
// export with its original props; that screen is outside this package.

interface LegacyPlatePreviewCardProps {
  plate: ThreeMfPlateInfo;
  selected: boolean;
  name: string;
  onToggle: (plateIndex: number) => void;
  onNameChange: (plateIndex: number, name: string) => void;
}

function formatTime(seconds: number): string {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function LegacyPlatePreviewCard({
  plate,
  selected,
  name,
  onToggle,
  onNameChange,
}: LegacyPlatePreviewCardProps) {
  return (
    <div
      className={`border rounded-lg p-3 transition-all duration-150 ${
        selected
          ? 'border-brand-500 ring-1 ring-brand-500 opacity-100 dark:border-brand-400'
          : 'border-gray-200 dark:border-gray-700 opacity-50 hover:opacity-70'
      }`}
    >
      {/* Header: checkbox + editable name */}
      <div className="flex items-center gap-2 mb-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(plate.plateIndex)}
          className="h-4 w-4 rounded border-gray-300 text-brand-600 cursor-pointer"
        />
        <input
          type="text"
          value={name}
          onChange={(e) => onNameChange(plate.plateIndex, e.target.value)}
          className="flex-1 min-w-0 border-b border-transparent hover:border-gray-300 dark:hover:border-gray-500 focus:border-brand-500 dark:focus:border-brand-400 bg-transparent text-sm font-medium px-0.5 py-0.5 outline-none transition-colors dark:text-gray-100"
        />
      </div>

      {/* Thumbnail */}
      <div
        className="relative aspect-video w-full bg-gray-100 dark:bg-gray-800 rounded flex items-center justify-center mb-2 overflow-hidden cursor-pointer"
        onClick={() => onToggle(plate.plateIndex)}
      >
        {plate.thumbnailBase64 ? (
          <Image
            src={plate.thumbnailBase64}
            alt={name}
            fill
            loading="lazy"
            className="object-contain"
            unoptimized
          />
        ) : (
          <Printer className="h-8 w-8 text-gray-400 dark:text-gray-500" />
        )}
      </div>

      {/* Stats */}
      <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400 mb-1.5">
        <div className="flex items-center gap-2">
          <span className="font-medium">{formatTime(plate.printSeconds)}</span>
          <span>&middot;</span>
          <span>{Math.round(plate.weightGrams)}g</span>
        </div>
        {plate.toolChanges > 0 && (
          <span className="bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 px-1.5 py-0.5 rounded text-xs font-medium">
            {plate.toolChanges} changes
          </span>
        )}
      </div>

      {/* Filament colour palette */}
      {plate.tools.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {plate.tools.map((tool) => (
            <div
              key={tool.index}
              className="h-4 w-4 rounded-full border border-gray-200 dark:border-gray-600 shadow-sm shrink-0"
              style={{ backgroundColor: tool.colorHex || '#888888' }}
              title={`T${tool.index}: ${tool.materialType || 'Unknown'} — ${Math.round(tool.filamentGrams)}g`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
