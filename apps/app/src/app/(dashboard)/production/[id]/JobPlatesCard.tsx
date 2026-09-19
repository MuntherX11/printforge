'use client';

/**
 * The job's plates (spec §5.3): what to print, how long and how heavy each
 * plate is, its file, and per component how many units the plates make
 * against what is needed and where the extras go.
 */
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { formatGrams, formatMinutes, policyLabel } from '@/lib/product-format';
import type { JobPlateDetail, JobSurplusRow, SurplusPolicy } from '@/lib/types/api';

interface Props {
  plates: JobPlateDetail[];
  surplus: JobSurplusRow[];
  policy: SurplusPolicy | null;
}

export function JobPlatesCard({ plates, surplus, policy }: Props) {
  if (!plates.length) return null;
  const totalPlates = plates.reduce((n, p) => n + p.plateCount, 0);
  return (
    <Card>
      <CardHeader><CardTitle>Plates</CardTitle></CardHeader>
      <CardContent className="p-0">
        <div className="divide-y dark:divide-gray-700">
          {plates.map(p => (
            <div key={p.id} className="flex items-center gap-3 px-4 py-3">
              <p className="min-w-0 flex-1 text-sm dark:text-gray-100">
                <span className="font-medium">
                  {p.plateCount} × {p.componentDescription}{p.unitsPerPlate > 1 ? ` ×${p.unitsPerPlate}` : ''}
                </span>
                <span className="text-gray-500 dark:text-gray-400"> — {formatMinutes(p.plateMinutes)}, {formatGrams(p.plateGrams)} each</span>
              </p>
              {p.downloadUrl ? (
                <a href={p.downloadUrl} className="flex-shrink-0 text-sm text-blue-600 hover:underline dark:text-blue-400">Download</a>
              ) : (
                <span className="flex-shrink-0 text-xs text-gray-400">No file</span>
              )}
            </div>
          ))}
        </div>
        <div className="space-y-1 border-t px-4 py-2.5 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
          {surplus.map(s => (
            <p key={s.componentId ?? s.description}>
              {surplus.length > 1 ? `${s.description}: ` : ''}Prints {s.unitsPrinted} for {s.unitsRequired} needed · {s.surplus} extra
              {s.surplus > 0 && policy ? ` · ${policyLabel(policy)}` : ''}
              {s.creditOnComplete > 0 ? ` (+${s.creditOnComplete} to printed stock on completion)` : ''}
            </p>
          ))}
          {totalPlates > 1 && (
            <p className="text-amber-600 dark:text-amber-400">
              Printer auto-complete is off for jobs with more than one plate — mark it complete here
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
