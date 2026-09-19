'use client';

/**
 * Reprint a failed job (spec §5.3, J7). A job with plates lists them with a
 * count each (default: all at their original counts, at most that many);
 * a job without plates is cloned as before.
 */
import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { JobPlateDetail, ReprintJobInput } from '@/lib/types/api';

interface Props {
  open: boolean;
  jobName: string;
  plates: JobPlateDetail[];
  busy: boolean;
  onClose: () => void;
  onConfirm: (body: ReprintJobInput) => void;
}

export function ReprintDialog({ open, jobName, plates, busy, onClose, onConfirm }: Props) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    if (open) setCounts(Object.fromEntries(plates.map(p => [p.id, p.plateCount])));
  }, [open, plates]);

  const chosen = plates.filter(p => (counts[p.id] ?? 0) > 0);
  const invalid = plates.some(p => {
    const c = counts[p.id] ?? 0;
    return !Number.isInteger(c) || c < 0 || c > p.plateCount;
  });

  return (
    <Dialog open={open} onClose={busy ? () => undefined : onClose} title="Create Reprint Job">
      {plates.length === 0 ? (
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">This will clone <strong>{jobName}</strong> as a new QUEUED job. Continue?</p>
      ) : (
        <div className="mb-4 space-y-3">
          <p className="text-sm text-gray-600 dark:text-gray-400">Which plates of <strong>{jobName}</strong> should be printed again?</p>
          {plates.map(p => (
            <div key={p.id} className="flex items-center gap-3">
              <input
                type="number"
                min={0}
                max={p.plateCount}
                step={1}
                aria-label={`${p.componentDescription}${p.unitsPerPlate > 1 ? ` ×${p.unitsPerPlate}` : ''}: plates to reprint`}
                value={counts[p.id] ?? 0}
                disabled={busy}
                onChange={e => setCounts(prev => ({ ...prev, [p.id]: e.target.value === '' ? 0 : Number(e.target.value) }))}
                className="h-9 w-20 rounded-md border border-gray-300 bg-white px-2 text-sm tabular-nums dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
              />
              <span className="text-sm dark:text-gray-200">
                of {p.plateCount} × {p.componentDescription}{p.unitsPerPlate > 1 ? ` ×${p.unitsPerPlate}` : ''}
              </span>
            </div>
          ))}
          {invalid && <p role="alert" className="text-xs text-red-600 dark:text-red-400">Each count must be a whole number up to the plates the job had</p>}
          {!invalid && chosen.length === 0 && <p className="text-xs text-amber-600 dark:text-amber-400">Choose at least one plate</p>}
        </div>
      )}
      <div className="flex gap-3 justify-end">
        <Button variant="outline" onClick={onClose} disabled={busy}>Back</Button>
        <Button
          disabled={busy || (plates.length > 0 && (invalid || chosen.length === 0))}
          onClick={() => onConfirm(plates.length ? { plates: chosen.map(p => ({ jobPlateId: p.id, plateCount: counts[p.id] })) } : {})}
        >
          <RefreshCw className="h-4 w-4 mr-2" />{busy ? 'Creating...' : 'Create Reprint'}
        </Button>
      </div>
    </Dialog>
  );
}
