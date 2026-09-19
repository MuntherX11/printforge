'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useFormatCurrency } from '@/lib/locale-context';
import type {
  ApiAssignmentsResult, ApiImpactPreview, ApiMaterial, ApiOpenLineImpact, ColourOptionDetail, ColourSlotDetail, ProductDetail,
  ProductCostPayload,
} from '@/lib/types/api';
import { ImpactList, Swatch, errorText } from './options-ui';
import { STANDARD_KEY, allComponents, orderedSizes, slotPartLabel, standardSizeLabel } from './options-model';

interface Props {
  product: ProductDetail;
  colour: ColourOptionDetail | null;
  cost: ProductCostPayload | null;
  open: boolean;
  loadMaterials: () => Promise<ApiMaterial[]>;
  onClose: () => void;
  onSaved: () => void;
}

const AS_SLICED = '';

/** "Box, Lid (colour 1) · Large Box, Large Lid (colour 1)": the linked parts of a slot, per size. */
function linkedParts(product: ProductDetail, slot: ColourSlotDetail): string {
  const comps = allComponents(product);
  const bySize = new Map<string, string[]>();
  for (const l of slot.links) {
    const k = l.sizeOptionId ?? STANDARD_KEY;
    const label = slotPartLabel(comps.find(c => c.id === l.componentId), l.componentDescription, l.colorIndex);
    bySize.set(k, [...(bySize.get(k) ?? []), label]);
  }
  return [...bySize.values()].map(v => v.join(', ')).join(' · ');
}

/**
 * `Filaments for <colour>` (spec §5.2 C, O5): one filament per colour slot,
 * `As sliced (standard)` first, filaments of the linked parts' plastic listed
 * first with a warning on a type change, and `Made in` per size. Save runs a
 * dry run first and lists the open-line impact before `Save anyway`. A colour
 * never has a price: it only changes cost.
 */
