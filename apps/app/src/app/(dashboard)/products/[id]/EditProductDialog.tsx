'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { policyLabel } from '@/lib/product-format';
import type { ProductDetail, SurplusPolicy } from '@/lib/types/api';

interface Props {
  product: ProductDetail;
  open: boolean;
  onClose: () => void;
  /** Called after a successful save; the page reloads product and cost. */
  onSaved: () => void;
}

interface Form {
  name: string;
  description: string;
  sku: string;
  baseOptionLabel: string;
  standardColourLabel: string;
  surplusPolicy: SurplusPolicy;
  colorChanges: string;
}

function formOf(p: ProductDetail): Form {
  return {
    name: p.name,
    description: p.description ?? '',
    sku: p.sku ?? '',
    baseOptionLabel: p.baseOptionLabel ?? '',
    standardColourLabel: p.standardColourLabel ?? '',
    surplusPolicy: p.surplusPolicy,
    colorChanges: String(p.colorChanges ?? 0),
  };
}

/** Empty (after trimming) is sent as null, so a field can be cleared. */
function orNull(v: string): string | null {
  const t = v.trim();
  return t === '' ? null : t;
}

function validate(f: Form, showPurge: boolean): string | null {
  if (!f.name.trim()) return 'Name is required';
  if (f.name.trim().length > 200) return 'Name must be 200 characters or fewer';
  if (f.description.trim().length > 2000) return 'Description must be 2000 characters or fewer';
  if (f.sku.trim().length > 64) return 'SKU must be 64 characters or fewer';
  if (f.baseOptionLabel.trim().length > 40) return 'Standard size name must be 40 characters or fewer';
  if (f.standardColourLabel.trim().length > 40) return 'Standard colour name must be 40 characters or fewer';
  if (showPurge) {
    const n = Number(f.colorChanges);
    if (f.colorChanges.trim() === '' || !Number.isInteger(n) || n < 0 || n > 10000) {
      return 'Colour changes per unit must be a whole number from 0 to 10000';
    }
  }
  return null;
}

/** Edit product (spec §5.1). Only the P6 allowlist is sent; price is never editable. */
export function EditProductDialog({ product, open, onClose, onSaved }: Props) {
  const [form, setForm] = useState<Form>(() => formOf(product));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Slicer weights already include purge, so the purge input would double-count it.
  const showPurge = !product.hasSlicerComponent;

  // Refill from the product each time the dialog opens — but not while it is
  // open, so a background reload never wipes what is being typed.
  useEffect(() => {
    if (open) {
      setForm(formOf(product));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm(f => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const problem = validate(form, showPurge);
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError(null);
    try {
      await api.patch<ProductDetail>(`/products/${product.id}`, {
        name: form.name.trim(),
        description: orNull(form.description),
        sku: orNull(form.sku),
        baseOptionLabel: orNull(form.baseOptionLabel),
        standardColourLabel: orNull(form.standardColourLabel),
        surplusPolicy: form.surplusPolicy,
        ...(showPurge ? { colorChanges: Number(form.colorChanges) } : {}),
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={saving ? () => undefined : onClose} title="Edit product" className="max-w-xl">
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <Input label="Name" required maxLength={200} value={form.name} onChange={e => set('name', e.target.value)} />
        <Textarea
          label="Description"
          maxLength={2000}
          value={form.description}
          placeholder="Leave empty for no description"
          onChange={e => set('description', e.target.value)}
        />
        <Input
          label="SKU"
          maxLength={64}
          value={form.sku}
          placeholder="Leave empty for no SKU"
          className="font-mono"
          onChange={e => set('sku', e.target.value)}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Input
              label="Standard size name"
              maxLength={40}
              value={form.baseOptionLabel}
              placeholder="Standard"
              onChange={e => set('baseOptionLabel', e.target.value)}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Shown when the product has sizes, e.g. Regular.</p>
          </div>
          <div>
            <Input
              label="Standard colour name"
              maxLength={40}
              value={form.standardColourLabel}
              placeholder="Standard"
              onChange={e => set('standardColourLabel', e.target.value)}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">The colours the files were sliced with, e.g. Black.</p>
          </div>
        </div>
        <div>
          <Select
            label="Extras on the last plate"
            value={form.surplusPolicy}
            onChange={e => set('surplusPolicy', e.target.value as SurplusPolicy)}
            options={(['KEEP_FOR_STOCK', 'CANCEL_ON_PRINTER'] as SurplusPolicy[]).map(p => ({ value: p, label: policyLabel(p) }))}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Default for new jobs when a plate layout prints more units than needed.
          </p>
        </div>
        {showPurge && (
          <div>
            <Input
              label="Colour changes per unit"
              type="number"
              min={0}
              max={10000}
              step={1}
              value={form.colorChanges}
              onChange={e => set('colorChanges', e.target.value)}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Each change adds the purge waste set in Settings to the cost. Changing it recalculates the price.
            </p>
          </div>
        )}
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
