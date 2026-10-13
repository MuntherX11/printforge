'use client';

import { useMemo, useState } from 'react';
import { Download, Factory } from 'lucide-react';
import type { OrderPlanNeedDto, OrderPlateDto } from '@printforge/types';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { formatMinutes, plural } from '@/lib/product-format';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '../../products/[id]/ConfirmDialog';
import { LinkButton } from '../../products/[id]/options-ui';
import { PlateDialog, type PlateDialogTarget } from './PlateDialog';
import { PrintPlateRow } from './PrintPlateRow';
import { waysOfNeed } from './plate-draft';
import {
  coverage, coverageText, groupByPrinter, jobsPreview, needsSlicing, partSub, partTitle, summaryLine, warningSentences,
} from './print-plan-model';
import { planErrorText, planZipUrl, useOrderPrintPlan } from './useOrderPrintPlan';

interface Props {
  orderId: string;
  /** OPERATOR/ADMIN. */
  canEdit: boolean;
  /** Jobs were made: the order page reloads (status, the job list). */
  onJobsCreated: () => void;
}

type Confirm =
  | { kind: 'reset' }
  | { kind: 'jobs' }
  | { kind: 'move'; plate: OrderPlateDto; printerId: string | null };

const outlineLink = 'inline-flex min-h-[40px] items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors duration-150 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700';

/**
 * The order's print files (v2.19.0): "Prepare print files" proposes the
 * plates for every printer; each plate shows a top-down drawing, its parts
 * and its numbers, and can be moved, edited, sliced, downloaded or deleted.
 * Under the plates: what the order needs against what is on plates, then
 * Slice all, Download all and Create jobs. Short or extra units and plates
 * that came out too full are warnings in plain sentences, never a stop.
 * Shows nothing for an order with nothing to print.
 */
