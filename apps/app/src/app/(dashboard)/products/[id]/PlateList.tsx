'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import type { ComponentPlateRow, PlateFileResult, SourceModelUploadResult } from '@printforge/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { stageLargeFile } from '@/lib/chunked-upload';
import { useFormatCurrency } from '@/lib/locale-context';
import { formatGrams, formatMinutes, formatPct } from '@/lib/product-format';
import { cn } from '@/lib/utils';
import type { ComponentDetail } from '@/lib/types/api';
import { LinkButton, errorText } from './options-ui';
import { SliceRunsRow } from './SliceRunsRow';
import { plateRowPrinter } from './product-layout';
import { isSlicedRow, sliceErrorText, sourceOf, sourceSummary } from './slice-ui';

interface Props {
  productId: string;
  component: ComponentDetail;
  canEdit: boolean;
  /** ADMIN: upload and remove the source model. */
  isAdmin: boolean;
  /** Printer id → name, for SLICED plates and the source's printer; null until loaded. */
  printers: ReadonlyMap<string, string> | null;
  /** Changing it refetches the part's slice runs (after a run was queued). */
  runsKey: unknown;
  /** "Show costs per plate": adds Cost / unit, Price / unit and Margin. */
  showCosts: boolean;
  onChanged: () => void;
  /** Opens "Slice a plate" for this part. */
  onSlice: () => void;
}

const HEAD = ['Plate', 'Units', 'Time', 'Filament', 'Printer', 'File'];
const COST_HEAD = ['Cost / unit', 'Price / unit', 'Margin'];
const NUMERIC = new Set(['Units', 'Time', 'Filament', ...COST_HEAD]);

/**
 * Every plate of one part, inside its opened row (owner spec 2026-10-02):
 * the source model strip with "Slice a plate", the part's slice runs, then
 * the part's own ×1 and each active ×N layout with time, filament, the
 * printer the file was sliced for and the file. Cost and price per unit and
 * the margin are extra columns behind "Show costs per plate". Editors can
 * upload a file onto a plate without one and delete a plate's file; Manage
 * still adds, edits and deletes plates.
 */
