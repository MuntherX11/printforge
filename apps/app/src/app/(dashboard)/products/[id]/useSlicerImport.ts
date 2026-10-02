'use client';

import { useCallback, useState } from 'react';
import { api } from '@/lib/api';
import { CHUNK_THRESHOLD, stageLargeFile } from '@/lib/chunked-upload';
import { detectPlateUnits, gcodePlateFigures, isExactFilamentMatch, type FilamentSlotMatch, type PlateFigures, type PlateUnitsDetection } from '@printforge/types';
import { useToast } from '@/components/ui/toast';
import { plural } from '@/lib/product-format';
import type { ApiGcodeAnalysis, ApiThreeMfAnalyzeResult, ProductDetail, SlicerImportResult, ThreeMfAnalysis } from '@/lib/types/api';
import { errorText } from './options-ui';

export type ImportResult = SlicerImportResult<ProductDetail>;
/** The api's M1 file limit (MAX_IMPORT_FILES). */
const MAX_GCODE_FILES = 20;
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

/** One uploaded G-code, staged and read before the import (owner: scan the plate for its units). */
export interface GcodeFileCheck {
  fileName: string;
  stagedId: string;
  detection: PlateUnitsDetection;
  plate: PlateFigures;
  /** Each used slot and the filament the import will use (read-only preview). */
  filamentMatches: FilamentSlotMatch[];
}

export interface GcodeConfirmState {
  files: GcodeFileCheck[];
}

/** M1 with every file already staged; `units` is keyed by the file's position. */
export function postGcodeImport(productId: string, sizeOptionId: string | null, files: GcodeFileCheck[], units: Record<string, number>) {
  const fd = new FormData();
  fd.append('assembledUploadIds', JSON.stringify(files.map(f => f.stagedId)));
  if (Object.keys(units).length) fd.append('units', JSON.stringify(units));
  if (sizeOptionId) fd.append('sizeOptionId', sizeOptionId);
  return api.postForm<ImportResult>(`/products/${productId}/onboard-gcode`, fd);
}

/** `Import 3MF` (analyse, then the wizard) and `Upload G-code` (M1) for one BOM scope. */
export function useSlicerImport(productId: string, sizeOptionId: string | null, onImported: () => void) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<'analyse' | 'upload' | null>(null);
  const [wizard, setWizard] = useState<ThreeMfWizardState | null>(null);
  const [gcodeConfirm, setGcodeConfirm] = useState<GcodeConfirmState | null>(null);

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
      const r = await api.postForm<ApiThreeMfAnalyzeResult>('/file-parser/analyze?matchFilaments=1', fd);
      if (!r.analysis || r.analysis.type !== '3mf') throw new Error('That file is not a 3MF project');
      setWizard({ file, stagedUploadId, analysis: r.analysis });
    } catch (err) {
      toast('error', errorText(err, 'Couldn\'t read the 3MF file'));
    } finally {
      setBusy(null);
    }
  }, [toast]);

  /**
   * Each file is staged once and its object labels read (M6, the staged copy
   * is kept); the import then consumes the staged copies. Plates of one
   * object whose filaments all match exactly import straight away as before;
   * anything else (several units, no labels, mixed models, a new or
   * nearest-colour filament) goes through the confirm step first.
   */
  const uploadGcode = useCallback(async (files: File[]) => {
    if (!files.length) return;
    if (files.length > MAX_GCODE_FILES) {
      toast('error', `At most ${MAX_GCODE_FILES} files per import`);
      return;
    }
    setBusy('upload');
    let checks: GcodeFileCheck[] = [];
    try {
      for (const file of files) {
        const stagedId = await stageLargeFile(file);
        const fd = new FormData();
        fd.append('assembledUploadId', stagedId);
        const a = await api.postForm<ApiGcodeAnalysis>('/file-parser/parse-gcode?matchFilaments=1', fd);
        checks.push({ fileName: file.name, stagedId, detection: detectPlateUnits(a), plate: gcodePlateFigures(a), filamentMatches: a.filamentMatches ?? [] });
      }
    } catch (err) {
      toast('error', errorText(err, 'Couldn\'t read the G-code'));
      checks = [];
    }
    // The confirm step also shows when a slot isn't an exact match, so a new or
    // nearest-colour filament is seen before it lands on the bill of materials.
    if (checks.length && checks.some(c => c.detection.kind !== 'SINGLE' || c.filamentMatches.some(m => !isExactFilamentMatch(m)))) {
      setGcodeConfirm({ files: checks });
    } else if (checks.length) {
      try {
        importToasts(await postGcodeImport(productId, sizeOptionId, checks, {}), toast);
      } catch (err) {
        toast('error', errorText(err, 'G-code import failed'));
      } finally {
        // The server may have committed before a network error: reload either way.
        onImported();
      }
    }
    setBusy(null);
  }, [productId, sizeOptionId, onImported, toast]);

  return { busy, wizard, closeWizard: () => setWizard(null), startThreeMf, uploadGcode, gcodeConfirm, closeGcodeConfirm: () => setGcodeConfirm(null) };
}
