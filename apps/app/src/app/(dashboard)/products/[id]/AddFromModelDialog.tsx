'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import type { FilamentStock } from '@/components/filaments/useFilamentStock';
import { api } from '@/lib/api';
import { stageLargeFile } from '@/lib/chunked-upload';
import type { ApiPrinter, MaterialLite } from '@/lib/types/api';
import { SliceSlotRows, SlotFilamentPickerDialog, choiceIds, pickOf, type SlotChoices } from './SliceSlotRows';
import {
  PART_NAME_MAX,
  buildFromModelRequest,
  defaultModelPrinterId,
  inspectSlotsOf,
  isProjectModel,
  projectPrinterUnmatched,
  projectPrinterWarning,
  sliceErrorText,
  sourceKindText,
  type ComponentFromModelResult,
  type ModelInspectResult,
  type SliceSlotSpec,
} from './slice-ui';

interface Props {
  productId: string;
  /** The STL or 3MF project just chosen; null = closed. */
  file: File | null;
  /** The size the part is added to; null = the standard bill of materials. */
  sizeOptionId: string | null;
  scopeLabel: string;
  /** Every filament the product page knows, to show the project's matches. */
  materials: Map<string, MaterialLite>;
  stock: FilamentStock;
  loadPrinters: () => Promise<ApiPrinter[]>;
  onClose: () => void;
  /** The part was created; the caller refetches the product and opens the new part's row. */
  onAdded: (out: ComponentFromModelResult) => void;
}

type Phase =
  | { step: 'reading' }
  | { step: 'failed'; message: string }
  | { step: 'form'; uploadId: string; model: ModelInspectResult };

/**
 * "Add from model": a part made from its STL or 3MF project. The file is
 * staged and inspected first; the form then asks only what the model cannot
 * say — the name, the printer (an STL; a project names its own) and the
 * filament of each slot. Grams and time come from the 1-unit slice the API
 * queues, never from the form.
 */
