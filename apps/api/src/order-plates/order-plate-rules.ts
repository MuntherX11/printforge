import { BadRequestException } from '@nestjs/common';
import type { OrderPlateKind, SliceFilamentMap, SlotKey } from '@printforge/types';
import type { PlannerLayout } from '../catalog-core/plate-planner';
import type { PlateItemInput } from './order-plate-input';
import type { NeedFilament, PlanNeed, PlanPrinter, StoredItem } from './order-plate-model';

/**
 * What a plate may hold (owner decisions 2026-10-13). Pure; throws 400 with a
 * sentence a shop worker can act on. Staff may override everything the
 * suggestion made except the two hard limits:
 *
 *  - a multi-colour project never shares a plate, and
 *  - it stays on the printer its project names.
 *
 * Coverage (too few or too many units) is never checked here: it is a warning
 * of the plan.
 */

export interface PlateDraftInput {
  kind: OrderPlateKind;
  /** undefined = not chosen */
  printerId?: string | null;
  items: PlateItemInput[];
  layoutId: string | null;
  plateCount?: number;
}

/** A checked plate, ready to be stored. */
export interface PlateDraft {
  kind: OrderPlateKind;
  printerId: string | null;
  items: StoredItem[];
  filamentMap: SliceFilamentMap;
  layoutId: string | null;
  plateCount: number;
  estMinutes: number;
  estGrams: number;
  /** LAYOUT: the plate layout it prints (its file and numbers make the plate DONE at once). */
  layout: PlannerLayout | null;
}

export const GONE_FROM_PLAN = 'A part on this plate is no longer in the order — take the part off the plate or delete the plate';
const round1 = (n: number) => Math.round(n * 10) / 10;

export function filamentMapFor(filaments: ReadonlyArray<NeedFilament>): SliceFilamentMap {
  const map: SliceFilamentMap = {};
  for (const f of filaments) map[String(f.slot) as SlotKey] = { materialId: f.materialId, name: f.name, type: f.type };
  return map;
}

const itemOf = (n: PlanNeed, units: number, unitsSliced: number | null = null): StoredItem =>
  ({ rowKey: n.rowKey, orderItemId: n.orderItemId, componentId: n.componentId, units, unitsSliced, minutes: null, grams: null });

function needsOf(items: ReadonlyArray<PlateItemInput>, needs: ReadonlyMap<string, PlanNeed>): PlanNeed[] {
  return items.map((i) => {
    const n = needs.get(i.rowKey);
    if (!n) throw new BadRequestException(GONE_FROM_PLAN);
    return n;
  });
}

const projectAlone = (n: PlanNeed) => `"${n.componentDescription}" is a multi-colour project — it prints alone on its own plate`;

export function checkPlate(input: PlateDraftInput, needs: ReadonlyMap<string, PlanNeed>, printers: ReadonlyMap<string, PlanPrinter>): PlateDraft {
  const rows = needsOf(input.items, needs);

  if (input.kind === 'MIXED') {
    for (const n of rows) {
      if (n.mode === 'PROJECT') throw new BadRequestException(projectAlone(n));
      if (n.mode !== 'MIX') throw new BadRequestException(n.blockedReason ?? `"${n.componentDescription}" has no model to slice — use one of its existing files instead`);
    }
    const materialId = rows[0].materialId;
    const other = rows.find((n) => n.materialId !== materialId);
    if (other) {
      throw new BadRequestException(`"${other.componentDescription}" prints in ${other.materialName ?? 'another filament'}, not ${rows[0].materialName ?? 'the filament of this plate'} — a plate holds one filament`);
    }
    if (!input.printerId) throw new BadRequestException('Choose a printer for this plate');
    const printer = printers.get(input.printerId);
    if (!printer) throw new BadRequestException('That printer is not active');
    if (!printer.canSliceModels) {
      throw new BadRequestException(`${printer.name} cannot slice models yet — it needs a machine profile and a default process in Settings › Slicer`);
    }
    return {
      kind: 'MIXED', printerId: printer.id, layoutId: null, plateCount: 1, layout: null,
      items: rows.map((n, i) => itemOf(n, input.items[i].units)),
      filamentMap: filamentMapFor(rows[0].filaments.slice(0, 1)),
      estMinutes: round1(rows.reduce((s, n, i) => s + input.items[i].units * n.minutesPerUnit, 0)),
      estGrams: round1(rows.reduce((s, n, i) => s + input.items[i].units * n.gramsPerUnit, 0)),
    };
  }

  if (rows.length !== 1) {
    throw new BadRequestException(input.kind === 'PROJECT' ? 'A project plate holds exactly one part' : 'A plate from an existing file holds exactly one part');
  }
  const need = rows[0];
  const units = input.items[0].units;

  if (input.kind === 'PROJECT') {
    const own = need.mode === 'MIX' && need.canOwnSettings;
    if (need.mode !== 'PROJECT' && !own) {
      throw new BadRequestException(need.blockedReason ?? `"${need.componentDescription}" has no project of its own to print from`);
    }
    const printerId = need.mode === 'PROJECT' ? need.lockedPrinterId : need.projectPrinterId;
    const printer = printerId ? printers.get(printerId) : undefined;
    if (!printer) throw new BadRequestException(`The printer of the project of "${need.componentDescription}" is not active`);
    // Hard limit: the project's printer, whatever was asked for.
    if (input.printerId && input.printerId !== printer.id) {
      throw new BadRequestException(`"${need.componentDescription}" prints with its project's own settings, on ${printer.name} only`);
    }
    return {
      kind: 'PROJECT', printerId: printer.id, layoutId: null, plateCount: 1, layout: null,
      items: [itemOf(need, units)],
      filamentMap: filamentMapFor(need.filaments),
      estMinutes: round1(units * need.minutesPerUnit),
      estGrams: round1(units * need.gramsPerUnit),
    };
  }

  // LAYOUT: one of the part's own plates, printed `plateCount` times.
  const layout = need.plannerLayouts.find((l) => l.layoutId === input.layoutId);
  if (!layout) {
    throw new BadRequestException(input.layoutId
      ? `That plate is not one of the plates of "${need.componentDescription}" any more — reload the page`
      : `"${need.componentDescription}" has no single-unit file — choose one of its plates`);
  }
  let printerId: string | null = input.printerId ?? layout.printerId ?? need.pricingPrinterId ?? null;
  if (layout.printerId && printerId !== layout.printerId) {
    throw new BadRequestException(`That plate of "${need.componentDescription}" is sliced for ${layout.printerName ?? 'another printer'} — it prints there only`);
  }
  // An explicit "no printer" stays none; a printer that is gone is not kept.
  if (input.printerId === null && !layout.printerId) printerId = null;
  if (printerId && !printers.has(printerId)) {
    if (input.printerId) throw new BadRequestException('That printer is not active');
    printerId = null;
  }
  return {
    kind: 'LAYOUT', printerId, layoutId: layout.layoutId, plateCount: input.plateCount ?? 1, layout,
    // The file decides the units: a plate prints as it was sliced.
    items: [itemOf(need, layout.unitsPerPlate, layout.unitsPerPlate)],
    filamentMap: filamentMapFor(need.filaments),
    estMinutes: round1(layout.plateMinutes),
    estGrams: round1(layout.plateGrams),
  };
}
