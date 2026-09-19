'use client';

/**
 * Order "Plan Production" dialog (spec §5.3, J4/J5 §4.4). One row per order
 * line × component (`rowKey`), with the pair and colour labels, how many to
 * take from printed stock, how many to print and on which plates, what to do
 * with extras, the printer and, per filament, an optional spool override.
 * A stock-only submit is valid. The body carries the J4 `planVersion`; a 409
 * shows the server message and reloads the plan.
 */
import { useEffect, useMemo, useState } from 'react';
import { Factory } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { PlatePlanEditor, planProblem, type PlanPlate } from '@/components/production/PlatePlanEditor';
import { ApiError, api } from '@/lib/api';
import { formatGrams, plural, policyLabel } from '@/lib/product-format';
import type { ApiSpool, PlanRow, PlanSubmitResult, PlanSubmitRow, ProductionPlan, SurplusPolicy } from '@/lib/types/api';

interface RowEdit {
  fromStock?: number;
  toProduce?: number;
  plates?: PlanPlate[];
  surplusPolicy?: SurplusPolicy;
  printerId?: string | null;
  spools?: Record<string, string>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  orderId: string;
  plan: ProductionPlan | null;
  printers: Array<{ id: string; name: string }>;
  onCreated: (result: PlanSubmitResult) => void;
  /** Reload J4 (after a 409). */
  onReload: () => void;
}

const POLICIES: SurplusPolicy[] = ['KEEP_FOR_STOCK', 'CANCEL_ON_PRINTER'];
const cell = 'h-7 text-sm border rounded bg-white dark:bg-gray-800 dark:border-gray-600';

function values(row: PlanRow, e: RowEdit | undefined) {
  const fromStock = e?.fromStock ?? row.fromStock;
  const toProduce = e?.toProduce ?? (e?.fromStock !== undefined ? Math.max(0, row.remaining - fromStock) : row.toProduce);
  return { fromStock, toProduce };
}

function rowProblem(row: PlanRow, e: RowEdit | undefined): string | null {
  const { fromStock, toProduce } = values(row, e);
  if (fromStock > Math.min(row.onHand, row.remaining)) return `At most ${Math.min(row.onHand, row.remaining)} from stock`;
  if (fromStock + toProduce > row.remaining) return `Only ${row.remaining} left to plan`;
  if (toProduce > 0 && e?.plates) return planProblem(e.plates, row.layouts, toProduce);
  return null;
}