export function AddFromModelDialog({ productId, file, sizeOptionId, scopeLabel, materials, stock, loadPrinters, onClose, onAdded }: Props) {
  const { toast } = useToast();
  const [phase, setPhase] = useState<Phase>({ step: 'reading' });
  const [name, setName] = useState('');
  const [printers, setPrinters] = useState<ApiPrinter[] | null>(null);
  const [printerId, setPrinterId] = useState('');
  const [picked, setPicked] = useState<SlotChoices>({});
  const [picking, setPicking] = useState<SliceSlotSpec | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The file being read: a second effect run for the same file starts nothing, and a closed dialog drops the answer. */
  const reading = useRef<File | null>(null);

  // Step 1, automatic: stage the file, then ask the API what it is.
  useEffect(() => {
    if (reading.current === file) return;
    reading.current = file;
    if (!file) return;
    setPhase({ step: 'reading' });
    setName('');
    setPrinterId('');
    setPicked({});
    setPicking(null);
    setSubmitting(false);
    setError(null);
    void (async () => {
      try {
        const uploadId = await stageLargeFile(file);
        if (reading.current !== file) return;
        const model = await api.post<ModelInspectResult>(`/products/${productId}/model-inspect`, { assembledUploadId: uploadId });
        if (reading.current !== file) return;
        setName((model.suggestedName ?? '').slice(0, PART_NAME_MAX));
        setPhase({ step: 'form', uploadId, model });
      } catch (err) {
        if (reading.current !== file) return;
        setPhase({ step: 'failed', message: sliceErrorText(err, 'Couldn\'t read the model') });
      }
    })();
  }, [file, productId]);

  const open = file !== null;
  useEffect(() => {
    if (!open || printers) return;
    loadPrinters()
      .then(setPrinters)
      .catch(err => setError(sliceErrorText(err, 'Couldn\'t load the printers')));
  }, [open, printers, loadPrinters]);

  const model = phase.step === 'form' ? phase.model : null;
  const project = model !== null && isProjectModel(model);
  const activePrinters = printers ? printers.filter(p => p.isActive) : null;

  // An STL starts on the product's printer, else the first active one.
  useEffect(() => {
    if (!model || project || printerId || !activePrinters) return;
    const first = defaultModelPrinterId(model.defaultPrinterId, activePrinters);
    if (first) setPrinterId(first);
  }, [model, project, printerId, activePrinters]);

  if (!file) return null;
  const title = `Add from model — ${scopeLabel}`;

  if (phase.step === 'reading') {
    return (
      <Dialog open onClose={onClose} title={title} className="max-w-md">
        <div className="space-y-4">
          <p role="status" className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Reading the model…
          </p>
          <div className="flex justify-end border-t pt-3 dark:border-gray-700">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      </Dialog>
    );
  }

  if (phase.step === 'failed') {
    return (
      <Dialog open onClose={onClose} title={title} className="max-w-md">
        <div className="space-y-4">
          <p role="alert" className="break-words text-sm text-red-600 dark:text-red-400">{phase.message}</p>
          <div className="flex justify-end border-t pt-3 dark:border-gray-700">
            <Button variant="outline" onClick={onClose}>Close</Button>
          </div>
        </div>
      </Dialog>
    );
  }

  const { uploadId } = phase;
  const m = phase.model;
  const slots = inspectSlotsOf(m);
  // What the user picked wins; otherwise the filament the project's slot matched.
  const chosen: SlotChoices = {};
  for (const s of slots) {
    const c = picked[s.key] ?? pickOf(s.defaultMaterialId, materials, stock.rows);
    if (c) chosen[s.key] = c;
  }
  const unmatched = projectPrinterUnmatched(m);
  const built = buildFromModelRequest({
    assembledUploadId: uploadId,
    model: m,
    name,
    printerId: printerId || null,
    slots,
    chosen: choiceIds(chosen),
    variantId: sizeOptionId,
  });
  const canSubmit = built.body !== null && !submitting;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!built.body || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const out = await api.post<ComponentFromModelResult>(`/products/${productId}/components/from-model`, built.body);
      if (out.notice) toast('warning', out.notice);
      else toast('success', 'Part added. Slicing the first unit');
      onAdded(out);
      onClose();
    } catch (err) {
      setError(sliceErrorText(err, 'Couldn\'t add the part'));
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
        onPick={row => { setPicked(prev => ({ ...prev, [picking.key]: row })); setPicking(null); }}
        onBack={() => setPicking(null)}
      />
    );
  }

  const projectPrinter = m.printerId ? printers?.find(p => p.id === m.printerId) ?? null : null;

  return (
    <Dialog open onClose={submitting ? () => undefined : onClose} title={title} className="max-w-md">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p className="break-all text-xs text-gray-500 dark:text-gray-400">From {m.filename} ({sourceKindText(m.kind)})</p>

        <Input label="Name" required maxLength={PART_NAME_MAX} value={name} disabled={submitting} onChange={e => setName(e.target.value)} />

        {!project ? (
          <Select
            label="Printer"
            required
            value={printerId}
            disabled={submitting || !activePrinters}
            onChange={e => setPrinterId(e.target.value)}
            options={activePrinters
              ? [{ value: '', label: activePrinters.length ? 'Choose a printer' : 'No active printers' }, ...activePrinters.map(p => ({ value: p.id, label: p.name }))]
              : [{ value: '', label: 'Loading printers…' }]}
          />
        ) : unmatched ? (
          <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{projectPrinterWarning(m.printerModel)}</p>
        ) : (
          <p className="text-sm text-gray-800 dark:text-gray-200">
            <span className="font-medium text-gray-700 dark:text-gray-300">Printer:</span>{' '}
            {projectPrinter?.name ?? m.printerModel ?? 'The project\'s printer'}
            <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">· set by the project</span>
          </p>
        )}

        <div>
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{project && slots.length > 1 ? 'Filaments' : 'Filament'}</p>
          <SliceSlotRows slots={slots} chosen={chosen} disabled={submitting} showSlotNumber={project} showFileSwatch
            onPick={s => { if (!stock.rows) stock.refresh(); setPicking(s); }} />
        </div>

        <p className="text-xs text-gray-500 dark:text-gray-400">PrintForge slices one unit to work out the grams and time.</p>

        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3 dark:border-gray-700">
          {built.problem && !error && !unmatched && <span className="mr-auto text-xs text-gray-500 dark:text-gray-400">{built.problem}</span>}
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" disabled={!canSubmit}>{submitting ? 'Adding…' : 'Add part'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
