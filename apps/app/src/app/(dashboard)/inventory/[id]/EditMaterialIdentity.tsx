'use client';

import { useEffect, useRef, useState } from 'react';
import { identityFields, initialIdentity, otherModeFor, type EditIdentity } from '@printforge/types';
import { FilamentBrandColour, toMaterialType, type Swatch } from '@/components/filament-swatch-picker';
import { api } from '@/lib/api';

interface Props {
  /** The filament as stored when the dialog opened. */
  material: { type: string; brand: string | null; color: string | null; colorHex?: string | null };
}

/** What the picker reports: any mix of the three. */
type PickerChange = { brand?: string; colour?: string; hex?: string };

const MATERIAL_TYPES = ['PLA', 'PETG', 'ABS', 'TPU', 'ASA', 'NYLON', 'RESIN', 'OTHER'];

/** The picker's "Other" option text, which the dialog selects by label. */
const OTHER_TEXT = 'Other…';

/**
 * Edit Material's Type, Color and Brand, using the same type-filtered
 * dropdowns as New Material (FilamentBrandColour, reused unchanged).
 *
 * Rendered inside the Edit Material dialog, which unmounts its children when
 * it closes, so every open starts fresh from the stored filament and Cancel
 * discards everything. The form reads `type` from the select and, only after
 * the user really changes brand or colour, `brand`, `color` and `colorHex`
 * from hidden fields. An untouched dialog sends none of the three, so they
 * stay exactly as stored (including a hex that differs from the catalogue).
 *
 * Two things keep the picker from disturbing stored values:
 * - Its hex reports before any real edit are ignored (on mount it reports ''
 *   because the catalogue hasn't loaded, then the catalogue's own hex).
 * - A stored brand or colour the dropdown doesn't offer (a disabled or
 *   hand-typed brand, 'esun' vs 'eSUN', a hand-typed colour) is put on
 *   "Other…" once the catalogue is known, so its text shows in the picker's
 *   name field instead of the select silently showing its first option.
 */
export function EditMaterialIdentity({ material }: Props) {
  const [type, setType] = useState(material.type);
  const [v, setV] = useState<EditIdentity>(() => initialIdentity(material));
  const dirtyRef = useRef(false);
  const initialising = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const typeRef = useRef(type);
  typeRef.current = type;

  function onPicker(next: PickerChange) {
    if (initialising.current) return;
    if ('brand' in next || 'colour' in next) {
      dirtyRef.current = true;
      setV((p) => ({ dirty: true, brand: next.brand ?? p.brand, colour: next.colour ?? p.colour, hex: next.hex ?? p.hex }));
      return;
    }
    const hex = next.hex;
    if (hex !== undefined && dirtyRef.current) setV((p) => ({ ...p, hex }));
  }

  /**
   * Choose "Other…" in the picker's Brand or Color dropdown the way a user
   * would, so the picker enters its own Other mode. React runs the select's
   * onChange synchronously inside dispatchEvent; the clearing report it makes
   * is ignored, and the picker's name field then shows the stored value. If
   * the label or option can't be found, nothing happens and values are kept.
   */
  function chooseOther(label: 'Brand' | 'Color') {
    const labelEl = Array.from(box.current?.querySelectorAll('label') ?? []).find((l) => l.textContent?.trim() === label);
    const select = labelEl?.htmlFor ? document.getElementById(labelEl.htmlFor) : null;
    if (!(select instanceof HTMLSelectElement)) return;
    const option = Array.from(select.options).find((o) => o.text === OTHER_TEXT);
    if (!option) return;
    initialising.current = true;
    try {
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    } finally {
      initialising.current = false;
    }
  }

  // The picker loads the same catalogue itself but doesn't expose it. A
  // failure counts as an empty catalogue: non-empty values then open on Other.
  useEffect(() => {
    let live = true;
    api.get<{ results?: Swatch[] }>('/filament-catalog?limit=5000')
      .then((r) => r?.results ?? [])
      .catch((): Swatch[] => [])
      .then((swatches) => {
        if (!live || dirtyRef.current) return; // closed, or the user got there first
        const mode = otherModeFor({
          swatches,
          toType: toMaterialType,
          type: typeRef.current,
          brand: material.brand ?? '',
          colour: material.color ?? '',
        });
        if (mode === 'brand') chooseOther('Brand'); // the picker opens the Color name field too
        else if (mode === 'colour') chooseOther('Color');
      });
    return () => { live = false; };
    // Mount only: each open of the dialog mounts this component afresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fields = identityFields(v);

  return (
    <>
      <div className="space-y-1">
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Type</label>
        <select name="type" value={type} onChange={(e) => setType(e.target.value)} className="flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100">
          {MATERIAL_TYPES.map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>
      <div ref={box} className="space-y-4">
        <FilamentBrandColour materialType={type} brand={v.brand} colour={v.colour} hex={v.hex} onChange={onPicker} />
        {fields && (
          <>
            <input type="hidden" name="brand" value={fields.brand} />
            <input type="hidden" name="color" value={fields.color} />
            <input type="hidden" name="colorHex" value={fields.colorHex} />
          </>
        )}
      </div>
    </>
  );
}
