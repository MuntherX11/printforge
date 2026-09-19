'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { ApiMaterial, ComponentDetail, ProductDetail } from '@/lib/types/api';
import { errorText } from './options-ui';
import { ComponentFields, materialOptions, useMaterialList, validateComponentFields, type ComponentFormValues } from './component-form';

const FIXED = '__fixed';
const NOT_LINKED = '__none';

interface Props {
  product: ProductDetail;
  open: boolean;
  /** null = the standard size. */
  sizeOptionId: string | null;
  scopeLabel: string;
  loadMaterials: () => Promise<ApiMaterial[]>;
  onClose: () => void;
  onSaved: () => void;
}

const EMPTY: ComponentFormValues = { description: '', grams: '', minutes: '', quantity: '1' };

/**
 * `Add manually` (spec §5.1, P9): description, filament, grams and minutes per
 * unit, units per product, and — when the product has colour slots — which
 * slot the part follows (`Fixed` or `Not linked` otherwise).
 */
export function AddComponentDialog({ product, open, sizeOptionId, scopeLabel, loadMaterials, onClose, onSaved }: Props) {
  const { toast } = useToast();
  const { materials, error: loadError } = useMaterialList(open, loadMaterials);
  const [values, setValues] = useState<ComponentFormValues>(EMPTY);
  const [materialId, setMaterialId] = useState('');
  const [link, setLink] = useState(NOT_LINKED);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setValues(EMPTY);
    setMaterialId('');
    setLink(NOT_LINKED);
    setSubmitted(false);
    setError(null);
  }, [open]);

  const { errors, parsed } = validateComponentFields(values);
  const slots = [...product.colourSlots].sort((a, b) => a.sortOrder - b.sortOrder);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (!parsed || !materialId) return;
    setSaving(true);
    setError(null);
    try {
      await api.post<ComponentDetail>(`/products/${product.id}/components`, {
        ...parsed,
        materialId,
        sizeOptionId,
        ...(slots.length === 0 || link === NOT_LINKED
          ? {}
          : link === FIXED ? { colourFixed: true } : { colourSlotId: link }),
      });
      toast('success', `Added "${parsed.description}" to ${scopeLabel}`);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorText(err, 'Couldn\'t add the component'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={saving ? () => undefined : onClose} title={`Add component — ${scopeLabel}`} className="max-w-xl">
      <form onSubmit={save} className="space-y-4" noValidate>
        <ComponentFields values={values} errors={errors} showErrors={submitted} onChange={setValues} />
        <Select
          label="Filament"
          required
          value={materialId}
          onChange={e => setMaterialId(e.target.value)}
          options={materialOptions(materials)}
          error={submitted && !materialId ? 'Select a filament' : undefined}
        />
        {slots.length > 0 && (
          <div>
            <Select
              label="Colour"
              value={link}
              onChange={e => setLink(e.target.value)}
              options={[
                ...slots.map(s => ({ value: s.id, label: `Follows colour slot "${s.name}"` })),
                { value: FIXED, label: 'Fixed — always this filament' },
                { value: NOT_LINKED, label: 'Not linked — decide later' },
              ]}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              A part that isn&apos;t linked keeps colours out of the shop on {scopeLabel} until you link it in Edit links.
            </p>
          </div>
        )}
        {(error || loadError) && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error ?? loadError}</p>}
        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? 'Adding…' : 'Add component'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
