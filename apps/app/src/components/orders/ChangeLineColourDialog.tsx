'use client';

/**
 * Change a sold line's colour (spec §5.3, S11 §4.5): split one product line
 * into same-size colour lines. Colour never changes the price or the tier, so
 * the lines keep the unit price. Save runs `?dryRun=1` first and lists the
 * lines, the queued jobs that would be cancelled and the printed stock that
 * would return; the confirmed write follows. Server messages (409 when a job
 * of the line has started) are shown as they come. Shared by order and quote
 * detail.
 */
import { useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import type { ApiActiveProduct, ChangeLineColourInput, ChangeLineColourPreview } from '@/lib/types/api';
import {
  ColourSelect, STANDARD, coloursForSize, keyToId, pickerOptionsFromActive, type PickerOptions,
} from '@/components/products/OptionPickers';

export interface ColourLine {
  id: string;
  productId: string | null;
  description: string;
  quantity: number;
  /** Effective size and colour (S4/S8 `size` / `colour`). */
  size: { id: string; name: string } | null;
  colour: { id: string; name: string } | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** `orders` or `quotes`. */
  kind: 'orders' | 'quotes';
  documentId: string;
  line: ColourLine | null;
  /** P2 `/products/active` rows (loaded by the page); null while loading. */
  products: ApiActiveProduct[] | null;
  /** After a successful write: reload the page. */
  onDone: (toast: string) => void;
}

interface Row {
  rowId: number;
  colourKey: string;
  quantity: number;
}

const errorText = (err: unknown, fallback: string) => (err instanceof Error && err.message) || fallback;

export function ChangeLineColourDialog({ open, onClose, kind, documentId, line, products, onDone }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [nextId, setNextId] = useState(1);
  const [preview, setPreview] = useState<ChangeLineColourPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sizeKey = line?.size?.id ?? STANDARD;

  useEffect(() => {
    if (!open || !line) return;
    setPreview(null); setError(null);
    setRows([{ rowId: 0, colourKey: line.colour?.id ?? STANDARD, quantity: line.quantity }]);
    setNextId(1);
  }, [open, line?.id]);

  const product = products && line?.productId ? products.find(x => x.id === line.productId) ?? null : null;
  const options: PickerOptions | null = useMemo(() => (product && product.colours.length ? pickerOptionsFromActive(product) : null), [product]);
  const loadError = products && !product
    ? 'This product is no longer active, so its colours can’t be changed.'
    : product && !product.colours.length ? 'This product has no colours.' : null;

  const total = rows.reduce((s, r) => s + r.quantity, 0);
  const target = line?.quantity ?? 0;
  const offered = useMemo(() => (options ? coloursForSize(options, sizeKey) : []), [options, sizeKey]);

  const problem = (() => {
    if (rows.some(r => !Number.isInteger(r.quantity) || r.quantity < 1)) return 'Every colour needs a quantity of at least 1';
    if (new Set(rows.map(r => r.colourKey)).size !== rows.length) return 'Each colour can appear only once';
    if (total !== target) return `The colours must add up to ${target}`;
    return null;
  })();

  function update(rowId: number, next: Partial<Row>) {
    setPreview(null);
    setRows(prev => prev.map(r => (r.rowId === rowId ? { ...r, ...next } : r)));
  }

  function addRow() {
    const used = new Set(rows.map(r => r.colourKey));
    const key = (offered.find(c => !used.has(c.key)) ?? offered[0])?.key ?? STANDARD;
    setPreview(null);
    setRows(prev => [...prev, { rowId: nextId, colourKey: key, quantity: Math.max(0, target - total) }]);
    setNextId(n => n + 1);
  }

  const body = (confirm: boolean): ChangeLineColourInput => ({
    colours: rows.map(r => ({ colourOptionId: keyToId(r.colourKey), quantity: r.quantity })),
    ...(confirm ? { confirm: true } : {}),
  });
  const url = line ? `/${kind}/${documentId}/items/${line.id}/colour` : '';

  async function check() {
    setBusy(true); setError(null);
    try {
      setPreview(await api.put<ChangeLineColourPreview>(`${url}?dryRun=1`, body(false)));
    } catch (err: unknown) {
      setError(errorText(err, 'Could not check the change'));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true); setError(null);
    try {
      await api.put(url, body(true));
      onDone(rows.length > 1 ? `Line split into ${rows.length} colours` : 'Colour changed');
    } catch (err: unknown) {
      setError(errorText(err, 'Could not change the colour'));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={busy ? () => undefined : onClose} title="Change colour">
      <div className="space-y-4">
        {line && <p className="text-sm text-gray-600 dark:text-gray-300">{line.description} · {line.quantity} units{line.size ? ` · ${line.size.name}` : ''}</p>}
        {loadError ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
        ) : !options ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading colours…</p>
        ) : (
          <>
            <div className="space-y-2">
              {rows.map((r, i) => (
                <div key={r.rowId} className="flex items-end gap-2">
                  <div className="flex-1">
                    <ColourSelect
                      options={options}
                      sizeKey={sizeKey}
                      value={r.colourKey}
                      label={`Colour ${i + 1}`}
                      onChange={k => update(r.rowId, { colourKey: k })}
                      disabled={busy}
                    />
                  </div>
                  <div className="w-24">
                    <Input
                      type="number"
                      min="1"
                      aria-label={`Colour ${i + 1}: quantity`}
                      value={r.quantity === 0 ? '' : r.quantity}
                      disabled={busy}
                      onChange={e => update(r.rowId, { quantity: parseInt(e.target.value, 10) || 0 })}
                    />
                  </div>
                  {rows.length > 1 && (
                    <button
                      type="button"
                      aria-label={`Remove colour ${i + 1}`}
                      disabled={busy}
                      onClick={() => { setPreview(null); setRows(prev => prev.filter(x => x.rowId !== r.rowId)); }}
                      className="mb-2 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-700"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between text-sm">
              {rows.length < 30 && offered.length > rows.length ? (
                <button type="button" onClick={addRow} disabled={busy} className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline dark:text-brand-400">
                  <Plus className="h-3.5 w-3.5" /> colour
                </button>
              ) : <span />}
              <span className={total === target ? 'text-gray-600 dark:text-gray-400' : 'text-amber-600 dark:text-amber-400'}>
                {rows.map(r => r.quantity).join(' + ')} = {total} of {target}
              </span>
            </div>
            {problem && rows.length > 0 && <p className="text-xs text-amber-600 dark:text-amber-400">{problem}</p>}

            {preview && (
              <div className="space-y-2 rounded-md border border-gray-200 p-3 text-sm dark:border-gray-700">
                <p className="font-medium dark:text-gray-100">This will:</p>
                <ul className="list-disc space-y-0.5 pl-5 text-gray-600 dark:text-gray-300">
                  {preview.lines.map((l, i) => <li key={i}>{l.description} × {l.quantity}</li>)}
                </ul>
                {preview.cancelledJobs.length > 0 ? (
                  <>
                    <p className="font-medium text-amber-700 dark:text-amber-300">Cancel {preview.cancelledJobs.length} queued job{preview.cancelledJobs.length === 1 ? '' : 's'}:</p>
                    <ul className="list-disc pl-5 text-gray-600 dark:text-gray-300">{preview.cancelledJobs.map(j => <li key={j.id}>{j.name}</li>)}</ul>
                  </>
                ) : kind === 'orders' && <p className="text-gray-500 dark:text-gray-400">No jobs to cancel</p>}
                {preview.stockReleased.length > 0 ? (
                  <p className="text-gray-600 dark:text-gray-300">
                    Returns to printed stock: {preview.stockReleased.map(s => `${s.componentDescription} ${s.units} (${s.colourLabel})`).join(', ')}
                  </p>
                ) : kind === 'orders' && <p className="text-gray-500 dark:text-gray-400">Nothing to return to printed stock</p>}
                {preview.warnings.map(w => <p key={w.message} className="text-red-600 dark:text-red-400">{w.message}</p>)}
              </div>
            )}
          </>
        )}
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          {preview ? (
            <Button type="button" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Confirm'}</Button>
          ) : (
            <Button type="button" onClick={check} disabled={busy || !options || !!problem}>
              {busy ? 'Checking…' : 'Save'}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