export function PrintFilesCard({ orderId, canEdit, onJobsCreated }: Props) {
  const { toast } = useToast();
  const pp = useOrderPrintPlan(orderId);
  const { plan } = pp;
  const [dialog, setDialog] = useState<PlateDialogTarget | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const groups = useMemo(() => (plan ? groupByPrinter(plan) : []), [plan]);
  const warnings = useMemo(() => (plan ? warningSentences(plan) : []), [plan]);
  const rows = useMemo(() => (plan ? coverage(plan) : []), [plan]);
  const preview = useMemo(() => (plan ? jobsPreview(plan) : { ready: [], leftOut: [] }), [plan]);

  if (!plan) {
    if (!pp.error) return null;
    return (
      <Card>
        <CardHeader><CardTitle>Print files</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">{pp.error}</p>
          <Button size="sm" variant="outline" onClick={() => void pp.refresh()}>Try again</Button>
        </CardContent>
      </Card>
    );
  }

  const editable = canEdit && plan.plannable;
  const hasPlates = plan.plates.length > 0;
  if (!hasPlates && (!editable || plan.needs.length === 0)) return null;

  const busy = pp.busy !== null;
  const toSlice = plan.plates.filter(needsSlicing).length;
  const unlocked = plan.plates.filter(p => !p.locked);

  /** Runs an action; its failure is the server's sentence in a toast. */
  async function run(action: () => Promise<unknown>, done: string | null, failed: string): Promise<boolean> {
    try {
      await action();
      if (done) toast('success', done);
      return true;
    } catch (err) {
      toast('error', planErrorText(err, failed));
      return false;
    }
  }

  function move(plate: OrderPlateDto, printerId: string | null) {
    if ((printerId ?? null) === (plate.printerId ?? null)) return;
    // A sliced file is for one printer: moving the plate drops it, so ask first.
    if (plate.hasFile && needsFileAgain(plate)) { setConfirm({ kind: 'move', plate, printerId }); return; }
    void run(() => pp.updatePlate(plate.id, { printerId }), `${plate.label} moved`, 'Couldn\'t move the plate');
  }

  async function createJobs() {
    try {
      const res = await pp.createJobs();
      setConfirm(null);
      toast('success', `Created ${plural(res.jobsCreated, 'production job')}`);
      for (const w of res.warnings ?? []) toast('warning', w.message);
      onJobsCreated();
    } catch (err) {
      setConfirm(null);
      toast('error', planErrorText(err, 'Couldn\'t create the jobs'));
    }
  }

  async function confirmed() {
    if (!confirm) return;
    if (confirm.kind === 'jobs') { await createJobs(); return; }
    if (confirm.kind === 'reset') await run(() => pp.suggest(), 'Plates suggested again', 'Couldn\'t suggest the plates');
    else await run(() => pp.updatePlate(confirm.plate.id, { printerId: confirm.printerId }), `${confirm.plate.label} moved`, 'Couldn\'t move the plate');
    setConfirm(null);
  }

  const addFor = (need: OrderPlanNeedDto | null) => setDialog({ need });

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle>Print files</CardTitle>
        {editable && hasPlates && (
          <LinkButton disabled={busy} title="Replace the plates with a fresh suggestion" onClick={() => setConfirm({ kind: 'reset' })}>
            Reset to suggestion
          </LinkButton>
        )}
      </CardHeader>

      {!hasPlates ? (
        <CardContent className="space-y-3">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Nothing is prepared yet. Preparing suggests the plates for each printer; you can change any of it before slicing.
          </p>
          <Button disabled={busy} onClick={() => void run(() => pp.suggest(), null, 'Couldn\'t prepare the print files')}>
            {pp.busy === 'suggest' ? 'Preparing…' : 'Prepare print files'}
          </Button>
        </CardContent>
      ) : (
        <CardContent className="space-y-5 p-0 pb-6">
          <div className="space-y-3 px-4 sm:px-6">
            <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{summaryLine(plan, groups)}</p>
            {warnings.length > 0 && (
              <ul className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
                {warnings.map(w => <li key={w}>{w}</li>)}
              </ul>
            )}
          </div>

          {groups.map(g => (
            <section key={g.key} aria-label={`Plates on ${g.name}`}>
              <h3 className="border-y border-gray-200 bg-gray-50 px-4 py-2 text-sm font-semibold text-gray-700 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-200 sm:px-6">
                {g.name}
                <span className="font-normal text-gray-500 dark:text-gray-400"> · {plural(g.plateCount, 'plate')}{g.minutes > 0 ? ` · ${formatMinutes(g.minutes)}` : ''}</span>
              </h3>
              <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                {g.plates.map(p => (
                  <PrintPlateRow
                    key={p.id}
                    plate={p}
                    plan={plan}
                    editable={editable}
                    busy={busy}
                    working={pp.busy === p.id}
                    onMove={printerId => move(p, printerId)}
                    onEdit={() => setDialog({ plate: p })}
                    onSlice={() => void run(() => pp.slicePlate(p.id), `${p.label} queued for slicing`, 'Couldn\'t queue the slice')}
                    onDelete={() => void run(() => pp.deletePlate(p.id), `${p.label} deleted`, 'Couldn\'t delete the plate')}
                  />
                ))}
              </ul>
            </section>
          ))}

          {editable && (
            <div className="px-4 sm:px-6">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => addFor(null)}>Add plate</Button>
            </div>
          )}

          {rows.length > 0 && (
            <div className="px-4 sm:px-6">
              <h3 className="mb-1 text-sm font-semibold text-gray-700 dark:text-gray-200">What the order needs</h3>
              <div className="relative overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">Parts the order needs and how many are on plates</caption>
                  <thead>
                    <tr className="border-b text-left text-xs font-medium text-gray-500 dark:border-gray-800 dark:text-gray-400">
                      <th scope="col" className="py-1.5 pr-3 font-medium">Part</th>
                      <th scope="col" className="py-1.5 pr-3 text-right font-medium">Needed</th>
                      <th scope="col" className="whitespace-nowrap py-1.5 pr-3 text-right font-medium">On plates</th>
                      <th scope="col" className="py-1.5 text-right font-medium"><span className="sr-only">Short or extra</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(c => {
                      const state = coverageText(c);
                      return (
                        <tr key={c.need.rowKey} className="border-b align-top last:border-0 dark:border-gray-800">
                          <td className="py-2 pr-3">
                            <p className="break-words font-medium text-gray-800 dark:text-gray-200">{partTitle(c.need)}</p>
                            {partSub(c.need) && <p className="break-words text-xs text-gray-500 dark:text-gray-400">{partSub(c.need)}</p>}
                            {c.need.blockedReason && <p className="break-words text-xs text-amber-700 dark:text-amber-300">{c.need.blockedReason}</p>}
                            {editable && waysOfNeed(c.need).length > 0 && (
                              <button type="button" disabled={busy} onClick={() => addFor(c.need)}
                                className="-ml-1.5 rounded px-1.5 py-1 text-xs font-medium text-brand-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-40 dark:text-brand-400">
                                Add a plate for it
                              </button>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-right font-mono tabular-nums">{c.need.toProduce}</td>
                          <td className="py-2 pr-3 text-right font-mono tabular-nums">{c.planned}</td>
                          <td className={cn('whitespace-nowrap py-2 text-right text-xs',
                            state.tone === 'warn' ? 'font-medium text-amber-700 dark:text-amber-300'
                              : state.tone === 'ok' ? 'text-green-700 dark:text-green-400' : 'text-gray-400')}>
                            {state.text}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 px-4 sm:px-6">
            {pp.zipAvailable && (
              <a href={planZipUrl(orderId)} download className={outlineLink}>
                <Download className="mr-2 h-4 w-4" aria-hidden="true" /> Download all
              </a>
            )}
            {editable && toSlice > 0 && (
              <Button variant="outline" disabled={busy} onClick={() => void run(() => pp.sliceAll(), `${plural(toSlice, 'plate')} queued for slicing`, 'Couldn\'t queue the slicing')}>
                {pp.busy === 'slice-all' ? 'Queueing…' : `Slice all (${toSlice})`}
              </Button>
            )}
            {editable && (
              <span title={preview.ready.length ? undefined : 'Slice a plate first'}>
                <Button disabled={busy || preview.ready.length === 0}
                  onClick={() => (preview.leftOut.length ? setConfirm({ kind: 'jobs' }) : void createJobs())}>
                  <Factory className="mr-2 h-4 w-4" aria-hidden="true" />
                  {pp.busy === 'jobs' ? 'Creating…' : 'Create jobs'}
                </Button>
              </span>
            )}
          </div>
          {editable && preview.ready.length === 0 && unlocked.length > 0 && (
            <p className="px-4 text-right text-xs text-gray-500 dark:text-gray-400 sm:px-6">Jobs can be created once a plate is sliced.</p>
          )}
        </CardContent>
      )}

      <PlateDialog
        target={dialog}
        plan={plan}
        actions={pp}
        onClose={() => setDialog(null)}
        onSaved={message => { setDialog(null); toast('success', message); }}
      />

      <ConfirmDialog
        open={confirm?.kind === 'reset'}
        title="Reset to suggestion"
        confirmLabel="Replace the plates"
        destructive
        busy={busy}
        message={<ResetMessage unlocked={unlocked} lockedCount={plan.plates.length - unlocked.length} />}
        onConfirm={() => void confirmed()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm?.kind === 'move'}
        title="Move the plate"
        confirmLabel="Move it"
        busy={busy}
        message={confirm?.kind === 'move'
          ? `Moving ${confirm.plate.label} removes its sliced file — it has to be sliced again for the other printer.`
          : ''}
        onConfirm={() => void confirmed()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm?.kind === 'jobs'}
        title="Create jobs"
        confirmLabel={`Create jobs for ${plural(preview.ready.length, 'plate')}`}
        busy={busy}
        message={(
          <div className="max-h-[50vh] space-y-2 overflow-y-auto">
            <p>Jobs are made for {plural(preview.ready.length, 'sliced plate')}. This is left out:</p>
            <ul className="list-disc space-y-1 pl-5">
              {preview.leftOut.map(s => <li key={s}>{s}</li>)}
            </ul>
            <p>You can prepare the rest later and create its jobs then.</p>
          </div>
        )}
        onConfirm={() => void confirmed()}
        onClose={() => setConfirm(null)}
      />
    </Card>
  );
}

/** A plate whose file was sliced here (an existing file stays whichever printer is chosen). */
function needsFileAgain(p: OrderPlateDto): boolean {
  return p.kind !== 'LAYOUT';
}

function ResetMessage({ unlocked, lockedCount }: { unlocked: OrderPlateDto[]; lockedCount: number }) {
  const sliced = unlocked.filter(p => p.hasFile && needsFileAgain(p)).length;
  return (
    <div className="space-y-2">
      <p>
        {plural(unlocked.length, 'plate')} will be replaced by a fresh suggestion, and every change you made to {unlocked.length === 1 ? 'it' : 'them'} is lost.
        {sliced > 0 ? ` ${plural(sliced, 'sliced file')} will be removed and ${sliced === 1 ? 'has' : 'have'} to be sliced again.` : ''}
      </p>
      {lockedCount > 0 && <p>{plural(lockedCount, 'plate')} with jobs {lockedCount === 1 ? 'stays' : 'stay'} as {lockedCount === 1 ? 'it is' : 'they are'}.</p>}
    </div>
  );
}
