'use client';

import { useEffect, useId, useState } from 'react';
import { MAX_UNITS_PER_PLATE, type OrderPlanNeedDto, type OrderPlateDto, type OrderPrintPlanDto } from '@printforge/types';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { LinkButton } from '../../products/[id]/options-ui';
import {
  MAX_PLATE_COUNT, WAY_HINT, WAY_LABEL, addableNeeds, clampInt, createDtoOf, draftNotes, draftOfPlate, draftProblem,
  leftToPlan, needsForWay, newDraft, printerOptions, sharedFilaments, updateDtoOf, waysOfNeed, waysOfPlan, withLayout,
  type PlateDraft, type PlateWay,
} from './plate-draft';
import { partSub, partTitle } from './print-plan-model';
import { planErrorText, type OrderPrintPlan } from './useOrderPrintPlan';

/** What the dialog is open for: a new plate (for one part when given), or an existing one. */
export type PlateDialogTarget = { plate: OrderPlateDto } | { need: OrderPlanNeedDto | null };

interface Props {
  target: PlateDialogTarget | null;
  plan: OrderPrintPlanDto;
  actions: Pick<OrderPrintPlan, 'createPlate' | 'updatePlate'>;
  onClose: () => void;
  onSaved: (message: string) => void;
}

const field = 'h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100';
const labelCls = 'block text-sm font-medium text-gray-700 dark:text-gray-300';
const stepBtn = 'h-10 w-10 flex-shrink-0 border border-gray-300 bg-white text-lg leading-none text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-40 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700';

/** A whole number with − and + buttons big enough for a thumb. */
function Stepper({ value, min, max, label, disabled, onChange }: {
  value: number; min: number; max: number; label: string; disabled?: boolean; onChange: (n: number) => void;
}) {
  return (
    <span className="inline-flex flex-shrink-0 items-center">
      <button type="button" className={`${stepBtn} rounded-l-md`} aria-label={`One fewer: ${label}`} disabled={disabled || value <= min} onClick={() => onChange(clampInt(value - 1, min, max))}>−</button>
      <input
        type="number" inputMode="numeric" min={min} max={max} step={1} aria-label={label} disabled={disabled}
        value={value}
        onChange={e => onChange(clampInt(parseInt(e.target.value, 10), min, max))}
        className="h-10 w-14 border-y border-gray-300 bg-white text-center font-mono text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
      />
      <button type="button" className={`${stepBtn} rounded-r-md`} aria-label={`One more: ${label}`} disabled={disabled || value >= max} onClick={() => onChange(clampInt(value + 1, min, max))}>+</button>
    </span>
  );
}

/**
 * Add a plate or change one. A new plate first asks how it prints — parts
 * sharing a plate, one part alone with its own settings, or a file the part
 * already has — then which parts and how many. Printing more or fewer than
 * the order needs is said in a note and never stops the save.
 */
