'use client';

import { useEffect, useState } from 'react';
import type { SliceRunDto } from '@printforge/types';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import type { FilamentStock } from '@/components/filaments/useFilamentStock';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { ApiPrinter, ComponentDetail, MaterialLite, ProductDetail } from '@/lib/types/api';
import { Toggle } from './options-ui';
import { SliceSlotRows, SlotFilamentPickerDialog, choiceIds, pickOf, type SlotChoices } from './SliceSlotRows';
import { buildSliceRequest, parseSliceUnits, printerLockedBy, sliceErrorText, sliceSlotsOf, sourceOf, type SliceSlotSpec } from './slice-ui';

interface Props {
  product: ProductDetail;
  component: ComponentDetail | null;
  open: boolean;
  /** Every filament the product page knows, for the defaults. */
  materials: Map<string, MaterialLite>;
  stock: FilamentStock;
  loadPrinters: () => Promise<ApiPrinter[]>;
  onClose: () => void;
  /** The run was queued; the caller refetches the part's runs. */
  onQueued: (run: SliceRunDto) => void;
}

/**
 * Slice a plate of one part (v2.18.0): the printer (locked to the one a 3MF
 * project names), the filament for each slot the source uses (the project's
 * match or the part's BOM filament, changeable through the filament picker),
 * and the units on the plate, or "Fill the plate" for as many as fit. The
 * run is queued; the runs list under the part follows it.
 */
export function SlicePlateDialog({ product, component: c, open, materials, stock, loadPrinters, onClose, onQueued }: Props) {
  const { toast } = useToast();
  const [printers, setPrinters] = useState<ApiPrinter[] | null>(null);
  const [printerId, setPrinterId] = useState('');
  const [chosen, setChosen] = useState<SlotChoices>({});
  const [units, setUnits] = useState('1');
  const [fill, setFill] = useState(false);
  const [picking, setPicking] = useState<SliceSlotSpec | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const source = c ? sourceOf(c) : null;
  const lockedPrinterId = printerLockedBy(source);
  const slots = c && source ? sliceSlotsOf(source, c) : [];

  // Reset on open and on another part; a background reload keeps what was typed.
  useEffect(() => {
    if (!open || !c || !source) return;
    const defaults: SlotChoices = {};
    for (const s of sliceSlotsOf(source, c)) {
      const m = pickOf(s.defaultMaterialId, materials, stock.rows);
      if (m) defaults[s.key] = m;
    }
    setChosen(defaults);
    setPrinterId(printerLockedBy(source) ?? product.defaultPrinterId ?? '');
    setUnits('1');
    setFill(false);
    setPicking(null);
    setError(null);
    setSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, c?.id]);

  useEffect(() => {
    if (!open || printers) return;
    loadPrinters()
      .then(list => setPrinters(list.filter(p => p.isActive)))
      .catch(err => setError(sliceErrorText(err, 'Couldn\'t load the printers')));
  }, [open, printers, loadPrinters]);

  // An STL part with no product printer: the first active one.
  useEffect(() => {
    if (!open || lockedPrinterId || printerId || !printers?.[0]) return;
    setPrinterId(printers[0].id);
  }, [open, lockedPrinterId, printerId, printers]);

  if (!c || !source) return null;

  const lockedPrinter = lockedPrinterId ? printers?.find(p => p.id === lockedPrinterId) ?? null : null;
  const projectUnmatched = source.kind === 'THREEMF' && !lockedPrinterId;
  const built = buildSliceRequest({ printerId: printerId || null, printerLocked: lockedPrinterId !== null, slots, chosen: choiceIds(chosen), units, fill });
  const unitsBad = !fill && parseSliceUnits(units) === null;
  const canSubmit = built.body !== null && !submitting && !projectUnmatched;

  async function submit() {
    if (!c || !built.body || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const run = await api.post<SliceRunDto>(`/products/${product.id}/components/${c.id}/slice`, built.body);
      toast('success', fill ? `Queued — filling a plate of ${c.description}` : `Queued ×${run.unitsRequested} of ${c.description}`);
      onQueued(run);
      onClose();
    } catch (err) {
      setError(sliceErrorText(err, 'Couldn\'t queue the slice'));
    } finally {
      setSubmitting(false);
    }
  }

  if (picking) {
    return (
      <SlotFilamentPickerDialog
        slot={picking}
        current={chosen[picking.key] ?? null}
        stock={stock}
        onPick={row => { setChosen(prev => ({ ...prev, [picking.key]: row })); setPicking(null); }}
        onBack={() => setPicking(null)}
      />
    );
  }

  return (
    <Dialog open={open} onClose={submitting ? () => undefined : onClose} title={`Slice a plate — ${c.description}`} className="max-w-md">
      <div className="space-y-4">
        <p className="break-all text-xs text-gray-500 dark:text-gray-400">
          From {source.filename} ({source.kind === 'THREEMF' ? '3MF project' : 'STL'})
        </p>

        {lockedPrinterId ? (
          <div className="space-y-1">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Printer</p>
            <p className="text-sm text-gray-800 dark:text-gray-200">
              {lockedPrinter?.name ?? source.printerModel ?? 'The project\'s printer'}
              <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">· set by the project</span>
            </p>
          </div>
        ) : projectUnmatched ? (
          <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">
            The project names {source.printerModel ? `"${source.printerModel}"` : 'a printer'} that matches none of yours. Add that printer, then upload the project again.
          </p>
        ) : (
          <Select
            label="Printer"
            required
            value={printerId}
            disabled={submitting || !printers}
            onChange={e => setPrinterId(e.target.value)}
            options={printers
              ? [{ value: '', label: printers.length ? 'Choose a printer' : 'No active printers' }, ...printers.map(p => ({ value: p.id, label: p.name }))]
              : [{ value: '', label: 'Loading printers…' }]}
          />
        )}

        <div>
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{slots.length > 1 ? 'Filaments' : 'Filament'}</p>
          <SliceSlotRows slots={slots} chosen={chosen} disabled={submitting} showSlotNumber={slots.length > 1}
            onPick={s => { if (!stock.rows) stock.refresh(); setPicking(s); }} />
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label htmlFor="slice-units" className="text-sm font-medium text-gray-700 dark:text-gray-300">Units on the plate</label>
            <input
              id="slice-units"
              type="number"
              min={1}
              max={500}
              step={1}
              inputMode="numeric"
              value={units}
              disabled={submitting || fill}
              onChange={e => setUnits(e.target.value)}
              className={cn(
                'mt-0.5 block h-10 w-28 rounded-md border bg-white px-2 text-sm dark:bg-gray-800 dark:text-gray-100 disabled:opacity-50',
                unitsBad ? 'border-red-500' : 'border-gray-300 dark:border-gray-600',
              )}
            />
            {unitsBad && <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">Whole number from 1 to 500</p>}
          </div>
          <label className="flex h-10 items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <Toggle checked={fill} label="Fill the plate" disabled={submitting} onChange={setFill} />
            Fill the plate
          </label>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {fill
            ? 'As many as fit the bed, estimated from the model\'s size; the plate is named by the real count.'
            : source.kind === 'THREEMF'
              ? 'The project\'s own print settings are used; the plate is repeated this many times.'
              : 'The printer\'s default process profile is used; the model is copied and arranged this many times.'}
        </p>

        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3 dark:border-gray-700">
          {built.problem && !error && <span className="mr-auto text-xs text-gray-500 dark:text-gray-400">{built.problem}</span>}
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>{submitting ? 'Queueing…' : 'Slice'}</Button>
        </div>
      </div>
    </Dialog>
  );
}
