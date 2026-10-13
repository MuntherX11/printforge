'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { Download } from 'lucide-react';
import { OrderPlateKind, OrderPlateStatus, type OrderPlateDto, type OrderPrintPlanDto } from '@printforge/types';
import { Badge } from '@/components/ui/badge';
import { Swatch } from '@/components/ui/swatch';
import { formatGrams, formatMinutes } from '@/lib/product-format';
import { LinkButton } from '../../products/[id]/options-ui';
import { runFailure } from '../../products/[id]/slice-ui';
import { PlatePreview } from './PlatePreview';
import { printerOptions, wayOfKind } from './plate-draft';
import { editLock, needsSlicing, plateChip, plateKindNote, plateLegend, printerLock } from './print-plan-model';
import { plateFileUrl } from './useOrderPrintPlan';

interface Props {
  plate: OrderPlateDto;
  plan: OrderPrintPlanDto;
  /** OPERATOR/ADMIN on an order that can still be planned. */
  editable: boolean;
  /** Any action of the card is running. */
  busy: boolean;
  /** This plate's own action is running. */
  working: boolean;
  onMove: (printerId: string | null) => void;
  onEdit: () => void;
  onSlice: () => void;
  onDelete: () => void;
}

/** The slicer's raw output of a failed plate, behind a toggle (as on the product page). */
function FailureDetail({ detail }: { detail: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button type="button" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(o => !o)}
        className="rounded px-1 text-xs font-medium text-gray-600 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-gray-400">
        Details
      </button>
      {open && (
        <pre id={id} className="mt-1 max-h-48 w-full overflow-auto whitespace-pre-wrap break-words rounded bg-gray-50 p-2 font-mono text-[11px] leading-snug text-gray-700 dark:bg-gray-800 dark:text-gray-300">
          {detail}
        </pre>
      )}
    </>
  );
}

/**
 * One plate of the order: its name and status, the drawing with its parts,
 * the filament, time and weight (an estimate until it is sliced), the reason
 * when slicing failed, and for editors the printer it prints on with Slice,
 * Edit, Download and Delete. A plate with jobs, and the printer of a
 * multi-colour project, cannot be changed; the reason is written out.
 */
export function PrintPlateRow({ plate: p, plan, editable, busy, working, onMove, onEdit, onSlice, onDelete }: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selectId = useId();
  const chip = plateChip(p);
  const legend = plateLegend(p, plan.needs.map(n => n.rowKey));
  const note = plateKindNote(p, plan.needs);
  const locked = editLock(p);
  const fixedPrinter = printerLock(p, plan.needs);
  const failure = p.status === OrderPlateStatus.FAILED ? runFailure(p) : null;
  const sliced = p.minutes !== null || p.grams !== null;
  const times = Math.max(1, p.plateCount || 1);
  const options = printerOptions(plan, wayOfKind(p.kind), { id: p.printerId, name: p.printerName });

  return (
    <li className="space-y-3 px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{p.label}</h4>
        <Badge variant={chip.variant}>{working && p.status !== OrderPlateStatus.RUNNING ? 'Working…' : chip.text}</Badge>
        {p.locked && <Badge>Jobs made</Badge>}
      </div>

      <PlatePreview preview={p.preview} legend={legend} label={p.label}>
        <div className="space-y-1 text-sm text-gray-600 dark:text-gray-400">
          {p.filaments.length > 0 && (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {p.filaments.map(f => (
                <span key={`${f.slot}-${f.materialId}`} className="inline-flex items-center gap-1.5">
                  <Swatch hex={f.colorHex} name={f.name} title={f.name} decorative />
                  {f.name}
                </span>
              ))}
            </p>
          )}
          <p className="tabular-nums">
            {formatMinutes(p.minutes ?? p.estMinutes)} · {formatGrams(p.grams ?? p.estGrams)}
            {times > 1 ? ` each, printed ${times} times` : ''}
            {!sliced && p.kind !== OrderPlateKind.LAYOUT ? ' (estimate)' : ''}
          </p>
          {note && <p className="text-xs">{note}</p>}
        </div>

        {failure && (
          <div className="text-sm">
            <span className="break-words text-red-600 dark:text-red-400">{failure.text}</span>{' '}
            {failure.detail && <FailureDetail detail={failure.detail} />}
          </div>
        )}

        {editable && (
          <div className="space-y-1">
            <label htmlFor={selectId} className="block text-xs font-medium text-gray-500 dark:text-gray-400">Printer</label>
            <select
              id={selectId}
              value={p.printerId ?? ''}
              disabled={fixedPrinter !== null || busy}
              aria-describedby={fixedPrinter ? `${selectId}-why` : undefined}
              onChange={e => onMove(e.target.value || null)}
              className="h-10 w-full max-w-xs rounded-md border border-gray-300 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            >
              {options.map(o => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
            </select>
            {fixedPrinter && <p id={`${selectId}-why`} className="text-xs text-gray-500 dark:text-gray-400">{fixedPrinter}</p>}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {p.hasFile && (
            <a href={plateFileUrl(p.id)} download title={p.gcodeFilename ?? undefined}
              className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs font-medium text-brand-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-brand-400">
              <Download className="h-3.5 w-3.5" aria-hidden="true" /> Download
            </a>
          )}
          {editable && !locked && (
            <>
              {needsSlicing(p) && (
                <LinkButton disabled={busy} title={`Slice ${p.label}`} onClick={onSlice}>
                  {p.status === OrderPlateStatus.FAILED ? 'Try again' : 'Slice'}
                </LinkButton>
              )}
              <LinkButton disabled={busy} title={`Edit ${p.label}`} onClick={onEdit}>Edit plate</LinkButton>
              {confirmDelete ? (
                <>
                  <LinkButton tone="danger" disabled={busy} onClick={() => { setConfirmDelete(false); onDelete(); }}>Delete this plate?</LinkButton>
                  <LinkButton onClick={() => setConfirmDelete(false)}>Keep</LinkButton>
                </>
              ) : (
                <LinkButton tone="danger" disabled={busy} title={`Delete ${p.label}`} onClick={() => setConfirmDelete(true)}>Delete</LinkButton>
              )}
            </>
          )}
          {/* Whether a plate has live jobs is the API's `locked`, never the length of `jobIds`. */}
          {p.locked && p.jobIds[0] && (
            <Link href={`/production/${p.jobIds[0]}`} className="rounded px-1.5 py-1 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400">
              {p.jobIds.length > 1 ? 'Open its first job' : 'Open its job'}
            </Link>
          )}
        </div>
      </PlatePreview>
    </li>
  );
}
