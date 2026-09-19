'use client';

import { useCallback, useState } from 'react';
import { api } from '@/lib/api';
import { CHUNK_THRESHOLD, splitAndStage, stageLargeFile } from '@/lib/chunked-upload';
import { useToast } from '@/components/ui/toast';
import { plural } from '@/lib/product-format';
import type { ApiThreeMfAnalyzeResult, ProductDetail, SlicerImportResult, ThreeMfAnalysis } from '@/lib/types/api';
import { errorText } from './options-ui';

export type ImportResult = SlicerImportResult<ProductDetail>;
type ToastFn = (type: 'success' | 'error' | 'warning', message: string) => void;

function listed(messages: string[], max = 3): string {
  const head = messages.slice(0, max).join(' ');
  return messages.length > max ? `${head} …and ${messages.length - max} more.` : head;
}

/**
 * The toasts after an M1/M2 import (spec §5.1 ThreeMfImportWizard): what was
 * created, each new filament by name (its cost is 0 until set on the
 * Filaments page), the printer assigned, and the server warnings verbatim
 * (e.g. COLOUR_SLOT_NOT_LINKED, COLOUR_LINKED_BY_POSITION, PLATE_NOT_SLICED).
 */
export function importToasts(r: ImportResult, toast: ToastFn) {
  const components = r.results.reduce((n, x) => n + (x.componentsCreated ?? 0), 0);
  const bits = [plural(components, 'component') + ' added'];
  if (r.layoutsCreated.length) bits.push(plural(r.layoutsCreated.length, 'plate layout') + ' added');
  if (r.defaultPrinterAssigned) bits.push(`pricing printer set to ${r.defaultPrinterAssigned.name}`);
  toast('success', `Imported: ${bits.join(', ')}`);
  for (const m of r.createdMaterials) {
    toast('warning', `New filament "${m.name}" was created with cost 0 — set its cost per gram on the Filaments page; the price isn't recalculated until then.`);
  }
  if (r.skipped.length) {
    toast('warning', listed(r.skipped.map(s => `Skipped ${s.fileName ?? `plate ${s.plateIndex}`}: ${s.reason}.`)));
  }
  if (r.warnings.length) toast('warning', listed(r.warnings.map(w => w.message)));
}

export interface ThreeMfWizardState {
  file: File;
  stagedUploadId: string | null;
  analysis: ThreeMfAnalysis;
}

/** `Import 3MF` (analyse, then the wizard) and `Upload G-code` (M1) for one BOM scope. */
export function useSlicerImport(productId: string, sizeOptionId: string | null, onImported: () => void) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<'analyse' | 'upload' | null>(null);
  const [wizard, setWizard] = useState<ThreeMfWizardState | null>(null);

  const startThreeMf = useCallback(async (file: File) => {
    setBusy('analyse');
    try {
      // A big file is staged in parts once: the analysis peeks at it and the
      // import consumes it, so the browser never uploads the bytes twice.
      const fd = new FormData();
      let stagedUploadId: string | null = null;
      if (file.size >= CHUNK_THRESHOLD) {
        stagedUploadId = await stageLargeFile(file);
        fd.append('assembledUploadId', stagedUploadId);
      } else {
        fd.append('file', file);
      }
      const r = await api.postForm<ApiThreeMfAnalyzeResult>('/file-parser/analyze', fd);
      if (!r.analysis || r.analysis.type !== '3mf') throw new Error('That file is not a 3MF project');
      setWizard({ file, stagedUploadId, analysis: r.analysis });
    } catch (err) {
      toast('error', errorText(err, 'Couldn\'t read the 3MF file'));
    } finally {
      setBusy(null);
    }
  }, [toast]);

  const uploadGcode = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setBusy('upload');
    try {
      const { direct, assembledIds } = await splitAndStage(files);
      const fd = new FormData();
      for (const f of direct) fd.append('files', f);
      if (assembledIds.length) fd.append('assembledUploadIds', JSON.stringify(assembledIds));
      if (sizeOptionId) fd.append('sizeOptionId', sizeOptionId);
      const r = await api.postForm<ImportResult>(`/products/${productId}/onboard-gcode`, fd);
      importToasts(r, toast);
    } catch (err) {
      toast('error', errorText(err, 'G-code import failed'));
    } finally {
      // The server may have committed before a network error: reload either way.
      onImported();
      setBusy(null);
    }
  }, [productId, sizeOptionId, onImported, toast]);

  return { busy, wizard, closeWizard: () => setWizard(null), startThreeMf, uploadGcode };
}