export function PlanProductionDialog({ open, onClose, orderId, plan, printers, onCreated, onReload }: Props) {
  const { toast } = useToast();
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const [spools, setSpools] = useState<Record<string, ApiSpool[]>>({});
  const [creating, setCreating] = useState(false);
  const rows = plan?.rows ?? [];

  useEffect(() => {
    setEdits({});
    if (!open || !plan) return;
    const ids = [...new Set(plan.rows.flatMap(r => r.filament.map(f => f.materialId)))];
    Promise.all(ids.map(id => api.get<ApiSpool[]>(`/spools?materialId=${encodeURIComponent(id)}`).then(list => [id, list] as const).catch(() => [id, []] as const)))
      .then(entries => setSpools(Object.fromEntries(entries.map(([id, list]) => [id, list.filter(s => s.isActive && s.currentWeight > 0)]))));
  }, [open, plan?.planVersion]);

  const edit = (rowKey: string, next: RowEdit) => setEdits(prev => ({ ...prev, [rowKey]: { ...prev[rowKey], ...next } }));

  const totals = useMemo(() => {
    let fromStock = 0;
    let jobs = 0;
    let problems = 0;
    for (const r of rows) {
      const v = values(r, edits[r.rowKey]);
      fromStock += v.fromStock;
      if (v.toProduce > 0) jobs += 1;
      if (rowProblem(r, edits[r.rowKey])) problems += 1;
    }
    return { fromStock, jobs, problems };
  }, [rows, edits]);

  const label = totals.fromStock > 0
    ? `Take ${totals.fromStock} from stock · create ${plural(totals.jobs, 'job')}`
    : `Create ${plural(totals.jobs, 'job')}`;

  async function submit() {
    if (!plan) return;
    setCreating(true);
    try {
      const body: { planVersion: string; rows: PlanSubmitRow[] } = {
        planVersion: plan.planVersion,
        rows: rows.map(r => {
          const e = edits[r.rowKey];
          const v = values(r, e);
          const spoolList = Object.entries(e?.spools ?? {}).filter(([, id]) => id).map(([materialId, spoolId]) => ({ materialId, spoolId }));
          return {
            rowKey: r.rowKey,
            fromStock: v.fromStock,
            toProduce: v.toProduce,
            ...(e?.plates && v.toProduce > 0 ? { plates: e.plates } : {}),
            ...(e?.surplusPolicy ? { surplusPolicy: e.surplusPolicy } : {}),
            ...(e && 'printerId' in e ? { printerId: e.printerId ?? null } : {}),
            ...(spoolList.length ? { spools: spoolList } : {}),
          };
        }),
      };
      const res = await api.post<PlanSubmitResult>(`/jobs/plan/${orderId}`, body);
      onCreated(res);
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Could not create the plan');
      if (err instanceof ApiError && err.status === 409) onReload();
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onClose={() => (creating ? undefined : onClose())} title="Production Plan Preview" className="max-w-6xl">
      <div className="space-y-4 max-h-[70vh] overflow-y-auto">
        {(plan?.warnings ?? []).length > 0 && (
          <ul className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
            {plan!.warnings.map((w, i) => <li key={`${w.code}-${i}`}>{w.message}</li>)}
          </ul>
        )}
        {rows.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">No components need production — all items are in stock.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Component</TableHead>
                  <TableHead>Materials</TableHead>
                  <TableHead>Need</TableHead>
                  <TableHead>On Hand</TableHead>
                  <TableHead>From stock</TableHead>
                  <TableHead>To Produce</TableHead>
                  <TableHead>Plates</TableHead>
                  <TableHead>Extras</TableHead>
                  <TableHead>Printer</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(row => {
                  const e = edits[row.rowKey];
                  const { fromStock, toProduce } = values(row, e);
                  const done = row.remaining === 0;
                  const problem = done ? null : rowProblem(row, e);
                  const scale = row.toProduce > 0 ? toProduce / row.toProduce : 0;
                  return (
                    <TableRow key={row.rowKey} className={done || (toProduce === 0 && fromStock === 0) ? 'opacity-50' : ''}>
                      <TableCell className="align-top">
                        <p className="text-sm font-medium">{row.productName}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {row.optionLabel ? `${row.optionLabel} ` : ''}{row.componentDescription} · {row.colourLabel}
                        </p>
                        {row.isMultiColor && <Badge className="bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300 text-xs mt-1">Multicolor</Badge>}
                        {done && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Already planned</p>}
                        {row.warnings.map((w, i) => (
                          <p key={`${w.code}-${i}`} className="text-xs text-amber-600 dark:text-amber-400 mt-1 max-w-xs">{w.message}</p>
                        ))}
                        {problem && <p role="alert" className="text-xs text-red-600 dark:text-red-400 mt-1">{problem}</p>}
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="space-y-1">
                          {row.filament.map(f => {
                            const list = spools[f.materialId] ?? [];
                            return (
                              <div key={f.materialId} className="flex flex-wrap items-center gap-2 text-xs">
                                <Badge className="bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200 text-xs shrink-0">{f.label}</Badge>
                                <span className="font-mono text-gray-500">{formatGrams(scale === 1 ? f.grams : f.grams * scale)}</span>
                                {done || toProduce === 0 ? null : (
                                  <select
                                    aria-label={`Spool for ${f.label}`}
                                    className={`${cell} text-xs max-w-[11rem]`}
                                    value={e?.spools?.[f.materialId] ?? ''}
                                    onChange={ev => edit(row.rowKey, { spools: { ...e?.spools, [f.materialId]: ev.target.value } })}
                                  >
                                    <option value="">
                                      {f.suggestedSpool
                                        ? `→ ${f.suggestedSpool.pfid || f.suggestedSpool.id.slice(0, 6)} (${Math.round(f.suggestedSpool.currentWeight)} g)`
                                        : 'No spool'}
                                    </option>
                                    {list.filter(s => s.id !== f.suggestedSpool?.id).map(s => (
                                      <option key={s.id} value={s.id}>
                                        {s.printforgeId || s.id.slice(0, 6)} ({Math.round(s.currentWeight)} g){s.location?.name ? ` · ${s.location.name}` : ''}
                                      </option>
                                    ))}
                                  </select>
                                )}
                                {!e?.spools?.[f.materialId] && f.suggestedSpool && !f.suggestedSpool.hasEnough && !done && toProduce > 0 && (
                                  <span className="text-amber-600 dark:text-amber-400">short</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono align-top">{row.needed}</TableCell>
                      <TableCell className="font-mono align-top">{row.onHand}</TableCell>
                      <TableCell className="align-top">
                        <input
                          type="number"
                          min="0"
                          max={Math.min(row.onHand, row.remaining)}
                          aria-label={`${row.componentDescription}: from stock`}
                          disabled={done || row.onHand === 0}
                          className={`${cell} w-16 text-center font-mono`}
                          value={fromStock}
                          onChange={ev => edit(row.rowKey, { fromStock: Math.max(0, parseInt(ev.target.value, 10) || 0) })}
                        />
                      </TableCell>
                      <TableCell className="align-top">
                        <input
                          type="number"
                          min="0"
                          aria-label={`${row.componentDescription}: to produce`}
                          disabled={done}
                          className={`${cell} w-16 text-center font-mono`}
                          value={toProduce}
                          onChange={ev => edit(row.rowKey, { toProduce: Math.max(0, parseInt(ev.target.value, 10) || 0), plates: undefined })}
                        />
                      </TableCell>
                      <TableCell className="align-top min-w-[15rem]">
                        {done || toProduce === 0 ? (
                          <span className="text-xs text-gray-400">—</span>
                        ) : e?.plates || toProduce === row.toProduce ? (
                          <PlatePlanEditor
                            compact
                            label={row.componentDescription}
                            unitsRequired={toProduce}
                            layouts={row.layouts}
                            plates={e?.plates ?? row.suggestedPlates.map(p => ({ layoutId: p.layoutId, plateCount: p.plateCount }))}
                            onChange={plates => edit(row.rowKey, { plates })}
                          />
                        ) : (
                          <button type="button" className="text-left text-xs text-brand-600 hover:underline dark:text-brand-400"
                            onClick={() => edit(row.rowKey, { plates: row.suggestedPlates.map(p => ({ layoutId: p.layoutId, plateCount: p.plateCount })) })}>
                            Suggested for {toProduce} on save · choose plates
                          </button>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        <select
                          aria-label={`${row.componentDescription}: extras`}
                          disabled={done}
                          className={`${cell} text-xs px-1 max-w-[10rem]`}
                          value={e?.surplusPolicy ?? row.surplusPolicy}
                          onChange={ev => edit(row.rowKey, { surplusPolicy: ev.target.value as SurplusPolicy })}
                        >
                          {POLICIES.map(p => <option key={p} value={p}>{policyLabel(p)}</option>)}
                        </select>
                      </TableCell>
                      <TableCell className="align-top">
                        <select
                          aria-label={`${row.componentDescription}: printer`}
                          disabled={done}
                          className={`${cell} text-xs px-1 max-w-[120px]`}
                          value={(e && 'printerId' in e ? e.printerId : row.printerId) ?? ''}
                          onChange={ev => edit(row.rowKey, { printerId: ev.target.value || null })}
                        >
                          <option value="">None</option>
                          {printers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <div className="flex gap-3 justify-end pt-2 border-t dark:border-gray-700">
          <Button variant="outline" onClick={onClose} disabled={creating}>Cancel</Button>
          <Button onClick={submit} disabled={creating || (totals.fromStock === 0 && totals.jobs === 0) || totals.problems > 0}>
            <Factory className="h-4 w-4 mr-2" />
            {creating ? 'Creating...' : label}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