export function PlateList({ productId, component: c, canEdit, isAdmin, printers, runsKey, showCosts, onChanged, onSlice }: Props) {
  const { toast } = useToast();
  const formatCurrency = useFormatCurrency();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [sourceVersion, setSourceVersion] = useState(0);
  const rows = c.plates ?? [];
  const source = sourceOf(c);
  if (!rows.length && !canEdit) return null;

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
      toast(notes ? 'warning' : 'success', notes ? `File saved. ${notes}` : `File saved on ${label(r)}`);
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

  const sourceUrl = `/products/${productId}/components/${c.id}/source`;

  async function uploadSource(file: File) {
    setBusy('source');
    try {
      const assembledUploadId = await stageLargeFile(file);
      const out = await api.post<SourceModelUploadResult>(sourceUrl, { assembledUploadId });
      if (out.notice) toast('warning', `Source saved. ${out.notice}`);
      else if (out.validationRun) toast('success', `Source saved. Checking ${out.source.filename} with a 1-unit slice`);
      else toast('success', `Source saved: ${out.source.filename}`);
      setSourceVersion(v => v + 1);
      onChanged();
    } catch (err) {
      toast('error', sliceErrorText(err, 'Couldn\'t save the source model'));
    } finally {
      setBusy(null);
    }
  }

  async function removeSource() {
    setBusy('source');
    try {
      await api.delete(sourceUrl);
      toast('success', `Source model removed from ${c.description}`);
      setConfirm(null);
      setSourceVersion(v => v + 1);
      onChanged();
    } catch (err) {
      toast('error', errorText(err, 'Couldn\'t remove the source model'));
    } finally {
      setBusy(null);
    }
  }

  const money = (n: number | null) => (n === null ? '—' : formatCurrency(n));
  const printerName = (id: string | null) => (id ? printers?.get(id) ?? null : null);

  const head = showCosts ? [...HEAD.slice(0, 4), ...COST_HEAD, ...HEAD.slice(4)] : HEAD;
  const cell = 'whitespace-nowrap py-1.5 pr-4';
  const num = `${cell} text-right font-mono tabular-nums`;

  return (
    <div className="space-y-2 text-sm dark:text-gray-300">
      {canEdit && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-gray-500 dark:text-gray-400">Source model:</span>
          {source
            ? <span className="min-w-0 break-all font-medium text-gray-800 dark:text-gray-200">{sourceSummary(source, printerName(source.printerId))}</span>
            : <span className="text-gray-500 dark:text-gray-400">none</span>}
          {isAdmin && (
            <label className={cn('cursor-pointer rounded text-xs font-medium text-brand-600 hover:underline focus-within:ring-2 focus-within:ring-brand-500 dark:text-brand-400', busy !== null && 'pointer-events-none opacity-50')}>
              <input type="file" accept=".stl,.3mf" className="sr-only" disabled={busy !== null}
                aria-label={`${source ? 'Replace' : 'Upload'} the source model of ${c.description} (STL or 3MF project)`}
                onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadSource(f); }} />
              {busy === 'source' ? 'Uploading…' : source ? 'Replace' : 'Upload STL or 3MF'}
            </label>
          )}
          {isAdmin && source && (confirm === 'source' ? (
            <>
              <LinkButton tone="danger" disabled={busy !== null} onClick={() => void removeSource()}>Remove the source?</LinkButton>
              <LinkButton onClick={() => setConfirm(null)}>Keep</LinkButton>
            </>
          ) : (
            <LinkButton tone="danger" disabled={busy !== null} title={`Remove the source model of ${c.description}`} onClick={() => setConfirm('source')}>Remove</LinkButton>
          ))}
          <span className="ml-auto" title={source ? undefined : 'Upload an STL or 3MF project first'}>
            <Button size="sm" variant="outline" disabled={!source || busy !== null} onClick={onSlice}>Slice a plate</Button>
          </span>
        </div>
      )}
      <SliceRunsRow productId={productId} componentId={c.id} enabled={source !== null} canEdit={canEdit}
        refreshKey={`${String(runsKey)}:${sourceVersion}`} onDone={onChanged} />
      {rows.length > 0 && (
        // `relative`: the visually hidden caption and file inputs are absolute, and must scroll with the table.
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Plates of {c.description}</caption>
            <thead>
              <tr className="border-b text-left text-gray-500 dark:border-gray-800 dark:text-gray-400">
                {head.map(h => (
                  <th key={h} scope="col" className={cn('whitespace-nowrap py-1.5 pr-4 text-xs font-medium', NUMERIC.has(h) && 'text-right')}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const k = keyOf(r);
                const sliced = isSlicedRow(r);
                const printer = plateRowPrinter(r, c, printers);
                return (
                  <tr key={k} className="border-b last:border-0 dark:border-gray-800">
                    <td className={cn(cell, 'font-medium text-gray-800 dark:text-gray-200')}>
                      {r.name}
                      {sliced && <Badge variant="info" className="ml-1.5 px-1.5 py-0 text-[10px]">sliced</Badge>}
                    </td>
                    <td className={num}>{r.unitsPerPlate}</td>
                    {c.pendingFirstSlice === true && r.layoutId === null ? (
                      <td className={num} colSpan={2}><span className="font-sans text-gray-600 dark:text-gray-400">not sliced yet</span></td>
                    ) : (
                      <>
                        <td className={num}>{formatMinutes(r.plateMinutes)}</td>
                        <td className={num}>{formatGrams(r.plateGrams)}</td>
                      </>
                    )}
                    {showCosts && (
                      <>
                        <td className={num}>{money(r.costPerUnit)}</td>
                        <td className={num} title={r.priceSource === 'TIER' ? `Bulk price from ${r.tierMinQty} units` : undefined}>
                          {money(r.pricePerUnit)}
                        </td>
                        <td className={cn(num, r.marginPct !== null && r.marginPct < 0 && 'text-red-600 dark:text-red-400')}>
                          {r.marginPct === null ? '—' : `${formatPct(r.marginPct)}${r.marginPct < 0 ? ' below cost' : ''}`}
                        </td>
                      </>
                    )}
                    <td className="py-1.5 pr-4">
                      {printer
                        ? <span className="whitespace-nowrap">{printer}</span>
                        : r.slicedFor
                          ? <span className="text-amber-700 dark:text-amber-300">Sliced for {r.slicedFor}, no matching printer</span>
                          : <span className="text-gray-400">—</span>}
                    </td>
                    <td className="whitespace-nowrap py-1.5">
                      {r.file ? (
                        <span className="inline-flex items-center gap-2">
                          <a href={r.file.downloadUrl} download title={r.file.filename}
                            className="inline-flex items-center gap-1 rounded text-xs font-medium text-brand-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-brand-400">
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
                        <label className={cn('cursor-pointer rounded text-xs font-medium text-brand-600 hover:underline focus-within:ring-2 focus-within:ring-brand-500 dark:text-brand-400', busy !== null && 'pointer-events-none opacity-50')}>
                          <input type="file" accept=".gcode,.gco,.g" className="sr-only" disabled={busy !== null}
                            aria-label={`Upload a G-code for ${label(r)}`}
                            onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(r, f); }} />
                          {busy === k ? 'Uploading…' : 'No file, upload one'}
                        </label>
                      ) : (
                        <span className="text-gray-500 dark:text-gray-400">no file</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
