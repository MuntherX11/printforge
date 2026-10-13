import {
  ORDER_PLAN_MAX_PLATES, plateTotalMinutes, type OrderPlanNeedDto, type OrderPlanPrinterDto, type OrderPlanWarning, type OrderPlateDto, type OrderPlateFilamentDto,
  type OrderPrintPlanDto, type SlotKey,
} from '@printforge/types';
import { suggestOrderPlates, toSuggestNeed } from './order-plan-suggest';
import { itemUnits, liveJobsOf, plateFinished, storedItemsOf, storedPreviewOf, type PlanNeed, type PlanPrinter, type PlateJob, type PlateRow } from './order-plate-model';
import { sketchPreview } from './order-plate-preview';
import { filamentMapOf } from '../slice/slice.service';

/**
 * The read model of an order's print plan: the plate and need DTOs, the
 * printers' totals and the plan's warnings. Pure.
 */

/** "Plate 3 · Ender". The number is the plate's own and never changes, so a downloaded file keeps meaning the same plate. */
export const plateLabel = (sortOrder: number, printerName: string | null): string =>
  `Plate ${sortOrder + 1}${printerName ? ` · ${printerName}` : ''}`;

/**
 * The file name a plate is stored and downloaded under:
 * "<order number> <plate label> <tag>.gcode", in plain letters only. A printer
 * reports the name it was sent and a job is matched to its print by exactly
 * that name, so the name must never come back: plate numbers can (delete the
 * last plate, add another), the tag — the end of the plate's id — cannot.
 */
