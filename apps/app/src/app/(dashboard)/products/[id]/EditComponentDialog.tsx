'use client';

import { useEffect, useState } from 'react';
import { writeResultMessage, type ComponentWrite } from '@printforge/types';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import type { ApiMaterial, ComponentDetail, Problem, ProductDetail } from '@/lib/types/api';
import { ImpactList } from './options-ui';
import { isMultiColour } from './options-model';
import { ComponentFields, materialOptions, useMaterialList, validateComponentFields, type ComponentFormValues } from './component-form';
import { useComponentWrite } from './useComponentWrite';

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

const SAVE_FAILED = 'Couldn\'t save the component';

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
  const writer = useComponentWrite(product.id, c?.id ?? null);
  const [values, setValues] = useState<ComponentFormValues>({ description: '', grams: '', minutes: '', quantity: '' });
  const [materialId, setMaterialId] = useState('');
  const [slotMaterials, setSlotMaterials] = useState<Record<number, string>>({});
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open || !c) return;
    setValues(valuesOf(c));
    setMaterialId(c.materialId ?? '');
    setSlotMaterials(Object.fromEntries(c.materials.map(m => [m.colorIndex, m.materialId])));
    writer.reset();
    setSubmitted(false);
    // Refill on open only; a background reload never wipes the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, c?.id]);

  if (!c) return null;
  const multi = isMultiColour(c);
  const { errors, parsed } = validateComponentFields(values);
  const materialChanged = !multi && materialId !== '' && materialId !== c.materialId;
  const slotsChanged = multi && c.materials.some(m => slotMaterials[m.colorIndex] !== m.materialId);

  function finish(warnings: Problem[]) {
    if (!parsed) return;
    const m = writeResultMessage(warnings, `Saved "${parsed.description}"`);
    toast(m.tone, m.text);
    onSaved();
    onClose();
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (!parsed || !c || (!multi && !materialId) || (multi && c.materials.some(m => !slotMaterials[m.colorIndex]))) return;
    const fields: ComponentWrite['fields'] = {};
    if (parsed.description !== c.description) fields.description = parsed.description;
    if (parsed.gramsUsed !== c.gramsUsed) fields.gramsUsed = parsed.gramsUsed;
    if (parsed.printMinutes !== c.printMinutes) fields.printMinutes = parsed.printMinutes;
    if (parsed.quantity !== c.quantity) fields.quantity = parsed.quantity;
    // A filament change first runs the open-line impact (§3.3).
    const r = await writer.submit({
      fields,
      materialId: materialChanged ? materialId : null,
      slots: slotsChanged ? c.materials.map(m => ({ colorIndex: m.colorIndex, materialId: slotMaterials[m.colorIndex] })) : null,
    }, SAVE_FAILED);
    if (r) finish(r);
  }

  async function saveAnyway() {
    const r = await writer.confirm(SAVE_FAILED);
    if (r) finish(r);
  }

  return (
    <Dialog open={open} onClose={writer.saving ? () => undefined : onClose} title={`Edit component — ${c.description}`} className="max-w-xl">
      <form onSubmit={save} className="space-y-4" noValidate>
        <ComponentFields values={values} errors={errors} showErrors={submitted} onChange={v => { setValues(v); writer.clearImpact(); }} />
        {multi ? (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">Filament per colour</legend>
            {[...c.materials].sort((a, b) => a.colorIndex - b.colorIndex).map(m => (
              <Select
                key={m.colorIndex}
                label={`Colour ${m.colorIndex + 1} (${m.gramsUsed.toFixed(1)} g per unit)`}
                value={slotMaterials[m.colorIndex] ?? ''}
                onChange={e => { setSlotMaterials(s => ({ ...s, [m.colorIndex]: e.target.value })); writer.clearImpact(); }}
                options={materialOptions(materials)}
              />
            ))}
          </fieldset>
        ) : (
          <Select
            label="Filament"
            required
            value={materialId}
            onChange={e => { setMaterialId(e.target.value); writer.clearImpact(); }}
            options={materialOptions(materials)}
            error={submitted && !materialId ? 'Select a filament' : undefined}
          />
        )}
        {writer.impact && <ImpactList impact={writer.impact} />}
        {(writer.error || loadError) && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{writer.error ?? loadError}</p>}
        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose} disabled={writer.saving}>Cancel</Button>
          {writer.impact
            ? <Button type="button" onClick={() => void saveAnyway()} disabled={writer.saving}>{writer.saving ? 'Saving…' : 'Save anyway'}</Button>
            : <Button type="submit" disabled={writer.saving}>{writer.saving ? 'Saving…' : 'Save'}</Button>}
        </div>
      </form>
    </Dialog>
  );
}
