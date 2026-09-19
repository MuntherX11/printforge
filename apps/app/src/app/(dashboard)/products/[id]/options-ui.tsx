'use client';

/** Small presentational pieces shared by the Sizes & colours section (spec §5.2 C). */
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import type { ApiOpenLineImpact } from '@/lib/types/api';

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

/** Accessible on/off switch in the style of Settings → Addons. */
export function Toggle({ checked, label, disabled, onChange }: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        checked ? 'bg-brand-600' : 'bg-gray-300 dark:bg-gray-600',
      )}
    >
      <span className={cn('inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform', checked ? 'translate-x-5' : 'translate-x-1')} />
    </button>
  );
}

/** The open-line impact of a configuration change (spec §3.3), listed before `Save anyway`. */
export function ImpactList({ impact }: { impact: ApiOpenLineImpact[] }) {
  if (!impact.length) return null;
  return (
    <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
      <p className="font-medium">
        {impact.length} open {impact.length === 1 ? 'line' : 'lines'} will print differently:
      </p>
      <ul className="mt-1 max-h-48 list-disc space-y-1 overflow-y-auto pl-5">
        {impact.map(i => (
          <li key={`${i.kind}-${i.lineId}`}>
            <span className="font-medium">{i.number}</span> {i.description} ×{i.quantity} units
            {i.partlyPlanned && <span className="text-amber-700 dark:text-amber-300"> (partly planned already — planned units keep the old colour)</span>}
            {i.changes.length > 0 && <span className="block text-xs">{i.changes.join('; ')}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The required `Keep selling …` step (spec §3.1 rules 6 and 7) shown by
 * OptionDialog and ClassifyOptionsDialog.
 */
export function KeepStandardStep({ intro, label, sellInShop, placeholder, note, onLabel, onSell }: {
  intro: string;
  label: string;
  sellInShop: boolean;
  placeholder: string;
  /** Extra sentence (the unticked-default explanation). */
  note?: string;
  onLabel: (v: string) => void;
  onSell: (v: boolean) => void;
}) {
  return (
    <fieldset className="space-y-2 rounded-md border border-brand-200 bg-brand-50/50 p-3 dark:border-brand-800 dark:bg-brand-900/10">
      <legend className="px-1 text-sm font-medium text-gray-800 dark:text-gray-200">Keep selling it as</legend>
      <p className="text-sm text-gray-700 dark:text-gray-300">{intro}</p>
      {note && <p className="text-xs text-gray-600 dark:text-gray-400">{note}</p>}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1">
          <Input label="Name" required maxLength={40} value={label} placeholder={placeholder} onChange={e => onLabel(e.target.value)} />
        </div>
        <label className="flex h-10 items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input type="checkbox" className="h-4 w-4 rounded border-gray-300" checked={sellInShop} onChange={e => onSell(e.target.checked)} />
          Sell in the shop
        </label>
      </div>
    </fieldset>
  );
}

/** A small text button used in table action cells. */
export function LinkButton({ children, onClick, disabled, tone, title }: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'danger';
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={cn(
        'rounded px-1.5 py-1 text-xs font-medium hover:underline disabled:cursor-not-allowed disabled:opacity-40 disabled:no-underline',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        tone === 'danger' ? 'text-red-600 dark:text-red-400' : 'text-brand-600 dark:text-brand-400',
      )}
    >
      {children}
    </button>
  );
}

export function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