export function plateFileName(orderNumber: string, label: string, plateId: string): string {
  const tag = plateId.replace(/[^A-Za-z0-9]/g, '').slice(-5).toLowerCase();
  const clean = `${orderNumber} ${label}`.replace(/[^\w\s.-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
  return `${[clean || 'plate', tag].filter(Boolean).join(' ')}.gcode`;
}

/** An OrderPlate row (with its printer) as the module reads it. */
export function toPlateRow(row: any): PlateRow {
  return {
    id: row.id,
    orderId: row.orderId,
    kind: row.kind,
    status: row.status,
    printerId: row.printerId ?? null,
    printerName: row.printer?.name ?? null,
    sortOrder: Number(row.sortOrder ?? 0),
    items: storedItemsOf(row.items),
    filamentMap: filamentMapOf(row.filamentMap),
    layoutId: row.layoutId ?? null,
    plateCount: Math.max(1, Number(row.plateCount ?? 1)),
    estMinutes: Number(row.estMinutes ?? 0),
    estGrams: Number(row.estGrams ?? 0),
    minutes: row.minutes ?? null,
    grams: row.grams ?? null,
    colorChanges: Number(row.colorChanges ?? 0),
    attachmentId: row.attachmentId ?? null,
    gcodeFilename: row.gcodeFilename ?? null,
    preview: storedPreviewOf(row.preview),
    error: row.error ?? null,
    errorDetail: row.errorDetail ?? null,
    createdAt: row.createdAt ?? new Date(0),
  };
}

const nameOf = (n: Pick<OrderPlanNeedDto, 'componentDescription' | 'optionLabel'> | undefined): string =>
  (n ? `${n.componentDescription}${n.optionLabel ? ` (${n.optionLabel})` : ''}` : 'a removed part');

export interface PlanView {
  needs: ReadonlyArray<PlanNeed>;
  printers: ReadonlyArray<PlanPrinter>;
  jobs: ReadonlyArray<PlateJob>;
}

export function toPlateDto(plate: PlateRow, view: PlanView): OrderPlateDto {
  const needs = new Map(view.needs.map((n) => [n.rowKey, n]));
  const printer = view.printers.find((p) => p.id === plate.printerId) ?? null;
  const jobs = liveJobsOf(view.jobs, plate.id);
  const colours = new Map<string, string | null>();
  for (const i of plate.items) for (const f of needs.get(i.rowKey)?.filaments ?? []) colours.set(f.materialId, f.colorHex);
  const filaments: OrderPlateFilamentDto[] = (Object.keys(plate.filamentMap) as SlotKey[])
    .sort()
    .map((k) => {
      const f = plate.filamentMap[k]!;
      return { slot: Number(k), materialId: f.materialId, name: f.name, type: f.type, colorHex: colours.get(f.materialId) ?? null };
    });
  // The slicer's own drawing once there is one; before that the sketch.
  // A LAYOUT plate prints the part's own plate file: what that plate has now, not what it had when the plate was made.
  const own = plate.kind === 'LAYOUT' ? needs.get(plate.items[0]?.rowKey)?.plannerLayouts.find((l) => l.layoutId === plate.layoutId) : undefined;
  const fileId = own ? own.attachmentId ?? null : plate.attachmentId;
  const fileName = own ? own.gcodeFilename ?? null : plate.gcodeFilename;
  const preview = plate.preview
    ?? sketchPreview(printer?.bed ?? null, plate.items.map((i) => ({ rowKey: i.rowKey, units: i.units, footprint: needs.get(i.rowKey)?.footprint ?? null })));
  return {
    preview,
    id: plate.id,
    orderId: plate.orderId,
    kind: plate.kind,
    status: plate.status,
    printerId: plate.printerId,
    printerName: plate.printerName,
    sortOrder: plate.sortOrder,
    label: plateLabel(plate.sortOrder, plate.printerName),
    items: plate.items.map((i) => {
      const n = needs.get(i.rowKey);
      return {
        rowKey: i.rowKey, orderItemId: i.orderItemId, componentId: i.componentId,
        productName: n?.productName ?? '', componentDescription: n?.componentDescription ?? 'Removed part', optionLabel: n?.optionLabel ?? '',
        units: i.units, unitsSliced: i.unitsSliced, minutes: i.minutes, grams: i.grams,
      };
    }),
    filaments,
    layoutId: plate.layoutId,
    plateCount: plate.plateCount,
    estMinutes: plate.estMinutes,
    estGrams: plate.estGrams,
    minutes: plate.minutes,
    grams: plate.grams,
    hasFile: !!fileId,
    gcodeFilename: fileName,
    error: plate.error,
    errorDetail: plate.errorDetail,
    jobIds: jobs.map((j) => j.id),
    locked: jobs.length > 0,
  };
}

/**
 * Units of each plan row on the plates. An unlocked plate counts what it holds
 * (what the slicer placed, once sliced); a locked one counts only what its
 * live jobs stand for, as the need's `toProduce` does.
 */
export function plannedUnits(plates: ReadonlyArray<PlateRow>, jobs: ReadonlyArray<PlateJob>, live: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>(live);
  for (const p of plates) {
    if (liveJobsOf(jobs, p.id).length) continue;
    for (const i of p.items) out.set(i.rowKey, (out.get(i.rowKey) ?? 0) + itemUnits(i, p.plateCount));
  }
  return out;
}

export function planWarnings(plates: ReadonlyArray<PlateRow>, view: PlanView, slicerReachable: boolean): OrderPlanWarning[] {
  const out: OrderPlanWarning[] = [];
  const needs = new Map(view.needs.map((n) => [n.rowKey, n]));
  const printers = new Map(view.printers.map((p) => [p.id, p]));
  const sliceable = plates.filter((p) => p.kind !== 'LAYOUT' && p.status !== 'DONE' && !liveJobsOf(view.jobs, p.id).length);
  if (!slicerReachable && (sliceable.length || view.needs.some((n) => n.open > 0 && (n.mode === 'MIX' || n.mode === 'PROJECT')))) {
    out.push({ code: 'SLICER_DOWN', message: 'The slicer is not running — plates cannot be sliced right now' });
  }
  if (view.needs.some((n) => n.mode === 'MIX' && n.open > 0) && !view.printers.some((p) => p.canSliceModels)) {
    out.push({ code: 'NO_PRINTER', message: 'No printer can slice models yet — give a printer a machine profile and a default process in Settings › Slicer' });
  }
  for (const n of view.needs) {
    if (n.mode === 'BLOCKED' && n.toProduce > 0 && n.blockedReason) out.push({ code: 'BLOCKED', rowKey: n.rowKey, message: n.blockedReason });
  }
  for (const p of plates) {
    const label = plateLabel(p.sortOrder, p.printerName);
    if (p.items.some((i) => !needs.has(i.rowKey)) && !liveJobsOf(view.jobs, p.id).length) {
      out.push({ code: 'BLOCKED', plateId: p.id, message: `${label} holds a part that is no longer in this order — take the part off the plate or delete the plate` });
    }
    if (sliceable.includes(p)) {
      const printer = p.printerId ? printers.get(p.printerId) : undefined;
      const ok = printer && (p.kind === 'MIXED' ? printer.canSliceModels : printer.hasMachine);
      if (!ok) out.push({ code: 'NO_PRINTER', plateId: p.id, message: `${label} has no printer that can slice it — choose another printer` });
    }
    if (p.kind === 'LAYOUT' || p.status !== 'DONE') continue;
    for (const i of p.items) {
      if (i.unitsSliced === null || i.unitsSliced >= i.units) continue;
      const left = i.units - i.unitsSliced;
      out.push({
        code: 'PLATE_TOO_FULL', plateId: p.id, rowKey: i.rowKey,
        message: `${label} holds ${i.unitsSliced} of ${i.units} ${nameOf(needs.get(i.rowKey))} — ${left} still need${left === 1 ? 's' : ''} a plate`,
      });
    }
  }
  for (const n of view.needs) {
    const diff = n.toProduce - n.planned;
    // A blocked part with nothing planned already says why above.
    if (diff > 0 && !(n.mode === 'BLOCKED' && n.planned === 0)) {
      out.push({ code: 'SHORT', rowKey: n.rowKey, message: `${nameOf(n)}: ${diff} of ${n.toProduce} still need${diff === 1 ? 's' : ''} a plate` });
    } else if (diff < 0) {
      out.push({ code: 'OVER', rowKey: n.rowKey, message: `${nameOf(n)}: the plates hold ${n.planned}, the order needs ${n.toProduce}` });
    }
  }
  // What a suggestion could not place, said on every read (not only in the answer to "Prepare print files"):
  // a part larger than every bed, a part with no usable plate — for the units that are still short.
  const short = view.needs.filter((n) => n.toProduce - n.planned > 0);
  if (short.length) {
    const unplaced = suggestOrderPlates(short.map((n) => toSuggestNeed(n, n.toProduce - n.planned)), view.printers).warnings;
    out.push(...unplaced.filter((w) => !!w.rowKey));
    if (plates.length >= ORDER_PLAN_MAX_PLATES) {
      out.push({ code: 'SHORT', message: `The plan stops at ${ORDER_PLAN_MAX_PLATES} plates — create jobs for these first, then prepare the rest` });
    }
  }
  return out;
}

/**
 * What each printer still has to print. A plate whose jobs are all finished,
 * failed or cancelled is left out: it is no work in front of the printer.
 */
export function printerTotals(plates: ReadonlyArray<OrderPlateDto>, printers: ReadonlyArray<PlanPrinter>, jobs: ReadonlyArray<PlateJob> = []): OrderPlanPrinterDto[] {
  return printers.map((p) => {
    const own = plates.filter((x) => x.printerId === p.id && !plateFinished(jobs, x.id));
    return {
      id: p.id, name: p.name, canSliceModels: p.canSliceModels,
      plates: own.reduce((s, x) => s + x.plateCount, 0),
      minutes: Math.round(own.reduce((s, x) => s + plateTotalMinutes(x), 0) * 10) / 10,
    };
  });
}

export function toPlanDto(a: {
  orderId: string; plannable: boolean; plates: ReadonlyArray<PlateRow>; view: PlanView; slicerReachable: boolean; extraWarnings?: OrderPlanWarning[];
}): OrderPrintPlanDto {
  const plates = a.plates.map((p) => toPlateDto(p, a.view));
  const printers = printerTotals(plates, a.view.printers, a.view.jobs);
  // The DTO's own keys only: the server-side facts of a need stay here.
  const needs: OrderPlanNeedDto[] = a.view.needs.map((n) => ({
    rowKey: n.rowKey, orderItemId: n.orderItemId, componentId: n.componentId, productName: n.productName,
    componentDescription: n.componentDescription, optionLabel: n.optionLabel, colourLabel: n.colourLabel,
    toProduce: n.toProduce, planned: n.planned, mode: n.mode, materialId: n.materialId, materialName: n.materialName,
    canOwnSettings: n.canOwnSettings, layouts: n.layouts, lockedPrinterId: n.lockedPrinterId, blockedReason: n.blockedReason,
  }));
  return {
    orderId: a.orderId,
    plannable: a.plannable,
    needs,
    plates,
    printers,
    finishMinutes: printers.reduce((m, p) => Math.max(m, p.minutes), 0),
    // What a suggestion said is also what the plan says: each sentence once.
    warnings: [...(a.extraWarnings ?? []), ...planWarnings(a.plates, a.view, a.slicerReachable)].filter((w, i, all) => all.findIndex((x) => x.message === w.message) === i),
    slicerReachable: a.slicerReachable,
  };
}
