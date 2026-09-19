'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type {
  ApiComponentWriteResult, ApiImpactPreview, ApiMaterial, ApiOpenLineImpact, ComponentDetail, Problem, ProductDetail,
} from '@/lib/types/api';
import { ImpactList, errorText } from './options-ui';
import { isMultiColour } from './options-model';
import { ComponentFields, materialOptions, useMaterialList, validateComponentFields, type ComponentFormValues } from './component-form';

interface Props {
  product: ProductDetail;
  component: ComponentDetail | null;
  open: boolean;
  loadMaterials: () => Promise<ApiMaterial[]>;
  onClose: () => void;
  onSaved: () => void;
}

function valuesOf(c: ComponentDetail): ComponentFormValues {
  return { description: c.description, grams: String(c.gramsUsed), minutes: String(c.printMinutes), quantity: String(c.quantity) };
}

/**
 * Edit a component (spec §5.1, P10/P11). Single-material parts edit their
 * filament here; multicolour parts list one filament select per colour (P11).
 * Colour links are edited in `Edit links` only. A filament change runs the
 * dry run first and lists the open-line impact before `Save anyway`; a
 * STOCK_REKEYED warning is shown after saving.
 */
export function EditComponentDialog({ product, component: c, open, loadMaterials, onClose, onSaved }: Props) {
  const { toast } = useToast();
  const { materials, error: loadError } = useMaterialList(open, loadMaterials);
  const [values, setValues] = useState<ComponentFormValues>({ description: '', grams: '', minutes: '', quantity: '' });
  const [materialId, setMaterialId] = useState('');
  const [slotMaterials, setSlotMaterials] = useState<Record<number, string>>({});
  const [impact, setImpact] = useState<ApiOpenLineImpact[] | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !c) return;
    setValues(valuesOf(c));
    setMaterialId(c.materialId ?? '');
    setSlotMaterials(Object.fromEntries(c.materials.map(m => [m.colorIndex, m.materialId])));
    setImpact(null);
    setSubmitted(false);
    setError(null);
    // Refill on open only; a background reload never wipes the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, c?.id]);

  if (!c) return null;
  const multi = isMultiColour(c);
  const { errors, parsed } = validateComponentFields(values);
  const base = `/products/${product.id}/components/${c.id}`;
  const materialChanged = !multi && materialId !== '' && materialId !== c.materialId;
  const slotsChanged = multi && c.materials.some(m => slotMaterials[m.colorIndex] !== m.materialId);
  const slotsBody = () => ({ slots: c.materials.map(m => ({ colorIndex: m.colorIndex, materialId: slotMaterials[m.colorIndex] })) });

  async function write(confirm: boolean) {
    if (!parsed || !c) return;
    const warnings: Problem[] = [];
    const patch: Record<string, unknown> = {};
    if (parsed.description !== c.description) patch.description = parsed.description;
    if (parsed.gramsUsed !== c.gramsUsed) patch.gramsUsed = parsed.gramsUsed;
    if (parsed.printMinutes !== c.printMinutes) patch.printMinutes = parsed.printMinutes;
    if (parsed.quantity !== c.quantity) patch.quantity = parsed.quantity;
    if (materialChanged) patch.materialId = materialId;
    if (Object.keys(patch).length) {
      const r = await api.patch<ApiComponentWriteResult>(base, { ...patch, ...(confirm ? { confirm: true } : {}) });
      warnings.push(...(r.warnings ?? []));
    }
    if (slotsChanged) {
      const r = await api.put<ApiComponentWriteResult>(`${base}/materials`, { ...slotsBody(), ...(confirm ? { confirm: true } : {}) });
      warnings.push(...(r.warnings ?? []));
    }
    const shown = warnings.filter(w => w.code !== 'OPEN_LINES_AFFECTED');
    toast(shown.length ? 'warning' : 'success', shown.length ? shown.map(w => w.message).join(' ') : `Saved "${parsed.description}"`);
    onSaved();
    onClose();
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (!parsed || (!multi && !materialId) || (multi && c!.materials.some(m => !slotMaterials[m.colorIndex]))) return;
    setSaving(true);
    setError(null);
    try {
      // A filament change first runs the open-line impact (§3.3).
      let found: ApiOpenLineImpact[] = [];
      if (materialChanged) found = (await api.patch<ApiImpactPreview>(`${base}?dryRun=1`, { materialId })).impact ?? [];
      if (slotsChanged) found = [...found, ...((await api.put<ApiImpactPreview>(`${base}/materials?dryRun=1`, slotsBody())).impact ?? [])];
      if (found.length) { setImpact(found); return; }
      await write(false);
    } catch (err) {
      setError(errorText(err, 'Couldn\'t save the component'));
    } finally {
      setSaving(false);
    }
  }

  async function saveAnyway() {
    setSaving(true);
    setError(null);
    try {
      await write(true);
    } catch (err) {
      setError(errorText(err, 'Couldn\'t save the component'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={saving ? () => undefined : onClose} title={`Edit component — ${c.description}`} className="max-w-xl">
      <form onSubmit={save} className="space-y-4" noValidate>
        <ComponentFields values={values} errors={errors} showErrors={submitted} onChange={v => { setValues(v); setImpact(null); }} />
        {multi ? (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">Filament per colour</legend>
            {[...c.materials].sort((a, b) => a.colorIndex - b.colorIndex).map(m => (
              <Select
                key={m.colorIndex}
                label={`Colour ${m.colorIndex + 1} (${m.gramsUsed.toFixed(1)} g per unit)`}
                value={slotMaterials[m.colorIndex] ?? ''}
                onChange={e => { setSlotMaterials(s => ({ ...s, [m.colorIndex]: e.target.value })); setImpact(null); }}
                options={materialOptions(materials)}
              />
            ))}
          </fieldset>
        ) : (
          <Select
            label="Filament"
            required
            value={materialId}
            onChange={e => { setMaterialId(e.target.value); setImpact(null); }}
            options={materialOptions(materials)}
            error={submitted && !materialId ? 'Select a filament' : undefined}
          />
        )}
        {impact && <ImpactList impact={impact} />}
        {(error || loadError) && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error ?? loadError}</p>}
        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          {impact
            ? <Button type="button" onClick={() => void saveAnyway()} disabled={saving}>{saving ? 'Saving…' : 'Save anyway'}</Button>
            : <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>}
        </div>
      </form>
    </Dialog>
  );
}