export function PlateDialog({ target, plan, actions, onClose, onSaved }: Props) {
  const id = useId();
  const [draft, setDraft] = useState<PlateDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plate = target && 'plate' in target ? target.plate : null;
  const forNeed = target && 'need' in target ? target.need : null;
  const ways = plate ? [] : forNeed ? waysOfNeed(forNeed) : waysOfPlan(plan.needs);

  // Reset when the dialog opens for something else; a background reload keeps what was chosen.
  const openKey = !target ? null : plate ? `plate:${plate.id}` : `need:${forNeed?.rowKey ?? ''}`;
  useEffect(() => {
    setError(null);
    setSaving(false);
    if (!target) { setDraft(null); return; }
    if (plate) { setDraft(draftOfPlate(plate, plan.needs)); return; }
    const first = (forNeed ? waysOfNeed(forNeed) : waysOfPlan(plan.needs))[0];
    setDraft(first ? newDraft(plan, first, forNeed) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);

  if (!target) return null;
  const title = plate ? `Edit ${plate.label}` : forNeed ? `Add a plate — ${partTitle(forNeed)}` : 'Add a plate';

  if (!draft) {
    return (
      <Dialog open onClose={onClose} title={title} className="max-w-md">
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {forNeed?.blockedReason ?? 'Nothing in this order can be put on a plate yet.'}
        </p>
        <div className="mt-4 flex justify-end"><Button variant="outline" onClick={onClose}>Close</Button></div>
      </Dialog>
    );
  }

  const needOf = (rowKey: string) => plan.needs.find(n => n.rowKey === rowKey) ?? null;
  const excludeId = plate?.id ?? null;
  const d = draft;
  const single = needOf(d.items[0]?.rowKey ?? '');
  const layout = d.way === 'file' ? single?.layouts[d.layoutIndex] ?? null : null;
  const problem = draftProblem(d, plate !== null);
  const notes = draftNotes(d, plan, excludeId);
  const update = plate ? updateDtoOf(d, plate) : null;
  const addable = addableNeeds(d, plan.needs);
  const filaments = sharedFilaments(plan.needs);
  const printers = printerOptions(plan, d.way, { id: d.printerId, name: plate?.printerId === d.printerId ? plate?.printerName ?? null : null });
  const dropsFile = !!plate && plate.hasFile && d.way !== 'file';
  const lockedPrinterName = plan.printers.find(p => p.id === (plate?.printerId ?? single?.lockedPrinterId))?.name ?? plate?.printerName ?? null;

  const setItems = (items: PlateDraft['items']) => setDraft({ ...d, items });
  const setUnits = (rowKey: string, units: number) => setItems(d.items.map(it => (it.rowKey === rowKey ? { ...it, units } : it)));

  function chooseWay(way: PlateWay) {
    setError(null);
    setDraft(newDraft(plan, way, forNeed));
  }

  /** Alone / existing file: another part restarts the draft for it. */
  function choosePart(rowKey: string) {
    setDraft(newDraft(plan, d.way, needOf(rowKey)));
  }

  function chooseFilament(materialId: string) {
    const first = needsForWay(plan.needs, 'shared').find(n => n.materialId === materialId) ?? null;
    const next = newDraft(plan, 'shared', null);
    const rows = needsForWay(plan.needs, 'shared').filter(n => n.materialId === materialId && leftToPlan(plan, n.rowKey, null) > 0);
    const list = rows.length ? rows : first ? [first] : [];
    setDraft({ ...next, printerId: d.printerId ?? next.printerId, materialId, items: list.map(n => ({ rowKey: n.rowKey, units: clampInt(leftToPlan(plan, n.rowKey, null), 1, MAX_UNITS_PER_PLATE) })) });
  }

  function addPart(rowKey: string) {
    if (!rowKey) return;
    setItems([...d.items, { rowKey, units: clampInt(leftToPlan(plan, rowKey, excludeId), 1, MAX_UNITS_PER_PLATE) }]);
  }

  async function save() {
    if (problem || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (plate) {
        if (update) await actions.updatePlate(plate.id, update);
        onSaved(`${plate.label} saved`);
      } else {
        await actions.createPlate(createDtoOf(d, plan.needs));
        onSaved('Plate added');
      }
    } catch (err) {
      setError(planErrorText(err, 'Couldn\'t save the plate'));
    } finally {
      setSaving(false);
    }
  }

  const partRow = (rowKey: string, units: number, removable: boolean) => {
    const need = needOf(rowKey);
    const item = plate?.items.find(it => it.rowKey === rowKey);
    const named = need ?? item;
    const left = leftToPlan(plan, rowKey, excludeId);
    return (
      <li key={rowKey} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
        <div className="min-w-0 flex-1 basis-40">
          <p className="break-words text-sm font-medium text-gray-800 dark:text-gray-200">{named ? partTitle(named) : 'Part'}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {named && partSub(named) ? `${partSub(named)} · ` : ''}{need ? `${left} needed on this plate` : 'no longer needed by the order'}
          </p>
        </div>
        <Stepper value={units} min={1} max={MAX_UNITS_PER_PLATE} label={`Units of ${named ? partTitle(named) : 'the part'} on the plate`} disabled={saving}
          onChange={n => setUnits(rowKey, n)} />
        {removable && <LinkButton tone="danger" disabled={saving} onClick={() => setItems(d.items.filter(it => it.rowKey !== rowKey))}>Remove</LinkButton>}
      </li>
    );
  };

  return (
    <Dialog open onClose={saving ? () => undefined : onClose} title={title} className="max-w-md">
      <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
        {!plate && ways.length > 1 && (
          <fieldset className="space-y-1">
            <legend className={labelCls}>How it prints</legend>
            {ways.map(w => (
              <label key={w} className="flex min-h-[40px] cursor-pointer items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
                <input type="radio" name={`${id}-way`} className="h-4 w-4 accent-brand-600" checked={d.way === w} disabled={saving} onChange={() => chooseWay(w)} />
                {WAY_LABEL[w]}
              </label>
            ))}
          </fieldset>
        )}
        <p className="text-xs text-gray-500 dark:text-gray-400">{!plate && ways.length === 1 ? `${WAY_LABEL[d.way]}. ` : ''}{WAY_HINT[d.way]}</p>

        {d.way === 'shared' && !plate && !forNeed && filaments.length > 1 && (
          <div className="space-y-1">
            <label htmlFor={`${id}-filament`} className={labelCls}>Filament</label>
            <select id={`${id}-filament`} className={field} value={d.materialId ?? ''} disabled={saving} onChange={e => chooseFilament(e.target.value)}>
              {filaments.map(f => <option key={f.materialId} value={f.materialId}>{f.name}</option>)}
            </select>
          </div>
        )}

        {d.way !== 'shared' && !plate && !forNeed && needsForWay(plan.needs, d.way).length > 1 && (
          <div className="space-y-1">
            <label htmlFor={`${id}-part`} className={labelCls}>Part</label>
            <select id={`${id}-part`} className={field} value={d.items[0]?.rowKey ?? ''} disabled={saving} onChange={e => choosePart(e.target.value)}>
              {needsForWay(plan.needs, d.way).map(n => (
                <option key={n.rowKey} value={n.rowKey}>{partTitle(n)}{partSub(n) ? ` · ${partSub(n)}` : ''}</option>
              ))}
            </select>
          </div>
        )}

        {d.way === 'alone' ? (
          <div className="space-y-0.5">
            <p className={labelCls}>Printer</p>
            <p className="text-sm text-gray-800 dark:text-gray-200">
              {lockedPrinterName ?? 'The project\'s printer'}
              <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">· set by the project</span>
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            <label htmlFor={`${id}-printer`} className={labelCls}>Printer</label>
            <select id={`${id}-printer`} className={field} value={d.printerId ?? ''} disabled={saving} onChange={e => setDraft({ ...d, printerId: e.target.value || null })}>
              {printers.map(o => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
            </select>
          </div>
        )}

        {d.way === 'file' ? (
          <>
            {plate ? (
              <p className="break-words text-sm text-gray-800 dark:text-gray-200">
                {single ? partTitle(single) : plate.items[0] ? partTitle(plate.items[0]) : 'Part'}
                <span className="text-gray-500 dark:text-gray-400"> · {layout?.label ?? plate.gcodeFilename ?? 'existing file'} · {d.items[0]?.units ?? 1} on a plate</span>
              </p>
            ) : (
              <div className="space-y-1">
                <label htmlFor={`${id}-file`} className={labelCls}>File</label>
                <select id={`${id}-file`} className={field} value={d.layoutIndex} disabled={saving} onChange={e => setDraft(withLayout(d, plan, Number(e.target.value)))}>
                  {d.layoutIndex < 0 && <option value={-1} disabled>Choose a file</option>}
                  {(single?.layouts ?? []).map((l, i) => (
                    <option key={`${l.layoutId ?? 'own'}-${i}`} value={i}>
                      {l.label} · {l.unitsPerPlate} on a plate{l.printerName ? ` · ${l.printerName}` : ''}{l.hasFile ? '' : ' · no file yet'}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className={`${labelCls} min-w-0 flex-1 basis-40`}>
                How many times it prints
                <span className="block text-xs font-normal text-gray-500 dark:text-gray-400">
                  {(d.items[0]?.units ?? 1) * d.plateCount} in all · {single ? `${leftToPlan(plan, single.rowKey, excludeId)} needed on this plate` : ''}
                </span>
              </span>
              <Stepper value={d.plateCount} min={1} max={MAX_PLATE_COUNT} label="How many times the file prints" disabled={saving} onChange={n => setDraft({ ...d, plateCount: n })} />
            </div>
          </>
        ) : (
          <div>
            <p className={labelCls}>{d.way === 'shared' ? 'Parts on the plate' : 'Units on the plate'}</p>
            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
              {d.items.map(it => partRow(it.rowKey, it.units, d.way === 'shared'))}
            </ul>
            {d.way === 'shared' && addable.length > 0 && (
              <select aria-label="Add a part to the plate" className={`${field} mt-1`} value="" disabled={saving} onChange={e => addPart(e.target.value)}>
                <option value="">Add a part…</option>
                {addable.map(n => {
                  const left = leftToPlan(plan, n.rowKey, excludeId);
                  return <option key={n.rowKey} value={n.rowKey}>{partTitle(n)}{partSub(n) ? ` · ${partSub(n)}` : ''} — {left > 0 ? `${left} still to place` : 'fully placed'}</option>;
                })}
              </select>
            )}
            {d.way === 'shared' && plate && d.items.length === 0 && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">A plate with no parts cannot be saved — delete the plate instead.</p>
            )}
          </div>
        )}

        {notes.length > 0 && (
          <ul className="space-y-1 text-xs text-amber-700 dark:text-amber-300">
            {notes.map(n => <li key={n}>{n} It can still be saved.</li>)}
          </ul>
        )}
        {dropsFile && update && (
          <p className="text-xs text-gray-500 dark:text-gray-400">Saving removes this plate&apos;s sliced file — it has to be sliced again.</p>
        )}
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t pt-3 dark:border-gray-700">
        {problem && !error && <span className="mr-auto text-xs text-gray-500 dark:text-gray-400">{problem}</span>}
        <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={() => void save()} disabled={saving || problem !== null || (plate !== null && update === null)}>
          {saving ? 'Saving…' : plate ? 'Save plate' : 'Add plate'}
        </Button>
      </div>
    </Dialog>
  );
}
