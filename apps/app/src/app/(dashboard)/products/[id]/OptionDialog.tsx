'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { ApiKeepStandard, ApiOptionRow, ColourOptionDetail, ProductDetail, SizeOptionDetail } from '@/lib/types/api';
import { KeepStandardStep, errorText } from './options-ui';
import {
  isLastActive, keepStepLabel, keepStepProblem, keepStepText, lastOfAxisText, needsKeepStandardOnActivate, needsKeepStandardOnCreate,
  type OptionKind,
} from './options-model';

interface Props {
  product: ProductDetail;
  open: boolean;
  /** Preset by `Add size` / `Add colour`; shown as text when editing. */
  kind: OptionKind;
  /** null = add. */
  option: SizeOptionDetail | ColourOptionDetail | null;
  onClose: () => void;
  onSaved: () => void;
}

interface Form {
  name: string;
  sku: string;
  isActive: boolean;
  sortOrder: string;
  keepLabel: string;
  keepSell: boolean;
}

function formOf(product: ProductDetail, kind: OptionKind, option: Props['option']): Form {
  return {
    name: option?.name ?? '',
    sku: option?.sku ?? '',
    isActive: option?.isActive ?? true,
    sortOrder: option ? String(option.sortOrder) : '',
    keepLabel: keepStepLabel(product, kind),
    keepSell: true,
  };
}

/**
 * Add or edit a size or colour (spec §5.1 OptionDialog): name, SKU, active,
 * sort order. No price, minutes or grams — prices are automatic per size and a
 * colour never has one. O1 always sends `kind`; O2 never does (the server
 * rejects a kind change there — kinds change in ClassifyOptionsDialog, O7).
 */
export function OptionDialog({ product, open, kind, option, onClose, onSaved }: Props) {
  const { toast } = useToast();
  const [form, setForm] = useState<Form>(() => formOf(product, kind, option));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const word = kind === 'SIZE' ? 'size' : 'colour';
  // Adding the first active option of a kind, or re-activating one on an axis with none active (§3.1 rules 6 and 7).
  const keepStep = option
    ? form.isActive && needsKeepStandardOnActivate(product, kind, option)
    : needsKeepStandardOnCreate(product, kind);

  useEffect(() => {
    if (open) {
      setForm(formOf(product, kind, option));
      setError(null);
    }
    // Refill only when the dialog opens, never while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm(f => ({ ...f, [key]: value }));
  }

  function validate(): string | null {
    const name = form.name.trim();
    if (!name) return 'Enter a name';
    if (name.length > 80) return 'Name must be 80 characters or fewer';
    if (form.sku.trim().length > 64) return 'SKU must be 64 characters or fewer';
    if (form.sortOrder.trim() !== '') {
      const n = Number(form.sortOrder);
      if (!Number.isInteger(n) || n < 0 || n > 10000) return 'Sort order must be a whole number from 0 to 10000';
    }
    if (keepStep) return keepStepProblem(kind, form.keepLabel);
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const problem = validate();
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError(null);
    const sortOrder = form.sortOrder.trim() === '' ? undefined : Number(form.sortOrder);
    const keepStandard: ApiKeepStandard | undefined = keepStep
      ? { label: form.keepLabel.trim(), sellInShop: form.keepSell }
      : undefined;
    try {
      if (option) {
        await api.patch<ApiOptionRow>(`/products/${product.id}/variants/${option.id}`, {
          name: form.name.trim(),
          sku: form.sku.trim() || null,
          isActive: form.isActive,
          ...(sortOrder !== undefined ? { sortOrder } : {}),
          ...(keepStandard ? { keepStandard } : {}),
        });
        toast('success', `${form.name.trim()} saved`);
      } else {
        const created = await api.post<ApiOptionRow>(`/products/${product.id}/variants`, {
          name: form.name.trim(),
          sku: form.sku.trim() || null,
          kind,
          isActive: form.isActive,
          ...(sortOrder !== undefined ? { sortOrder } : {}),
          ...(keepStandard ? { keepStandard } : {}),
        });
        toast('success', kind === 'COLOUR'
          ? `Colour ${created.name} added — choose its filaments to offer it in the shop`
          : `Size ${created.name} added — add its components in the bill of materials`);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(errorText(err, 'Save failed'));
    } finally {
      setSaving(false);
    }
  }

  const deactivatingLast = !!option && option.isActive && !form.isActive && isLastActive(product, kind, option.id);

  return (
    <Dialog
      open={open}
      onClose={saving ? () => undefined : onClose}
      title={option ? `Edit ${word} — ${option.name}` : `Add ${word}`}
      className="max-w-xl"
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Kind: <span className="font-medium text-gray-800 dark:text-gray-200">{kind === 'SIZE' ? 'Size' : 'Colour'}</span>
          {kind === 'SIZE'
            ? ' — its own sliced files and components; its price is calculated automatically.'
            : ' — the same files printed in other filaments; it never changes the price.'}
        </p>
        <Input label="Name" required maxLength={80} value={form.name} placeholder={kind === 'SIZE' ? 'e.g. Large' : 'e.g. Red'} onChange={e => set('name', e.target.value)} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input label="SKU (optional)" maxLength={64} className="font-mono" value={form.sku} onChange={e => set('sku', e.target.value)} />
          <div>
            <Input label="Sort order" type="number" min={0} max={10000} step={1} value={form.sortOrder} placeholder="Last" onChange={e => set('sortOrder', e.target.value)} />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Lower numbers are listed first (0–10000).</p>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input type="checkbox" className="h-4 w-4 rounded border-gray-300" checked={form.isActive} onChange={e => set('isActive', e.target.checked)} />
          Active — offered on new orders, quotes and jobs
        </label>
        {deactivatingLast && (
          <p className="text-sm text-amber-700 dark:text-amber-300">{lastOfAxisText(product, kind)}</p>
        )}

        {keepStep && (
          <KeepStandardStep
            {...keepStepText(product, kind, form.keepSell)}
            label={form.keepLabel}
            sellInShop={form.keepSell}
            onLabel={v => set('keepLabel', v)}
            onSell={v => set('keepSell', v)}
          />
        )}

        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? 'Saving…' : option ? 'Save' : `Add ${word}`}</Button>
        </div>
      </form>
    </Dialog>
  );
}
