'use client';

/**
 * Editable plate list for one component group (spec §5.1, §3.5): which plate
 * layouts to print and how many of each. Used by the product page's New job
 * dialog and (WP10) the order plan dialog. Controlled: the parent owns
 * `plates` and sends them to the API (J1/J2 `plates`, J5 `rows[].plates`).
 */
import { Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatGrams, formatMinutes } from '@/lib/product-format';

export interface PlanLayoutOption {
  /** null = the implicit single unit (the component's own per-unit values). */
  layoutId: string | null;
  label: string;
  unitsPerPlate: number;
  plateMinutes?: number;
  plateGrams?: number;
}

export interface PlanPlate {
  layoutId: string | null;
  plateCount: number;
}

export const MAX_PLATE_COUNT = 10_000;

const keyOf = (id: string | null) => id ?? '__single';

export function unitsCovered(plates: PlanPlate[], layouts: PlanLayoutOption[]): number {
  return plates.reduce((n, p) => n + p.plateCount * (layouts.find(l => l.layoutId === p.layoutId)?.unitsPerPlate ?? 0), 0);
}

/** A problem with the edited plan, or null when J1/J2 would accept it (§3.5 validatePlan). */
export function planProblem(plates: PlanPlate[], layouts: PlanLayoutOption[], unitsRequired: number): string | null {
  if (plates.some(p => !Number.isInteger(p.plateCount) || p.plateCount < 1 || p.plateCount > MAX_PLATE_COUNT)) {
    return `Plate counts must be whole numbers from 1 to ${MAX_PLATE_COUNT.toLocaleString('en-US')}`;
  }
  if (plates.some(p => !layouts.some(l => l.layoutId === p.layoutId))) return 'A plate layout is no longer available';
  const covered = unitsCovered(plates, layouts);
  if (covered < unitsRequired) return `Plates cover ${covered} units but ${unitsRequired} are needed`;
  return null;
}

function layoutText(l: PlanLayoutOption): string {
  const bits = [l.layoutId === null ? 'Single unit' : `×${l.unitsPerPlate}`];
  if (l.plateMinutes != null) bits.push(formatMinutes(l.plateMinutes));
  if (l.plateGrams != null) bits.push(formatGrams(l.plateGrams));
  return bits.join(' · ') + (l.layoutId === null ? '' : ' per plate');
}

interface Props {
  unitsRequired: number;
  layouts: PlanLayoutOption[];
  plates: PlanPlate[];
  onChange: (plates: PlanPlate[]) => void;
  disabled?: boolean;
  /** Smaller controls for table cells. */
  compact?: boolean;
  /** Accessible name prefix, e.g. the component name. */
  label?: string;
}

export function PlatePlanEditor({ unitsRequired, layouts, plates, onChange, disabled, compact, label = 'Plate' }: Props) {
  const covered = unitsCovered(plates, layouts);
  const problem = planProblem(plates, layouts, unitsRequired);
  const unused = layouts.filter(l => !plates.some(p => p.layoutId === l.layoutId));
  const control = cn(
    'rounded-md border border-gray-300 bg-white px-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50',
    compact ? 'h-8' : 'h-9',
  );

  const update = (i: number, next: Partial<PlanPlate>) => onChange(plates.map((p, j) => (j === i ? { ...p, ...next } : p)));

  return (
    <div className="space-y-1.5">
      {plates.map((p, i) => (
        <div key={`${keyOf(p.layoutId)}-${i}`} className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            min={1}
            max={MAX_PLATE_COUNT}
            step={1}
            aria-label={`${label} ${i + 1}: number of plates`}
            value={p.plateCount === 0 ? '' : p.plateCount}
            disabled={disabled}
            onChange={e => update(i, { plateCount: e.target.value === '' ? 0 : Number(e.target.value) })}
            className={cn(control, 'w-20 tabular-nums')}
          />
          <span className="text-sm text-gray-500 dark:text-gray-400">plates of</span>
          <select
            aria-label={`${label} ${i + 1}: layout`}
            value={keyOf(p.layoutId)}
            disabled={disabled}
            onChange={e => update(i, { layoutId: e.target.value === '__single' ? null : e.target.value })}
            className={cn(control, 'min-w-[10rem] flex-1')}
          >
            {layouts.map(l => (
              <option key={keyOf(l.layoutId)} value={keyOf(l.layoutId)}>{layoutText(l)}</option>
            ))}
          </select>
          {plates.length > 1 && !disabled && (
            <button
              type="button"
              aria-label={`Remove ${label.toLowerCase()} ${i + 1}`}
              onClick={() => onChange(plates.filter((_, j) => j !== i))}
              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-700"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        {problem ? (
          <span role="alert" className="text-red-600 dark:text-red-400">{problem}</span>
        ) : (
          <span className="text-gray-600 dark:text-gray-400">
            Prints {covered} units for {unitsRequired} needed · {covered - unitsRequired} extra
          </span>
        )}
        {!disabled && unused.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([...plates, { layoutId: unused[0].layoutId, plateCount: 1 }])}
            className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            <Plus className="h-3.5 w-3.5" /> Add plate
          </button>
        )}
      </div>
    </div>
  );
}