export function ColourOptionDialog({ product, colour, cost, open, loadMaterials, onClose, onSaved }: Props) {
  const { toast } = useToast();
  const formatCurrency = useFormatCurrency();
  const slots = useMemo(() => [...product.colourSlots].sort((a, b) => a.sortOrder - b.sortOrder), [product.colourSlots]);
  const sizes = useMemo(() => orderedSizes(product), [product]);
  const [materials, setMaterials] = useState<ApiMaterial[] | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [impact, setImpact] = useState<ApiOpenLineImpact[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !colour) return;
    setPicked(Object.fromEntries(slots.map(s => [s.id, colour.assignments.find(a => a.colourSlotId === s.id)?.materialId ?? AS_SLICED])));
    setExcluded(new Set(colour.excludedSizeKeys));
    setImpact(null);
    setError(null);
    loadMaterials().then(setMaterials).catch(err => setError(errorText(err, "Couldn't load filaments")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, colour?.id]);

  if (!colour) return null;

  const sizeRows = [
    { key: STANDARD_KEY, label: standardSizeLabel(product), active: true },
    ...sizes.map(s => ({ key: s.id, label: s.isActive ? s.name : `${s.name} (inactive)`, active: s.isActive })),
  ];

  function toggleSize(key: string, made: boolean) {
    setExcluded(prev => {
      const next = new Set(prev);
      if (made) next.delete(key); else next.add(key);
      return next;
    });
    setImpact(null);
  }

  async function save(confirm: boolean) {
    if (!colour) return;
    const activeKeys = sizeRows.filter(r => r.active).map(r => r.key);
    if (activeKeys.every(k => excluded.has(k))) { setError(`"${colour.name}" must be made in at least one size`); return; }
    const body = {
      slots: slots.map(s => ({ colourSlotId: s.id, materialId: picked[s.id] || null })),
      excludedSizeKeys: [...excluded],
    };
    setSaving(true);
    setError(null);
    try {
      if (!confirm) {
        const preview = await api.put<ApiImpactPreview>(`/products/${product.id}/variants/${colour.id}/colour-slots?dryRun=1`, body);
        if (preview.impact.length) { setImpact(preview.impact); return; }
      }
      const r = await api.put<ApiAssignmentsResult>(`/products/${product.id}/variants/${colour.id}/colour-slots`, { ...body, confirm });
      toast('success', `Filaments for ${colour.name} saved`);
      const notes = r.warnings.filter(w => w.code !== 'OPEN_LINES_AFFECTED');
      if (notes.length) toast('warning', notes.map(w => w.message).join(' · '));
      onSaved();
      onClose();
    } catch (err) {
      setError(errorText(err, 'Save failed'));
    } finally {
      setSaving(false);
    }
  }

  const cells = cost?.cells ?? [];
  const preview = sizeRows.filter(r => r.active && !excluded.has(r.key)).map(r => {
    const sid = r.key === STANDARD_KEY ? null : r.key;
    const mine = cells.find(c => c.sizeOptionId === sid && c.colourOptionId === colour.id);
    const std = cells.find(c => c.sizeOptionId === sid && c.colourOptionId === null);
    return `on ${r.label}: ${mine?.costPerUnit != null ? formatCurrency(mine.costPerUnit) : '—'} (standard ${std?.costPerUnit != null ? formatCurrency(std.costPerUnit) : '—'})`;
  });

  return (
    <Dialog open={open} onClose={saving ? () => undefined : onClose} title={`Filaments for ${colour.name}`} className="max-w-3xl">
      <div className="space-y-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Choose the filament each colour slot prints in. Colours don&apos;t change the price — only the cost.
        </p>
        {slots.length === 0 ? (
          <p className="text-sm text-amber-700 dark:text-amber-300">This product has no colour slots yet — add them and link parts in Edit links first.</p>
        ) : (
          <ul className="max-h-[45vh] divide-y overflow-y-auto rounded-md border dark:divide-gray-700 dark:border-gray-700">
            {slots.map(s => {
              const fileTypes = [...new Set(s.standardMaterials.map(m => String(m.type)))];
              const chosen = materials?.find(m => m.id === picked[s.id]) ?? null;
              const typeChange = chosen && fileTypes.length > 0 && !fileTypes.includes(chosen.type) ? `${fileTypes.join('/')} → ${chosen.type}` : null;
              const same = (materials ?? []).filter(m => fileTypes.includes(m.type));
              const other = (materials ?? []).filter(m => !fileTypes.includes(m.type));
              const noLinks = s.links.length === 0;
              return (
                <li key={s.id} className="grid grid-cols-1 gap-2 px-3 py-3 sm:grid-cols-[1fr_16rem] sm:items-start">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{s.name}</p>
                    {noLinks
                      ? <p className="text-xs text-amber-700 dark:text-amber-300">No parts linked — link parts in Edit links</p>
                      : <p className="text-xs text-gray-600 dark:text-gray-400">{linkedParts(product, s)}</p>}
                    {s.standardMaterials.length > 0 && (
                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                        Standard:
                        {s.standardMaterials.map(m => (
                          <span key={m.id} className="inline-flex items-center gap-1"><Swatch hex={m.colorHex} title={m.name} />{m.name}</span>
                        ))}
                      </p>
                    )}
                  </div>
                  <div>
                    <select
                      aria-label={`Filament for ${s.name}`}
                      value={picked[s.id] ?? AS_SLICED}
                      disabled={noLinks || !materials || saving}
                      onChange={e => { const v = e.target.value; setPicked(p => ({ ...p, [s.id]: v })); setImpact(null); }}
                      className="h-9 w-full rounded-md border border-gray-300 bg-white px-2 text-sm disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                    >
                      <option value={AS_SLICED}>As sliced (standard)</option>
                      {same.length > 0 && (
                        <optgroup label={`${fileTypes.join(' / ')} (same plastic as the file)`}>
                          {same.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                        </optgroup>
                      )}
                      {other.length > 0 && (
                        <optgroup label="Other plastics">
                          {other.map(m => <option key={m.id} value={m.id}>{m.name} ({m.type})</option>)}
                        </optgroup>
                      )}
                    </select>
                    {typeChange && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Different plastic from the file ({typeChange})</p>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <fieldset className="space-y-1">
          <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">Made in</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {sizeRows.map(r => (
              <label key={r.key} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input type="checkbox" className="h-4 w-4 rounded border-gray-300" checked={!excluded.has(r.key)} disabled={saving} onChange={e => toggleSize(r.key, e.target.checked)} />
                {r.label}
              </label>
            ))}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">Untick a size this colour can&apos;t be made in; it is never offered there. Existing orders are not changed.</p>
        </fieldset>

        {preview.length > 0 && (
          <p className="text-xs text-gray-600 dark:text-gray-400">
            Cost per unit, as last saved: {preview.join(' · ')}
          </p>
        )}
        {impact && <ImpactList impact={impact} />}
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="button" onClick={() => void save(!!impact)} disabled={saving}>
            {saving ? 'Saving…' : impact ? 'Save anyway' : 'Save'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
