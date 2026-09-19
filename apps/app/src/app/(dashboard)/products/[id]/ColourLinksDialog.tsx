'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, Wand2, X } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type {
  ApiColourLinkProposal, ApiColourLinksResult, ApiImpactPreview, ApiOpenLineImpact, ProductDetail,
} from '@/lib/types/api';
import { ImpactList, Swatch, errorText } from './options-ui';
import {
  FIXED, MAX_SLOTS, NONE, addSlot, applyProposal, buildPayload, buildRows, initialState, removeNewSlot, rowDomId, rowKey,
  unlinkedCount, validateSlots, type GridState,
} from './colour-links-model';

export interface ColourLinksFocus {
  componentId: string;
  colorIndex: number;
}

export interface ColourLinksDialogProps {
  product: ProductDetail;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** Scroll to and highlight this component material slot on open (WP9's BOM link tag passes it). */
  focus?: ColourLinksFocus | null;
}

/**
 * `Edit links` (spec §5.1, §5.2 C, §3.3): one grid of every component material
 * slot of every size, one select per row (the product's colour slots, `Fixed`,
 * `— not linked —`), slot names editable in the header, `+ Add slot`,
 * `Link by filament` (C5 proposal into the unsaved grid), and one Save → C4
 * batch, dry run first; a non-empty open-line impact is confirmed here.
 */
export function ColourLinksDialog({ product, open, onClose, onSaved, focus }: ColourLinksDialogProps) {
  const { toast } = useToast();
  const rows = useMemo(() => buildRows(product), [product]);
  const [grid, setGrid] = useState<GridState>(() => initialState(product, rows));
  const [busy, setBusy] = useState<'proposal' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [impact, setImpact] = useState<ApiOpenLineImpact[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setGrid(initialState(product, rows));
    setError(null);
    setImpact(null);
    // Refill only on open; a background reload never wipes unsaved choices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const focusKey = focus ? rowKey(focus.componentId, focus.colorIndex) : null;
  useEffect(() => {
    if (!open || !focus) return;
    const domId = rowDomId(focus.componentId, focus.colorIndex);
    const t = window.setTimeout(() => {
      document.getElementById(domId)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 50);
    return () => window.clearTimeout(t);
    // Keyed by the row, not the object identity, so a re-render never re-scrolls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focusKey]);

  function setValue(key: string, value: string) {
    setGrid(g => ({ ...g, values: { ...g.values, [key]: value } }));
    setImpact(null);
  }

  function renameSlot(key: string, name: string) {
    setGrid(g => ({ ...g, slots: g.slots.map(s => (s.key === key ? { ...s, name } : s)) }));
    setImpact(null);
  }

  function newSlot() {
    if (grid.slots.length >= MAX_SLOTS) { setError(`A product can have at most ${MAX_SLOTS} colour slots`); return; }
    setGrid(g => addSlot(g, `Slot ${g.slots.length + 1}`));
    setImpact(null);
  }

  async function linkByFilament() {
    setBusy('proposal');
    setError(null);
    try {
      const proposal = await api.get<ApiColourLinkProposal>(`/products/${product.id}/colour-links/proposal`);
      const { state, filled } = applyProposal(grid, proposal);
      setGrid(state);
      setImpact(null);
      toast(filled ? 'success' : 'warning', filled
        ? `Proposed links for ${filled} ${filled === 1 ? 'part' : 'parts'} — check and rename the slots, then Save`
        : 'Nothing to propose — every part is already linked or fixed');
    } catch (err) {
      setError(errorText(err, "Couldn't load the proposal"));
    } finally {
      setBusy(null);
    }
  }

  async function save(confirm: boolean) {
    const invalid = validateSlots(grid);
    if (invalid) { setError(invalid); return; }
    const payload = buildPayload(grid, rows);
    if (!payload) { onClose(); return; }
    setBusy('save');
    setError(null);
    try {
      if (!confirm) {
        const preview = await api.put<ApiImpactPreview>(`/products/${product.id}/colour-links?dryRun=1`, payload);
        if (preview.impact.length) { setImpact(preview.impact); return; }
      }
      const r = await api.put<ApiColourLinksResult>(`/products/${product.id}/colour-links`, { ...payload, confirm });
      toast('success', 'Colour links saved');
      const mixed = r.warnings.filter(w => w.code === 'SLOT_STANDARD_MIXED');
      if (mixed.length) toast('warning', mixed.map(w => w.message).join(' · '));
      onSaved();
      onClose();
    } catch (err) {
      setError(errorText(err, 'Save failed'));
    } finally {
      setBusy(null);
    }
  }

  const unlinked = unlinkedCount(grid);
  const options = [
    ...grid.slots.map(s => ({ value: s.key, label: s.name.trim() || '(unnamed slot)' })),
    { value: FIXED, label: 'Fixed — always its own filament' },
    { value: NONE, label: '— not linked —' },
  ];
  let lastSize = '';

  return (
    <Dialog open={open} onClose={busy ? () => undefined : onClose} title="Edit colour links" className="max-w-4xl">
      <div className="space-y-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Link each part&apos;s colour to a colour slot so colours can recolour it, or mark it Fixed when it never changes.
          Parts left not linked keep colours out of the shop on that size.
        </p>

        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Colour slots ({grid.slots.length} of {MAX_SLOTS})</p>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => void linkByFilament()} disabled={!!busy}>
                <Wand2 className="mr-1.5 h-3.5 w-3.5" />{busy === 'proposal' ? 'Loading…' : 'Link by filament'}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={newSlot} disabled={!!busy || grid.slots.length >= MAX_SLOTS}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />Add slot
              </Button>
            </div>
          </div>
          {grid.slots.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">No colour slots yet — add one, or let Link by filament propose them.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {grid.slots.map(s => (
                <div key={s.key} className="flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 dark:border-gray-600 dark:bg-gray-800">
                  <input
                    aria-label={`Name of colour slot ${s.name}`}
                    value={s.name}
                    maxLength={40}
                    onChange={e => renameSlot(s.key, e.target.value)}
                    className="w-28 bg-transparent text-sm text-gray-900 outline-none dark:text-gray-100"
                  />
                  {!s.id && <span className="text-[10px] uppercase text-brand-600 dark:text-brand-400">new</span>}
                  {!s.id && (
                    <button type="button" aria-label={`Remove new slot ${s.name}`} onClick={() => setGrid(g => removeNewSlot(g, s.key))} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="max-h-[45vh] overflow-y-auto rounded-md border dark:border-gray-700">
          {rows.length === 0 ? (
            <p className="p-4 text-sm text-gray-500 dark:text-gray-400">No components yet — import or add components first.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-gray-50 text-xs uppercase tracking-wider text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Part</th>
                  <th className="px-3 py-2 text-left font-medium">Sliced in</th>
                  <th className="px-3 py-2 text-left font-medium">Colour slot</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const header = r.sizeLabel !== lastSize;
                  lastSize = r.sizeLabel;
                  const value = grid.values[r.key] ?? r.initial;
                  const focused = r.key === focusKey;
                  return (
                    <FragmentRows key={r.key} header={header ? r.sizeLabel : null}>
                      <tr
                        id={rowDomId(r.componentId, r.colorIndex)}
                        className={cn('border-t dark:border-gray-700', focused && 'bg-amber-50 ring-2 ring-inset ring-amber-400 dark:bg-amber-900/20')}
                      >
                        <td className="px-3 py-1.5 text-gray-900 dark:text-gray-100">{r.part}</td>
                        <td className="px-3 py-1.5">
                          <span className="inline-flex items-center gap-1.5 text-gray-700 dark:text-gray-300">
                            <Swatch hex={r.material?.colorHex} title={r.material?.name ?? 'No filament'} />
                            {r.material?.name ?? '—'}
                          </span>
                        </td>
                        <td className="px-3 py-1.5">
                          <select
                            aria-label={`Colour slot of ${r.sizeLabel} ${r.part}`}
                            value={value}
                            onChange={e => setValue(r.key, e.target.value)}
                            disabled={busy === 'save'}
                            className={cn(
                              'h-8 w-full max-w-[16rem] rounded-md border bg-white px-2 text-sm dark:bg-gray-800 dark:text-gray-100',
                              value === NONE ? 'border-red-400 text-red-700 dark:border-red-600 dark:text-red-300' : 'border-gray-300 dark:border-gray-600',
                            )}
                          >
                            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </td>
                      </tr>
                    </FragmentRows>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {unlinked > 0 && (
          <p className="text-sm text-red-600 dark:text-red-400">{unlinked} {unlinked === 1 ? 'part' : 'parts'} not linked</p>
        )}

        {impact && <ImpactList impact={impact} />}
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose} disabled={!!busy}>Cancel</Button>
          {impact ? (
            <Button type="button" onClick={() => void save(true)} disabled={!!busy}>{busy === 'save' ? 'Saving…' : 'Save anyway'}</Button>
          ) : (
            <Button type="button" onClick={() => void save(false)} disabled={!!busy}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** A size header row (when the size changes) followed by the slot row. */
function FragmentRows({ header, children }: { header: string | null; children: React.ReactNode }) {
  return (
    <>
      {header && (
        <tr className="bg-gray-50/70 dark:bg-gray-800/40">
          <td colSpan={3} className="px-3 py-1.5 text-xs font-semibold text-gray-600 dark:text-gray-300">{header}</td>
        </tr>
      )}
      {children}
    </>
  );
}
