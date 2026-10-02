'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import type { ComponentPlateRow, PlateFileResult } from '@printforge/types';
import { TableRow } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { stageLargeFile } from '@/lib/chunked-upload';
import { useFormatCurrency } from '@/lib/locale-context';
import { formatGrams, formatMinutes, formatPct } from '@/lib/product-format';
import { cn } from '@/lib/utils';
import type { ComponentDetail } from '@/lib/types/api';
import { LinkButton, errorText } from './options-ui';

interface Props {
  productId: string;
  component: ComponentDetail;
  canEdit: boolean;
  /** columns of the bill-of-materials table the row spans */
  colSpan: number;
  onChanged: () => void;
}

const HEAD = ['Plate', 'Units', 'Time', 'Filament (g)', 'Cost / unit', 'Price / unit', 'Margin', 'Printer', 'File'];

/**
 * Every plate of one part under its bill-of-materials row (owner spec
 * 2026-10-02): the part's own ×1 and each active ×N layout, with time,
 * filament, cost and price per unit, margin, the printer the file was sliced
 * for and the file. Editors can upload a file onto a plate without one and
 * delete a plate's file; Manage still adds, edits and deletes plates.
 */
export function PlateList({ productId, component: c, canEdit, colSpan, onChanged }: Props) {
  const { toast } = useToast();
  const formatCurrency = useFormatCurrency();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const rows = c.plates ?? [];
  if (!rows.length) return null;

  const keyOf = (r: ComponentPlateRow) => r.layoutId ?? 'own';
  const urlOf = (r: ComponentPlateRow) => r.layoutId
    ? `/products/${productId}/components/${c.id}/plate-layouts/${r.layoutId}/file`
    : `/products/${productId}/components/${c.id}/file`;
  const label = (r: ComponentPlateRow) => `${c.description} ×${r.unitsPerPlate}`;

  async function upload(r: ComponentPlateRow, file: File) {
    setBusy(keyOf(r));
    try {
      const assembledUploadId = await stageLargeFile(file);
      const out = await api.post<PlateFileResult>(urlOf(r), { assembledUploadId });
      const notes = out.warnings.map(w => w.message).join(' ');
      toast(notes ? 'warning' : 'success', notes ? `File saved — ${notes}` : `File saved on ${label(r)}`);
      onChanged();
    } catch (err) {
      toast('error', errorText(err, 'Couldn\'t save the file'));
    } finally {
      setBusy(null);
    }
  }

  async function remove(r: ComponentPlateRow) {
    setBusy(keyOf(r));
    try {
      await api.delete(urlOf(r));
      toast('success', `File deleted from ${label(r)}`);
      setConfirm(null);
      onChanged();
    } catch (err) {
      toast('error', errorText(err, 'Couldn\'t delete the file'));
    } finally {
      setBusy(null);
    }
  }

  const money = (n: number | null) => (n === null ? '—' : formatCurrency(n));

  return (
    <TableRow className="hover:bg-transparent dark:hover:bg-transparent">
      <td colSpan={colSpan} className="px-4 pb-3 pt-0 dark:text-gray-300">
        <div className="overflow-x-auto rounded-md border border-gray-100 dark:border-gray-800 sm:ml-10">
          <table className="w-full text-xs">
            <caption className="sr-only">Plates of {c.description}</caption>
            <thead>
              <tr className="border-b text-left text-gray-500 dark:border-gray-800 dark:text-gray-400">
                {HEAD.map(h => <th key={h} scope="col" className="whitespace-nowrap px-2 py-1.5 font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const k = keyOf(r);
                return (
                  <tr key={k} className="border-b last:border-0 dark:border-gray-800">
                    <td className="whitespace-nowrap px-2 py-1.5 font-medium text-gray-800 dark:text-gray-200">{r.name}</td>
                    <td className="px-2 py-1.5 tabular-nums">{r.unitsPerPlate}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{formatMinutes(r.plateMinutes)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{formatGrams(r.plateGrams)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{money(r.costPerUnit)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 tabular-nums" title={r.priceSource === 'TIER' ? `Bulk price from ${r.tierMinQty} units` : undefined}>
                      {money(r.pricePerUnit)}
                    </td>
                    <td className={cn('whitespace-nowrap px-2 py-1.5 tabular-nums', r.marginPct !== null && r.marginPct < 0 && 'text-red-600 dark:text-red-400')}>
                      {r.marginPct === null ? '—' : formatPct(r.marginPct)}
                    </td>
                    <td className="px-2 py-1.5">
                      {r.printer
                        ? <span className="whitespace-nowrap">{r.printer.name}</span>
                        : r.slicedFor
                          ? <span className="text-amber-700 dark:text-amber-300">Sliced for {r.slicedFor} — no matching printer</span>
                          : <span className="text-gray-400">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      {r.file ? (
                        <span className="inline-flex items-center gap-2">
                          <a href={r.file.downloadUrl} download title={r.file.filename}
                            className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline dark:text-brand-400">
                            <Download className="h-3.5 w-3.5" aria-hidden="true" /> Download
                          </a>
                          {canEdit && (confirm === k ? (
                            <>
                              <LinkButton tone="danger" disabled={busy !== null} onClick={() => void remove(r)}>Delete file?</LinkButton>
                              <LinkButton onClick={() => setConfirm(null)}>Keep</LinkButton>
                            </>
                          ) : (
                            <LinkButton tone="danger" disabled={busy !== null} title={`Delete the file of ${label(r)}`} onClick={() => setConfirm(k)}>Delete</LinkButton>
                          ))}
                        </span>
                      ) : canEdit ? (
                        <label className={cn('cursor-pointer font-medium text-brand-600 hover:underline dark:text-brand-400', busy !== null && 'pointer-events-none opacity-50')}>
                          <input type="file" accept=".gcode,.gco,.g" className="sr-only" disabled={busy !== null}
                            aria-label={`Upload a G-code for ${label(r)}`}
                            onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(r, f); }} />
                          {busy === k ? 'Uploading…' : 'No file — upload one'}
                        </label>
                      ) : (
                        <span className="text-gray-400">No file</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </td>
    </TableRow>
  );
}
