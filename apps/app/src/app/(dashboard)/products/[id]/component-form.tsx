'use client';

/** Fields shared by AddComponentDialog and EditComponentDialog (spec §5.1, bounds §4.7 P9/P10). */
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import type { ApiMaterial } from '@/lib/types/api';
import { errorText } from './options-ui';
import { parseDecimal, parseWhole } from './bom-model';

export interface ComponentFormValues {
  description: string;
  grams: string;
  minutes: string;
  quantity: string;
}

export interface ParsedComponentFields {
  description: string;
  gramsUsed: number;
  printMinutes: number;
  quantity: number;
}

export type ComponentFieldErrors = Partial<Record<keyof ComponentFormValues, string>>;

export function validateComponentFields(v: ComponentFormValues): { errors: ComponentFieldErrors; parsed: ParsedComponentFields | null } {
  const errors: ComponentFieldErrors = {};
  const description = v.description.trim();
  if (!description) errors.description = 'Enter a description';
  else if (description.length > 120) errors.description = 'At most 120 characters';
  const gramsUsed = parseDecimal(v.grams, 0.1, 100_000);
  if (gramsUsed === null) errors.grams = 'Grams from 0.1 to 100,000';
  const printMinutes = parseDecimal(v.minutes, 0, 100_000);
  if (printMinutes === null) errors.minutes = 'Minutes from 0 to 100,000';
  const quantity = parseWhole(v.quantity, 1, 1000);
  if (quantity === null) errors.quantity = 'Whole number from 1 to 1,000';
  const ok = Object.keys(errors).length === 0;
  return { errors, parsed: ok ? { description, gramsUsed: gramsUsed!, printMinutes: printMinutes!, quantity: quantity! } : null };
}

/** Filaments, loaded once the dialog opens (cached by useProduct for the page lifetime). */
export function useMaterialList(open: boolean, load: () => Promise<ApiMaterial[]>) {
  const [materials, setMaterials] = useState<ApiMaterial[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    load().then(m => { if (live) setMaterials([...m].sort((a, b) => a.name.localeCompare(b.name))); })
      .catch(err => { if (live) setError(errorText(err, 'Couldn\'t load filaments')); });
    return () => { live = false; };
  }, [open, load]);
  return { materials, error };
}

export function materialOptions(materials: ApiMaterial[] | null, placeholder = '— select filament —') {
  return [
    { value: '', label: materials ? placeholder : 'Loading filaments…' },
    ...(materials ?? []).map(m => ({ value: m.id, label: `${m.name} (${m.type})` })),
  ];
}

export function ComponentFields({ values, errors, onChange, showErrors }: {
  values: ComponentFormValues;
  errors: ComponentFieldErrors;
  showErrors: boolean;
  onChange: (next: ComponentFormValues) => void;
}) {
  const set = (k: keyof ComponentFormValues) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...values, [k]: e.target.value });
  const err = (k: keyof ComponentFormValues) => (showErrors ? errors[k] : undefined);
  return (
    <>
      <Input label="Description" required maxLength={120} value={values.description} onChange={set('description')} error={err('description')} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Input label="Grams per unit (g)" required type="number" min={0.1} max={100000} step="0.1" inputMode="decimal"
          value={values.grams} onChange={set('grams')} error={err('grams')} />
        <Input label="Print minutes per unit (min)" required type="number" min={0} max={100000} step="0.1" inputMode="decimal"
          value={values.minutes} onChange={set('minutes')} error={err('minutes')} />
        <Input label="Units per product" required type="number" min={1} max={1000} step={1} inputMode="numeric"
          value={values.quantity} onChange={set('quantity')} error={err('quantity')} />
      </div>
    </>
  );
}

