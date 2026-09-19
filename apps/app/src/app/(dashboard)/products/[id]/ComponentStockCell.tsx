'use client';

import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { ApiStockSetResult, ComponentDetail, MaterialLite } from '@/lib/types/api';
import { LinkButton, Swatch, errorText } from './options-ui';
import { colourKeyHexes } from './bom-model';

const MAX_STOCK = 1_000_000;

interface StockInputProps {
  /** The balance shown (sent as expectedStockOnHand). */
  value: number;
  label: string;
  canEdit: boolean;
  /** Saves `next` against `expected`; resolves to the returned balance. */
  onSave: (next: number, expected: number) => Promise<number>;
  onReload: () => void;
}

/**
 * Printed-stock input (spec §5.2 D column 8): saves only on Enter or the ✓
 * button that appears once edited; blur and Tab never save, Esc reverts.
 * A 409 shows the server message with `Reload`.
 */
export function StockInput({ value, label, canEdit, onSave, onReload }: StockInputProps) {
  const [shown, setShown] = useState(value);
  const [draft, setDraft] = useState(String(value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ text: string; conflict: boolean } | null>(null);

  // A product reload brings the server balance.
  useEffect(() => { setShown(value); setDraft(String(value)); setError(null); }, [value]);

  if (!canEdit) return <span className="tabular-nums">{shown} units</span>;

  const dirty = draft !== String(shown);
  const parsed = /^\d+$/.test(draft.trim()) ? Number(draft) : NaN;
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_STOCK;

  async function save() {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const balance = await onSave(parsed, shown);
      setShown(balance);
      setDraft(String(balance));
    } catch (err) {
      setError({ text: errorText(err, 'Couldn\'t save the stock'), conflict: err instanceof ApiError && err.status === 409 });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-1">
        <input
          type="text"
          inputMode="numeric"
          aria-label={label}
          value={draft}
          disabled={saving}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); void save(); }
            if (e.key === 'Escape') { e.stopPropagation(); setDraft(String(shown)); setError(null); }
          }}
          className={cn(
            'h-8 w-20 rounded-md border bg-white px-2 text-sm tabular-nums dark:bg-gray-800 dark:text-gray-100',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
            dirty && !valid ? 'border-red-500' : 'border-gray-300 dark:border-gray-600',
          )}
        />
        <span className="text-xs text-gray-500 dark:text-gray-400">units</span>
        {dirty && (
          <button
            type="button"
            aria-label={`Save ${label}`}
            disabled={!valid || saving}
            onClick={() => void save()}
            className="rounded p-1 text-green-700 hover:bg-green-50 disabled:opacity-40 dark:text-green-400 dark:hover:bg-green-900/20"
          >
            <Check className="h-4 w-4" />
          </button>
        )}
      </div>
      {dirty && !valid && <p className="text-xs text-red-600 dark:text-red-400">Whole number from 0 to 1,000,000</p>}
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error.text}
          {error.conflict && <> <LinkButton onClick={onReload}>Reload</LinkButton></>}
        </p>
      )}
    </div>
  );
}

interface Props {
  productId: string;
  component: ComponentDetail;
  materials: Map<string, MaterialLite>;
  canEdit: boolean;
  onReload: () => void;
}

/** Column 8: the base column, the `Check` chip for unconfirmed legacy stock, and the per-colour popover. */
export function ComponentStockCell({ productId, component: c, materials, canEdit, onReload }: Props) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const put = async (colourKey: string | null, stockOnHand: number, expected: number) => {
    const r = await api.put<ApiStockSetResult>(`/products/${productId}/components/${c.id}/stock`, {
      colourKey, stockOnHand, expectedStockOnHand: expected,
    });
    onReload();
    return r.stockOnHand;
  };

  async function confirmStock() {
    setConfirming(true);
    setConfirmError(null);
    try {
      await put(null, c.stockOnHand, c.stockOnHand);
    } catch (err) {
      setConfirmError(errorText(err, 'Couldn\'t confirm the stock'));
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="space-y-1">
      <StockInput
        value={c.stockOnHand}
        label={`Printed stock of ${c.description}`}
        canEdit={canEdit}
        onSave={(next, expected) => put(null, next, expected)}
        onReload={onReload}
      />
      {!c.stockConfirmed && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
            Check: may include other colours
          </span>
          {canEdit && <LinkButton disabled={confirming} onClick={() => void confirmStock()}>Stock is correct</LinkButton>}
        </div>
      )}
      {confirmError && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{confirmError}</p>}
      {c.colourStock.length > 0 && (
        <div ref={boxRef} className="relative">
          <LinkButton onClick={() => setOpen(o => !o)}>per colour</LinkButton>
          {open && (
            <div className="absolute right-0 z-20 mt-1 w-72 space-y-3 rounded-md border border-gray-200 bg-white p-3 shadow-lg dark:border-gray-700 dark:bg-gray-900">
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Printed stock by colour</p>
              {c.colourStock.map(s => (
                <div key={s.colourKey} className="space-y-1">
                  <div className="flex items-center gap-1.5 text-sm text-gray-800 dark:text-gray-200">
                    {colourKeyHexes(s.colourKey, materials).map((hex, i) => <Swatch key={i} hex={hex} title={s.label} />)}
                    <span>{s.label}</span>
                  </div>
                  {s.usedBy.length > 0 && <p className="text-xs text-gray-500 dark:text-gray-400">used by {s.usedBy.join(', ')}</p>}
                  <StockInput
                    value={s.stockOnHand}
                    label={`Printed stock of ${c.description} in ${s.label}`}
                    canEdit={canEdit}
                    onSave={(next, expected) => put(s.colourKey, next, expected)}
                    onReload={onReload}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
