'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { CHUNK_THRESHOLD, stageLargeFile } from '@/lib/chunked-upload';
import { formatGrams, formatMinutes, plural } from '@/lib/product-format';
import type { ComponentDetail } from '@/lib/types/api';
import { PlatePreviewCard, NEW_COMPONENT, isSliced, unitsOf, type PlateChoice } from './PlatePreviewCard';
import { errorText } from './options-ui';
import { importToasts, type ImportResult, type ThreeMfWizardState } from './useSlicerImport';

interface Props {
  productId: string;
  state: ThreeMfWizardState | null;
  /** Import target: null = the standard size. */
  sizeOptionId: string | null;
  targetLabel: string;
  /** Components of the target scope (for `Plate layout of …`). */
  targetComponents: ComponentDetail[];
  onClose: () => void;
  onImported: () => void;
}

function initialChoices(state: ThreeMfWizardState): Record<number, PlateChoice> {
  return Object.fromEntries(state.analysis.plates.map(p => [p.plateIndex, {
    selected: true,
    name: p.name,
    units: isSliced(p) && p.objectCount != null ? String(p.objectCount) : '',
    addAs: NEW_COMPONENT,
  }]));
}

/**
 * 3MF import onto the BOM scope (spec §5.1, §3.12, M2): per plate, units on
 * the plate and whether it becomes a new component or a plate layout of an
 * existing one. Errors show the server's text.
 */
export function ThreeMfImportWizard({ productId, state, sizeOptionId, targetLabel, targetComponents, onClose, onImported }: Props) {
  const { toast } = useToast();
  const [choices, setChoices] = useState<Record<number, PlateChoice>>({});
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state) return;
    setChoices(initialChoices(state));
    setError(null);
  }, [state]);

  const plates = useMemo(() => state?.analysis.plates ?? [], [state]);
  const selected = plates.filter(p => choices[p.plateIndex]?.selected);
  const summary = useMemo(() => {
    let grams = 0; let seconds = 0; let components = 0; let layouts = 0;
    for (const p of selected) {
      const c = choices[p.plateIndex];
      grams += p.weightGrams; seconds += p.printSeconds;
      const u = unitsOf(c);
      if (!isSliced(p) || c.addAs === NEW_COMPONENT) components += 1;
      if (isSliced(p) && (c.addAs !== NEW_COMPONENT || (u !== null && u > 1))) layouts += 1;
    }
    const existing = targetComponents.reduce((n, c) => n + c.plateLayouts.filter(l => l.isActive).length, 0);
    return { grams, seconds, components, layouts, existing };
  }, [selected, choices, targetComponents]);

  const invalid = selected.some(p => {
    if (!isSliced(p)) return false;
    const c = choices[p.plateIndex];
    const u = unitsOf(c);
    return Number.isNaN(u) || (c.addAs !== NEW_COMPONENT && u === null);
  });

  if (!state) return null;

  async function handleImport() {
    if (!state || selected.length === 0 || invalid) return;
    setImporting(true);
    setError(null);
    try {
      const fd = new FormData();
      // A big file was staged once for the analysis; reference it instead of re-uploading.
      if (state.stagedUploadId) fd.append('assembledUploadId', state.stagedUploadId);
      else if (state.file.size >= CHUNK_THRESHOLD) fd.append('assembledUploadId', await stageLargeFile(state.file));
      else fd.append('file', state.file);
      const units: Record<string, number> = {};
      const targets: Record<string, string> = {};
      const names: Record<string, string> = {};
      for (const p of selected) {
        const c = choices[p.plateIndex];
        names[String(p.plateIndex)] = c.name.trim() || p.name;
        if (!isSliced(p)) continue;
        const u = unitsOf(c);
        if (u !== null && !Number.isNaN(u) && (u > 1 || c.addAs !== NEW_COMPONENT)) units[String(p.plateIndex)] = u;
        if (c.addAs !== NEW_COMPONENT) targets[String(p.plateIndex)] = c.addAs;
      }
      fd.append('selectedPlates', JSON.stringify(selected.map(p => p.plateIndex)));
      fd.append('plateNames', JSON.stringify(names));
      if (Object.keys(units).length) fd.append('units', JSON.stringify(units));
      if (Object.keys(targets).length) fd.append('targets', JSON.stringify(targets));
      if (sizeOptionId) fd.append('sizeOptionId', sizeOptionId);
      const r = await api.postForm<ImportResult>(`/products/${productId}/onboard-3mf`, fd);
      importToasts(r, toast);
      onImported();
      onClose();
    } catch (err) {
      setError(errorText(err, 'The 3MF import failed'));
    } finally {
      setImporting(false);
    }
  }

  const { analysis } = state;
  return (
    <Dialog open onClose={importing ? () => undefined : onClose} title={`Import 3MF onto ${targetLabel}`} className="max-w-4xl">
      <div className="space-y-3">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {plural(analysis.totalPlates, 'plate')} in {state.file.name} · slicer {analysis.slicer || 'unknown'}
        </p>
        <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
          Selected: {plural(selected.length, 'plate')} · total {formatGrams(summary.grams)} · {formatMinutes(summary.seconds / 60)} ·
          adds {plural(summary.components, 'component')} and {plural(summary.layouts, 'plate layout')} (existing {summary.existing})
        </p>
        <div className="grid max-h-[55vh] grid-cols-1 gap-3 overflow-y-auto pr-1 md:grid-cols-2 lg:grid-cols-3">
          {plates.map(p => choices[p.plateIndex] && (
            <PlatePreviewCard
              key={p.plateIndex}
              plate={p}
              choice={choices[p.plateIndex]}
              components={targetComponents}
              onChange={next => setChoices(prev => ({ ...prev, [p.plateIndex]: { ...prev[p.plateIndex], ...next } }))}
            />
          ))}
        </div>
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex items-center justify-end gap-2 border-t pt-3 dark:border-gray-700">
          <Button variant="outline" onClick={onClose} disabled={importing}>Cancel</Button>
          <Button onClick={() => void handleImport()} disabled={importing || selected.length === 0 || invalid}>
            {importing ? 'Importing…' : `Import ${plural(selected.length, 'plate')}`}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
