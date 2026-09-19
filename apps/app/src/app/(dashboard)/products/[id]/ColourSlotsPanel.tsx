'use client';

import { useState } from 'react';
import { Link2, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { ApiSlotRemovalPreview, ColourSlotDetail, ProductDetail } from '@/lib/types/api';
import { ConfirmDialog } from './ConfirmDialog';
import { ImpactList, errorText } from './options-ui';
import { STANDARD_KEY, allComponents, sizeLabelOf, slotPartLabel, totalUnlinked } from './options-model';

interface Props {
  product: ProductDetail;
  canEdit: boolean;
  onEditLinks: () => void;
  onChanged: () => void;
}

/** "Regular: Box, Lid colour 1 · Large: Large Box" — the hover text of a slot chip. */
function linksTitle(product: ProductDetail, slot: ColourSlotDetail): string {
  if (!slot.links.length) return 'No parts linked';
  const comps = allComponents(product);
  const bySize = new Map<string, string[]>();
  for (const l of slot.links) {
    const k = l.sizeOptionId ?? STANDARD_KEY;
    bySize.set(k, [...(bySize.get(k) ?? []), slotPartLabel(comps.find(c => c.id === l.componentId), l.componentDescription, l.colorIndex)]);
  }
  return [...bySize.entries()].map(([k, v]) => `${sizeLabelOf(product, k)}: ${v.join(', ')}`).join(' · ');
}

/**
 * Section C part 3 (spec §5.2 C): one chip per colour slot with Rename (C2)
 * and Remove (C3, dry run first: links, assignments and open-line impact),
 * `Add slot` (C1) and `Edit links` (ColourLinksDialog).
 */
export function ColourSlotsPanel({ product, canEdit, onEditLinks, onChanged }: Props) {
  const { toast } = useToast();
  const slots = [...product.colourSlots].sort((a, b) => a.sortOrder - b.sortOrder);
  const unlinked = totalUnlinked(product);
  const [nameDialog, setNameDialog] = useState<{ slot: ColourSlotDetail | null; name: string } | null>(null);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [removal, setRemoval] = useState<{ slot: ColourSlotDetail; preview: ApiSlotRemovalPreview } | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    if (!nameDialog) return;
    const name = nameDialog.name.trim();
    if (name.length < 1 || name.length > 40) { setNameError('Enter a name of 1 to 40 characters'); return; }
    setNameBusy(true);
    setNameError(null);
    try {
      if (nameDialog.slot) await api.patch(`/products/${product.id}/colour-slots/${nameDialog.slot.id}`, { name });
      else await api.post(`/products/${product.id}/colour-slots`, { name });
      toast('success', nameDialog.slot ? `Renamed to ${name}` : `Colour slot ${name} added — link parts to it in Edit links`);
      setNameDialog(null);
      onChanged();
    } catch (err) {
      setNameError(errorText(err, 'Save failed'));
    } finally {
      setNameBusy(false);
    }
  }

  async function askRemove(slot: ColourSlotDetail) {
    setRemoveError(null);
    try {
      const preview = await api.delete<ApiSlotRemovalPreview>(`/products/${product.id}/colour-slots/${slot.id}?dryRun=1`);
      setRemoval({ slot, preview });
    } catch (err) {
      toast('error', errorText(err, "Couldn't check the slot"));
    }
  }

  async function confirmRemove() {
    if (!removal) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      const confirm = removal.preview.impact.length > 0 ? '?confirm=1' : '';
      await api.delete(`/products/${product.id}/colour-slots/${removal.slot.id}${confirm}`);
      toast('success', `Colour slot ${removal.slot.name} removed`);
      setRemoval(null);
      onChanged();
    } catch (err) {
      setRemoveError(errorText(err, 'Remove failed'));
    } finally {
      setRemoveBusy(false);
    }
  }

  const comps = allComponents(product);
  const r = removal?.preview;

  return (
    <div className="space-y-3 border-t px-6 pt-4 dark:border-gray-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Colour slots</h4>
          {unlinked > 0 && <span className="text-sm text-red-600 dark:text-red-400">{unlinked} {unlinked === 1 ? 'part' : 'parts'} not linked</span>}
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => { setNameError(null); setNameDialog({ slot: null, name: '' }); }} disabled={slots.length >= 12}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />Add slot
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={onEditLinks}>
              <Link2 className="mr-1.5 h-3.5 w-3.5" />Edit links
            </Button>
          </div>
        )}
      </div>
      {slots.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No colour slots yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {slots.map(s => (
            <li key={s.id} title={linksTitle(product, s)} className="flex items-center gap-1 rounded-full border border-gray-300 bg-gray-50 py-1 pl-3 pr-1.5 text-sm dark:border-gray-600 dark:bg-gray-800">
              <span className="font-medium text-gray-900 dark:text-gray-100">{s.name}</span>
              <span className="text-gray-500 dark:text-gray-400">· {s.links.length} {s.links.length === 1 ? 'part' : 'parts'}</span>
              {canEdit && (
                <>
                  <button type="button" aria-label={`Rename ${s.name}`} onClick={() => { setNameError(null); setNameDialog({ slot: s, name: s.name }); }} className="rounded p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" aria-label={`Remove ${s.name}`} onClick={() => void askRemove(s)} className="rounded p-1 text-gray-400 hover:text-red-600 dark:hover:text-red-400">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Colour slots are the parts of the design that change colour. Link each part&apos;s colour in Edit links (Link by filament proposes them),
        and mark parts that never change as Fixed.
      </p>

      <Dialog open={!!nameDialog} onClose={nameBusy ? () => undefined : () => setNameDialog(null)} title={nameDialog?.slot ? `Rename ${nameDialog.slot.name}` : 'Add colour slot'}>
        <form onSubmit={saveName} className="space-y-4" noValidate>
          <Input label="Name" required maxLength={40} placeholder="e.g. Tin" value={nameDialog?.name ?? ''} onChange={e => setNameDialog(d => (d ? { ...d, name: e.target.value } : d))} />
          {nameError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{nameError}</p>}
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setNameDialog(null)} disabled={nameBusy}>Cancel</Button>
            <Button type="submit" disabled={nameBusy}>{nameBusy ? 'Saving…' : 'Save'}</Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={!!removal}
        title={removal ? `Remove colour slot ${removal.slot.name}?` : ''}
        confirmLabel={r && r.impact.length ? 'Remove anyway' : 'Remove'}
        destructive
        busy={removeBusy}
        error={removeError}
        onClose={() => setRemoval(null)}
        onConfirm={() => void confirmRemove()}
        message={removal && r ? (
          <div className="space-y-2">
            <p>
              &quot;{removal.slot.name}&quot; is linked by {r.links.length
                ? r.links.map(l => slotPartLabel(comps.find(c => c.id === l.componentId), l.description, l.colorIndex)).join(', ')
                : 'no parts'}
              {' '}and set by {r.assignments.length ? r.assignments.map(a => a.name).join(', ') : 'no colours'}.
              {r.links.length > 0 && ' Those parts will print in their own filament in every colour.'}
            </p>
            <ImpactList impact={r.impact} />
          </div>
        ) : null}
      />
    </div>
  );
}
