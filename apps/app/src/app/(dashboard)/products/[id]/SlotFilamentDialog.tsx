'use client';

import { useEffect, useRef, useState } from 'react';
import { filamentPickWrite, writeResultMessage } from '@printforge/types';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Swatch, swatchHex } from '@/components/ui/swatch';
import { useToast } from '@/components/ui/toast';
import { FilamentPicker } from '@/components/filaments/FilamentPicker';
import type { FilamentStock } from '@/components/filaments/useFilamentStock';
import { formatGrams } from '@/lib/product-format';
import type { ComponentDetail, FilamentStockRow, Problem, ProductDetail } from '@/lib/types/api';
import { ImpactList } from './options-ui';
import { isMultiColour, slotPartLabel } from './options-model';
import { slotViews } from './bom-model';
import { useComponentWrite } from './useComponentWrite';

interface Props {
  product: ProductDetail;
  component: ComponentDetail | null;
  colorIndex: number;
  open: boolean;
  /** The size shown in the BOM ("Standard", "Large"…). */
  scopeLabel: string;
  stock: FilamentStock;
  onClose: () => void;
  onSaved: () => void;
}

const PICK_FAILED = 'Couldn\'t change the filament';

/**
 * Pick the filament of one colour slot straight from its BOM chip (P10 for a
 * single-material part, P11 for a multicolour one), with the same dry run,
 * open-line impact and `Save anyway` as Edit component. Only the component's
 * own filament changes; colour options keep their assignments.
 */
export function SlotFilamentDialog({ product, component: c, colorIndex, open, scopeLabel, stock, onClose, onSaved }: Props) {
  const { toast } = useToast();
  const writer = useComponentWrite(product.id, c?.id ?? null);
  const [picked, setPicked] = useState<FilamentStockRow | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    writer.reset();
    setPicked(null);
    // Reset on open and on another slot only; a background reload keeps the state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, c?.id, colorIndex]);

  useEffect(() => {
    if (!writer.impact) return;
    const t = setTimeout(() => backRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [writer.impact]);

  const slot = c ? slotViews(product, c).find(s => s.colorIndex === colorIndex) : undefined;
  if (!c || !slot) return null;
  const part = slotPartLabel(c, c.description, colorIndex);
  const note = [
    product.sizes.length > 0 ? `Changes ${scopeLabel} only.` : null,
    product.colours.length > 0 ? 'Colour options keep their own filaments.' : null,
  ].filter(Boolean).join(' ');

  function finish(warnings: Problem[], row: FilamentStockRow) {
    const m = writeResultMessage(warnings, `Saved "${part}" — ${row.name}`);
    toast(m.tone, m.text);
    onSaved();
    onClose();
  }

  async function pick(row: FilamentStockRow) {
    if (!c) return;
    const w = filamentPickWrite({
      multi: isMultiColour(c),
      materialId: c.materialId,
      slots: c.materials.map(m => ({ colorIndex: m.colorIndex, materialId: m.materialId })),
    }, colorIndex, row.id);
    if (!w) { onClose(); return; }
    setPicked(row);
    const r = await writer.submit(w, PICK_FAILED);
    if (r) finish(r, row);
  }

  async function confirmAnyway() {
    const r = await writer.confirm(PICK_FAILED);
    if (r && picked) finish(r, picked);
  }

  function back() {
    writer.clearImpact();
    setPicked(null);
    setTimeout(() => searchRef.current?.focus(), 0);
  }

  return (
    <Dialog open={open} onClose={writer.saving ? () => undefined : onClose} title={`Filament — ${part}`} className="max-w-md">
      <div className="space-y-3">
        <p className="flex flex-wrap items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
          Now: <Swatch hex={swatchHex(slot.material?.colorHex)} title={slot.material?.name ?? 'No filament'} />
          <span className="font-medium">{slot.material?.name ?? 'No filament'}</span>
          <span className="text-xs text-gray-500 dark:text-gray-400">· {formatGrams(slot.grams)} per unit</span>
        </p>
        {note && <p className="text-xs text-gray-500 dark:text-gray-400">{note}</p>}
        <div className={writer.impact ? 'hidden' : undefined}>
          <FilamentPicker
            rows={stock.rows}
            loading={stock.loading}
            error={stock.error}
            onRetry={stock.refresh}
            preferType={slot.material?.type ?? null}
            currentMaterialId={slot.material?.id ?? null}
            savingId={writer.saving && !writer.impact ? picked?.id ?? null : null}
            disabled={writer.saving}
            inputRef={searchRef}
            onPick={row => void pick(row)}
          />
        </div>
        {writer.impact && picked && (
          <>
            <p className="flex flex-wrap items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
              Change to: <Swatch hex={swatchHex(picked.colorHex)} title={picked.color || picked.name} />
              <span className="font-medium">{picked.name}</span>
            </p>
            <ImpactList impact={writer.impact} />
            <div className="flex justify-end gap-3">
              <Button ref={backRef} type="button" variant="outline" onClick={back} disabled={writer.saving}>Back</Button>
              <Button type="button" onClick={() => void confirmAnyway()} disabled={writer.saving}>{writer.saving ? 'Saving…' : 'Save anyway'}</Button>
            </div>
          </>
        )}
        {writer.error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{writer.error}</p>}
      </div>
    </Dialog>
  );
}
