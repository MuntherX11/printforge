'use client';

import { useEffect, useState } from 'react';
import { detectionPrefill, parsePlateUnits, perUnitFigures, plateUnitsProblem, type PlateUnitsDetection } from '@printforge/types';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { formatGrams, formatMinutes } from '@/lib/product-format';
import { errorText } from './options-ui';
import { importToasts, postGcodeImport, type GcodeConfirmState, type GcodeFileCheck } from './useSlicerImport';

interface Props {
  productId: string;
  state: GcodeConfirmState | null;
  /** Import target: null = the standard size. */
  sizeOptionId: string | null;
  targetLabel: string;
  onClose: () => void;
  onImported: () => void;
}

function detectedText(d: PlateUnitsDetection): string {
  switch (d.kind) {
    case 'UNITS': return `${d.units} units detected on this plate`;
    case 'SINGLE': return '1 object on this plate';
    case 'MIXED': return `Different models on this plate (${d.models.map(m => `${m.count} × ${m.model}`).join(', ')})`;
    default: return 'No object labels in this file';
  }
}

function resultText(f: GcodeFileCheck, units: number | null): string {
  if (!(f.plate.grams > 0)) return '— no filament weight found, so this file is skipped';
  if (units !== null && units > 1 && !Number.isNaN(units)) {
    const per = perUnitFigures(f.plate, units);
    return `→ 1 part (${formatGrams(per.grams)} · ${formatMinutes(per.minutes)} each) + a ×${units} plate layout`;
  }
  return `→ 1 part (${formatGrams(f.plate.grams)} · ${formatMinutes(f.plate.minutes)})`;
}

function hintText(d: PlateUnitsDetection): string | null {
  if (d.kind === 'UNKNOWN') return 'Enter how many units are on the plate if it holds several';
  if (d.kind === 'MIXED') return 'Imported as one part. A plate layout belongs to one part — enter its units only to make one';
  return null;
}

/**
 * Upload G-code, confirm step (owner: "gcode uploaded should automatically be
 * scanned for the number of units on plate"). Each file's detected units are
 * prefilled and editable; ×N imports one part per unit plus a ×N plate layout
 * holding the file, or everything can go in as one part with no plate.
 */
export function GcodeImportDialog({ productId, state, sizeOptionId, targetLabel, onClose, onImported }: Props) {
  const { toast } = useToast();
  const [units, setUnits] = useState<string[]>([]);
  const [importing, setImporting] = useState<'units' | 'plain' | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The request failed without a server rejection: it may have committed, so a retry could duplicate it. */
  const [maybeImported, setMaybeImported] = useState(false);

  useEffect(() => {
    if (!state) return;
    setUnits(state.files.map(f => detectionPrefill(f.detection)));
    setError(null);
    setMaybeImported(false);
  }, [state]);

  if (!state || units.length !== state.files.length) return null;
  const files = state.files;
  const parsed = units.map(parsePlateUnits);
  const problems = files.map((f, i) => plateUnitsProblem(f.plate, parsed[i]));
  const invalid = parsed.some(u => Number.isNaN(u)) || problems.some(Boolean);
  const anyPlate = files.some((f, i) => f.plate.grams > 0 && (parsed[i] ?? 0) > 1);
  const many = files.length > 1;

  async function submit(mode: 'units' | 'plain') {
    if (!state || maybeImported || (mode === 'units' && invalid)) return;
    const body: Record<string, number> = {};
    if (mode === 'units') parsed.forEach((u, i) => { if (u !== null && u > 1) body[String(i)] = u; });
    setImporting(mode);
    setError(null);
    try {
      importToasts(await postGcodeImport(productId, sizeOptionId, files, body), toast);
      onImported();
      onClose();
    } catch (err) {
      const rejected = err instanceof ApiError && err.status >= 400 && err.status < 500;
      if (rejected) {
        setError(errorText(err, 'G-code import failed'));
      } else {
        // A lost response may follow a committed import: reload and don't offer a retry.
        setMaybeImported(true);
        setError(`${errorText(err, 'G-code import failed')} — the import may have completed. Check the bill of materials before uploading these files again.`);
        onImported();
      }
    } finally {
      setImporting(null);
    }
  }

  return (
    <Dialog open onClose={importing ? () => undefined : onClose} title={`Upload G-code onto ${targetLabel}`} className="max-w-2xl">
      <div className="space-y-3">
        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          {files.map((f, i) => {
            const id = `gcode-units-${i}`;
            const hint = hintText(f.detection);
            const u = parsed[i];
            return (
              <div key={f.stagedId} className="space-y-2 rounded-md border border-gray-200 p-3 dark:border-gray-700">
                {many && <p className="break-all text-sm font-medium text-gray-900 dark:text-gray-100">{f.fileName}</p>}
                <p className={cn('text-sm', f.detection.kind === 'MIXED' ? 'text-amber-700 dark:text-amber-300' : 'text-gray-800 dark:text-gray-200')}>
                  {detectedText(f.detection)} <span className="text-gray-800 dark:text-gray-200">{resultText(f, u)}</span>
                </p>
                {f.plate.grams > 0 && (
                  <div>
                    <label htmlFor={id} className="text-xs font-medium text-gray-700 dark:text-gray-300">Units on the plate</label>
                    <input
                      id={id}
                      type="number"
                      min={1}
                      max={500}
                      step={1}
                      inputMode="numeric"
                      value={units[i]}
                      placeholder={f.detection.kind === 'UNKNOWN' || f.detection.kind === 'MIXED' ? 'e.g. 12' : undefined}
                      disabled={importing !== null || maybeImported}
                      onChange={e => { const v = e.target.value; setUnits(prev => prev.map((x, j) => (j === i ? v : x))); }}
                      className={cn(
                        'mt-0.5 block h-9 w-24 rounded-md border bg-white px-2 text-sm dark:bg-gray-800 dark:text-gray-100',
                        Number.isNaN(u) || problems[i] ? 'border-red-500' : 'border-gray-300 dark:border-gray-600',
                      )}
                    />
                    {hint && <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
                    {Number.isNaN(u) && <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">Whole number from 1 to 500</p>}
                    {problems[i] && <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{problems[i]}</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3 dark:border-gray-700">
          <Button variant="outline" onClick={onClose} disabled={importing !== null}>{maybeImported ? 'Close' : 'Cancel'}</Button>
          {anyPlate && (
            <Button variant="outline" onClick={() => void submit('plain')} disabled={importing !== null || maybeImported}>
              {importing === 'plain' ? 'Importing…' : many ? 'Import as one part each (no plates)' : 'Import as one part (no plate)'}
            </Button>
          )}
          <Button onClick={() => void submit('units')} disabled={importing !== null || invalid || maybeImported}>
            {importing === 'units' ? 'Importing…' : 'Import'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
