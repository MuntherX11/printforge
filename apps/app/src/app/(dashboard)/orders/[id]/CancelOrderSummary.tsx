'use client';

import type { JobStatus, OrderCancelResult, OrderStatus, OrderStockAllocation } from '@/lib/types/api';
import type { OrderDetail } from './useOrder';

type OrderJobs = NonNullable<OrderDetail['productionJobs']>;

const plural = (n: number) => (n === 1 ? '' : 's');
const isStarted = (s: JobStatus) => s === 'IN_PROGRESS' || s === 'PAUSED';

/** `Box 2, Lid 1 (PLA Red)`: units per component, the colour once per group. */
export function stockText(rows: Array<{ componentDescription: string; colourLabel: string; units: number }>): string {
  const byColour = new Map<string, string[]>();
  for (const r of rows) byColour.set(r.colourLabel, [...(byColour.get(r.colourLabel) ?? []), `${r.componentDescription} ${r.units}`]);
  return [...byColour.entries()].map(([colour, parts]) => `${parts.join(', ')} (${colour})`).join('; ');
}

/**
 * The cancel confirm's message (S9): the printed stock returned, the queued
 * jobs that will be cancelled and the started ones that will not. Built from
 * S4's data; the result toast reports what the server actually did. Each job
 * list scrolls inside a bounded height: Dialog itself doesn't scroll, so a long
 * list (a 30-unit quote's placeholders) would push its buttons off a phone.
 */
export function CancelOrderSummary({ stock, jobs }: { stock: OrderStockAllocation[]; jobs: OrderJobs }) {
  const queued = jobs.filter(j => j.status === 'QUEUED');
  const started = jobs.filter(j => isStarted(j.status));
  const m = started.length;
  return (
    <div className="space-y-2">
      <p>{stock.length ? `Returns to printed stock: ${stockText(stock)}` : 'Nothing to return to printed stock'}</p>
      {queued.length > 0 && (
        <>
          <p className="font-medium text-amber-700 dark:text-amber-300">Cancel {queued.length} queued job{plural(queued.length)}:</p>
          <ul className="max-h-40 overflow-y-auto list-disc pl-5 text-gray-600 dark:text-gray-300">
            {queued.map(j => <li key={j.id} className="break-words">{j.name}{j.printer ? ` · ${j.printer.name}` : ''}</li>)}
          </ul>
        </>
      )}
      {m > 0 && (
        <>
          <p className="font-medium text-red-600 dark:text-red-400">
            Already started — not cancelled. Stop {m === 1 ? 'it' : 'them'} on the printer, then open {m === 1 ? 'the job' : 'each job'} and use Mark Failed or Cancel Job:
          </p>
          <ul className="max-h-40 overflow-y-auto list-disc pl-5 text-gray-600 dark:text-gray-300">
            {started.map(j => (
              <li key={j.id} className="break-words">
                {j.name} · {j.status === 'PAUSED' ? 'paused' : 'printing'}{j.printer ? ` on ${j.printer.name}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** A still-running job of a cancelled order, in the order page's Production Jobs card. */
export function CancelledJobNote({ orderStatus, jobStatus }: { orderStatus: OrderStatus; jobStatus: JobStatus }) {
  if (orderStatus !== 'CANCELLED' || !isStarted(jobStatus)) return null;
  return (
    <p className="text-xs text-amber-700 dark:text-amber-300">
      Order cancelled — still {jobStatus === 'PAUSED' ? 'paused' : 'printing'}. Stop it on the printer, then Mark Failed or Cancel Job
    </p>
  );
}

/** The S9 result toast: success, or a warning naming the jobs that are still running. */
export function cancelToast(res: Partial<OrderCancelResult>): { type: 'success' | 'warning'; message: string } {
  const stock = res.stockReleased ?? [];
  const n = res.jobsCancelled?.length ?? 0;
  const still = res.jobsStillRunning ?? [];
  const parts = [n ? `${n} queued job${plural(n)} cancelled` : '', stock.length ? `returned to printed stock: ${stockText(stock)}` : '']
    .filter(Boolean)
    .join(' · ');
  const base = parts ? `Order cancelled — ${parts}` : 'Order cancelled';
  if (!still.length) return { type: 'success', message: base };
  const list = still.map(j => j.name + (j.printerName ? ` (${j.printerName})` : '')).join(', ');
  const them = still.length === 1 ? 'it' : 'them';
  return { type: 'warning', message: `${base}. Still running, not cancelled: ${list} — stop ${them} on the printer, then Mark Failed or Cancel Job` };
}
