'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { filamentLabel, materialMergeSummary, type MaterialMergeResult } from '@printforge/types';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Swatch, swatchHex } from '@/components/ui/swatch';
import { useToast } from '@/components/ui/toast';
import { FilamentPicker } from '@/components/filaments/FilamentPicker';
import { useFilamentStock } from '@/components/filaments/useFilamentStock';
import { api } from '@/lib/api';
import type { FilamentStockRow } from '@/lib/types/api';

interface Props {
  /** The filament being merged away (this page's filament). */
  material: { id: string; name: string; type: string; color?: string | null; colorHex?: string | null };
  open: boolean;
  onClose: () => void;
}

const FAILED = 'Couldn\'t merge the filament';

/**
 * ADMIN: merge this filament into another of the same type (POST
 * /materials/:id/merge). Pick the target → the dry run's counts in plain
 * words and its warnings → "Merge and delete". On success, the target's page.
 */
export function MergeMaterialDialog({ material, open, onClose }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const stock = useFilamentStock(open, open);
  const [target, setTarget] = useState<FilamentStockRow | null>(null);
  const [preview, setPreview] = useState<MaterialMergeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setTarget(null);
    setPreview(null);
    setError(null);
    setBusy(false);
  }, [open, material.id]);

  useEffect(() => {
    if (!preview) return;
    const t = setTimeout(() => backRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [preview]);

  // Same type only, never the filament itself.
  const rows = useMemo(
    () => stock.rows?.filter((r) => r.type === material.type && r.id !== material.id) ?? null,
    [stock.rows, material.type, material.id],
  );

  async function pick(row: FilamentStockRow) {
    setTarget(row);
    setError(null);
    setBusy(true);
    try {
      setPreview(await api.post<MaterialMergeResult>(`/materials/${material.id}/merge`, { targetMaterialId: row.id }));
    } catch (err: unknown) {
      setTarget(null);
      setError(err instanceof Error && err.message ? err.message : FAILED);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!target) return;
    setError(null);
    setBusy(true);
    try {
      const r = await api.post<MaterialMergeResult>(`/materials/${material.id}/merge`, { targetMaterialId: target.id, confirm: true });
      toast('success', `Merged "${r.source.name}" into ${filamentLabel(r.target).text}`);
      onClose();
      router.push(`/inventory/${r.target.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error && err.message ? err.message : FAILED);
      setBusy(false);
    }
  }

  function back() {
    setPreview(null);
    setTarget(null);
    setError(null);
    setTimeout(() => searchRef.current?.focus(), 0);
  }

  const lines = preview ? materialMergeSummary(preview.counts) : [];
  const into = target ? filamentLabel(target) : null;

  return (
    <Dialog open={open} onClose={busy ? () => undefined : onClose} title={`Merge "${material.name}" into…`} className="max-w-md">
      <div className="space-y-3">
        {!preview && (
          <>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Everything that uses this filament moves to the one you pick, then this filament is deleted. Only {material.type} filaments are listed.
            </p>
            <FilamentPicker
              rows={rows}
              loading={stock.loading}
              error={stock.error}
              onRetry={stock.refresh}
              preferType={material.type}
              currentMaterialId={null}
              savingId={busy ? target?.id ?? null : null}
              disabled={busy}
              inputRef={searchRef}
              onPick={(row) => void pick(row)}
            />
          </>
        )}
        {preview && target && into && (
          <>
            <p className="flex flex-wrap items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
              Merge into: <Swatch hex={swatchHex(target.colorHex)} name={target.color || target.name} title={into.primary} />
              <span className="font-medium">{into.text}</span>
            </p>
            {lines.length > 0 ? (
              <div className="text-sm text-gray-700 dark:text-gray-300">
                <p>These move to {into.primary}:</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {lines.map((l) => <li key={l}>{l}</li>)}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-gray-700 dark:text-gray-300">Nothing uses &quot;{material.name}&quot; — it is just deleted.</p>
            )}
            {preview.warnings.length > 0 && (
              <ul className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
                {preview.warnings.map((w) => <li key={w.code}>{w.message}</li>)}
              </ul>
            )}
            <div className="flex flex-wrap justify-end gap-3">
              <Button ref={backRef} type="button" variant="outline" onClick={back} disabled={busy}>Back</Button>
              <Button type="button" variant="destructive" onClick={() => void confirm()} disabled={busy}>
                {busy ? 'Merging…' : `Merge and delete "${material.name}"`}
              </Button>
            </div>
          </>
        )}
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </Dialog>
  );
}
