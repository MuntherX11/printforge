/**
 * Pure logic of the "Add plate" / "Edit plate" dialog (v2.19.0): the three
 * ways a part can be printed, the draft the dialog edits, what it sends.
 * Coverage (too few / too many) is only ever a note here, never a problem.
 */
import {
  MAX_UNITS_PER_PLATE,
  ORDER_PLATE_MAX_ITEMS,
  OrderNeedMode,
  OrderPlateKind,
  plannedByRow,
  type CreateOrderPlateDto,
  type OrderPlanNeedDto,
  type OrderPlateDto,
  type OrderPlateItemInput,
  type OrderPrintPlanDto,
  type UpdateOrderPlateDto,
} from '@printforge/types';
import { partPhrase } from './print-plan-model';

/** How a plate prints its parts, in the dialog's words. */
export type PlateWay = 'shared' | 'alone' | 'file';

export const MAX_PLATE_COUNT = 200;

export const WAY_LABEL: Record<PlateWay, string> = {
  shared: 'Parts sharing a plate',
  alone: 'Print alone with its own settings',
  file: 'Use an existing file',
};

export const WAY_HINT: Record<PlateWay, string> = {
  shared: 'Parts of the same filament are sliced together with the printer\'s default settings.',
  alone: 'One part, sliced from its project with the settings saved in it, on the project\'s printer.',
  file: 'A plate file the part already has. Nothing is sliced.',
};

const KIND_OF: Record<PlateWay, OrderPlateKind> = {
  shared: OrderPlateKind.MIXED,
  alone: OrderPlateKind.PROJECT,
  file: OrderPlateKind.LAYOUT,
};

export function wayOfKind(kind: OrderPlateKind): PlateWay {
  return kind === OrderPlateKind.PROJECT ? 'alone' : kind === OrderPlateKind.LAYOUT ? 'file' : 'shared';
}

/** The ways one part can be printed. */
export function waysOfNeed(n: OrderPlanNeedDto): PlateWay[] {
  const out: PlateWay[] = [];
  if (n.mode === OrderNeedMode.MIX) out.push('shared');
  if (n.mode === OrderNeedMode.PROJECT || (n.mode === OrderNeedMode.MIX && n.canOwnSettings)) out.push('alone');
  if (n.layouts.length > 0) out.push('file');
  return out;
}

const WAYS: PlateWay[] = ['shared', 'alone', 'file'];

/** The ways at least one part of the order can be printed. */
export function waysOfPlan(needs: ReadonlyArray<OrderPlanNeedDto>): PlateWay[] {
  return WAYS.filter(w => needs.some(n => waysOfNeed(n).includes(w)));
}

export function needsForWay(needs: ReadonlyArray<OrderPlanNeedDto>, way: PlateWay): OrderPlanNeedDto[] {
  return needs.filter(n => waysOfNeed(n).includes(way));
}

export interface PlateDraft {
  way: PlateWay;
  printerId: string | null;
  /** Shared: the one filament of the plate. */
  materialId: string | null;
  items: OrderPlateItemInput[];
  /** Existing file: index into the part's `layouts`; -1 when none is chosen. */
  layoutIndex: number;
  plateCount: number;
}

export function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/**
 * Units of a row the order still needs besides the plate being edited: the
 * API's own count (`toProduce - planned`), with what the edited plate holds
 * today given back (`excludePlateId`; null for a new plate). Never below 0.
 */
export function leftToPlan(plan: Pick<OrderPrintPlanDto, 'needs' | 'plates'>, rowKey: string, excludePlateId: string | null): number {
  const need = plan.needs.find(n => n.rowKey === rowKey);
  if (!need) return 0;
  const own = plan.plates.find(p => p.id === excludePlateId);
  // As the API counts a plate: the units really sliced once it is sliced.
  const held = own
    ? plannedByRow([{ plateCount: own.plateCount, items: own.items.map(it => ({ ...it, units: it.unitsSliced ?? it.units })) }]).get(rowKey) ?? 0
    : 0;
  return Math.max(0, need.toProduce - need.planned + held);
}

/** The printer a new shared plate starts on: the one set up for slicing with the least to do. */
export function leastBusyPrinterId(plan: Pick<OrderPrintPlanDto, 'printers'>): string | null {
  const able = plan.printers.filter(p => p.canSliceModels);
  if (!able.length) return null;
  return able.reduce((best, p) => (p.minutes < best.minutes ? p : best)).id;
}

function bestNeed(plan: OrderPrintPlanDto, way: PlateWay): OrderPlanNeedDto | null {
  const list = needsForWay(plan.needs, way);
  return list.find(n => leftToPlan(plan, n.rowKey, null) > 0) ?? list[0] ?? null;
}

/** The first file of the part that can be printed (one with a file, else the first). */
function firstLayoutIndex(n: OrderPlanNeedDto): number {
  const i = n.layouts.findIndex(l => l.hasFile);
  return i >= 0 ? i : n.layouts.length ? 0 : -1;
}

/** A new plate printed `way`, for `need` when given, else for what is still open. */
export function newDraft(plan: OrderPrintPlanDto, way: PlateWay, need: OrderPlanNeedDto | null = null): PlateDraft {
  const picked = need && waysOfNeed(need).includes(way) ? need : bestNeed(plan, way);
  const left = (n: OrderPlanNeedDto) => leftToPlan(plan, n.rowKey, null);
  const base: PlateDraft = { way, printerId: null, materialId: null, items: [], layoutIndex: -1, plateCount: 1 };
  if (!picked) return base;

  if (way === 'shared') {
    const same = need
      ? [picked]
      : plan.needs.filter(n => waysOfNeed(n).includes('shared') && n.materialId === picked.materialId && left(n) > 0);
    const rows = (same.length ? same : [picked]).slice(0, ORDER_PLATE_MAX_ITEMS);
    return {
      ...base,
      printerId: leastBusyPrinterId(plan),
      materialId: picked.materialId,
      items: rows.map(n => ({ rowKey: n.rowKey, units: clampInt(left(n), 1, MAX_UNITS_PER_PLATE) })),
    };
  }
  if (way === 'alone') {
    return { ...base, printerId: picked.lockedPrinterId, items: [{ rowKey: picked.rowKey, units: clampInt(left(picked), 1, MAX_UNITS_PER_PLATE) }] };
  }
  return withLayout({ ...base, items: [{ rowKey: picked.rowKey, units: 1 }] }, plan, firstLayoutIndex(picked));
}

/** Existing file: choose one of the part's files; units, printer and how many times it prints follow it. */
export function withLayout(d: PlateDraft, plan: OrderPrintPlanDto, layoutIndex: number): PlateDraft {
  const rowKey = d.items[0]?.rowKey;
  const need = plan.needs.find(n => n.rowKey === rowKey);
  const layout = need?.layouts[layoutIndex];
  if (!need || !layout) return { ...d, layoutIndex: -1 };
  const per = clampInt(layout.unitsPerPlate, 1, MAX_UNITS_PER_PLATE);
  const left = leftToPlan(plan, need.rowKey, null);
  return {
    ...d,
    layoutIndex,
    printerId: layout.printerId,
    items: [{ rowKey: need.rowKey, units: per }],
    plateCount: clampInt(Math.ceil(left / per), 1, MAX_PLATE_COUNT),
  };
}

/** The draft of an existing plate. */
export function draftOfPlate(plate: OrderPlateDto, needs: ReadonlyArray<OrderPlanNeedDto>): PlateDraft {
  const way = wayOfKind(plate.kind);
  const first = needs.find(n => n.rowKey === plate.items[0]?.rowKey);
  return {
    way,
    printerId: plate.printerId,
    materialId: plate.filaments[0]?.materialId ?? first?.materialId ?? null,
    items: plate.items.map(it => ({ rowKey: it.rowKey, units: it.units })),
    layoutIndex: way === 'file' && first ? first.layouts.findIndex(l => l.layoutId === plate.layoutId) : -1,
    plateCount: Math.max(1, plate.plateCount || 1),
  };
}

/** Parts that can still be put on the draft: the same filament for a shared plate, not already on it. */
export function addableNeeds(d: PlateDraft, needs: ReadonlyArray<OrderPlanNeedDto>): OrderPlanNeedDto[] {
  if (d.way !== 'shared') return [];
  return needs.filter(n => waysOfNeed(n).includes('shared')
    && (d.materialId === null || n.materialId === d.materialId)
    && !d.items.some(it => it.rowKey === n.rowKey));
}

/** The filaments shared plates can be made of. */
export function sharedFilaments(needs: ReadonlyArray<OrderPlanNeedDto>): Array<{ materialId: string; name: string }> {
  const out: Array<{ materialId: string; name: string }> = [];
  for (const n of needsForWay(needs, 'shared')) {
    if (n.materialId && !out.some(f => f.materialId === n.materialId)) out.push({ materialId: n.materialId, name: n.materialName ?? 'Filament' });
  }
  return out;
}

export interface PrinterOption {
  value: string;
  label: string;
  disabled: boolean;
}

/**
 * The printers a plate can go to. A shared plate needs a printer set up for
 * slicing (the others are listed, greyed, with the reason); an existing file
 * may have none. `current` is always in the list, so the select shows it.
 */
export function printerOptions(plan: Pick<OrderPrintPlanDto, 'printers'>, way: PlateWay, current: { id: string | null; name: string | null }): PrinterOption[] {
  const out: PrinterOption[] = [];
  if (way === 'file') out.push({ value: '', label: 'No printer', disabled: false });
  else if (!current.id) out.push({ value: '', label: plan.printers.length ? 'Choose a printer' : 'No printers', disabled: true });
  for (const p of plan.printers) {
    const able = way !== 'shared' || p.canSliceModels;
    out.push({ value: p.id, label: able ? p.name : `${p.name} — not set up for slicing`, disabled: !able && p.id !== current.id });
  }
  if (current.id && !plan.printers.some(p => p.id === current.id)) out.push({ value: current.id, label: current.name ?? 'Printer', disabled: false });
  return out;
}

const wholeUnits = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_UNITS_PER_PLATE;

/** Why the draft cannot be saved; null when it can. An existing plate keeps its file, so none has to be chosen. */
export function draftProblem(d: PlateDraft, editing = false): string | null {
  if (d.items.length === 0) return 'Add at least one part';
  if (!d.items.every(it => wholeUnits(it.units))) return `Units are whole numbers from 1 to ${MAX_UNITS_PER_PLATE}`;
  if (d.way === 'shared') {
    if (d.items.length > ORDER_PLATE_MAX_ITEMS) return `A plate holds at most ${ORDER_PLATE_MAX_ITEMS} different parts`;
    if (!d.printerId) return 'Choose a printer';
  }
  if (d.way === 'file') {
    if (d.layoutIndex < 0 && !editing) return 'Choose a file';
    if (!Number.isInteger(d.plateCount) || d.plateCount < 1 || d.plateCount > MAX_PLATE_COUNT) return `It can print 1 to ${MAX_PLATE_COUNT} times`;
  }
  return null;
}

/** Plain notes about coverage: what the plate holds beyond, or short of, what the order still needs. */
export function draftNotes(d: PlateDraft, plan: OrderPrintPlanDto, excludePlateId: string | null): string[] {
  const out: string[] = [];
  const times = d.way === 'file' ? Math.max(1, d.plateCount) : 1;
  for (const it of d.items) {
    const need = plan.needs.find(n => n.rowKey === it.rowKey);
    if (!need) continue;
    const left = leftToPlan(plan, it.rowKey, excludePlateId);
    const on = it.units * times;
    if (on > left) out.push(`${partPhrase(need)}: ${on - left} more than the order still needs.`);
  }
  return out;
}

export function createDtoOf(d: PlateDraft, needs: ReadonlyArray<OrderPlanNeedDto>): CreateOrderPlateDto {
  const dto: CreateOrderPlateDto = { kind: KIND_OF[d.way], items: d.items.map(it => ({ rowKey: it.rowKey, units: it.units })) };
  if (d.way === 'shared') dto.printerId = d.printerId;
  if (d.way === 'file') {
    const need = needs.find(n => n.rowKey === d.items[0]?.rowKey);
    dto.printerId = d.printerId;
    dto.layoutId = need?.layouts[d.layoutIndex]?.layoutId ?? null;
    dto.plateCount = d.plateCount;
  }
  return dto;
}

const sameItems = (a: ReadonlyArray<OrderPlateItemInput>, b: ReadonlyArray<OrderPlateItemInput>) =>
  a.length === b.length && a.every((x, i) => x.rowKey === b[i].rowKey && x.units === b[i].units);

/** Only what changed (any change to a sliced plate drops its file); null when nothing did. */
export function updateDtoOf(d: PlateDraft, plate: OrderPlateDto): UpdateOrderPlateDto | null {
  const dto: UpdateOrderPlateDto = {};
  if (d.way !== 'alone' && (d.printerId ?? null) !== (plate.printerId ?? null)) dto.printerId = d.printerId;
  if (!sameItems(d.items, plate.items)) dto.items = d.items.map(it => ({ rowKey: it.rowKey, units: it.units }));
  if (d.way === 'file' && d.plateCount !== Math.max(1, plate.plateCount || 1)) dto.plateCount = d.plateCount;
  return Object.keys(dto).length ? dto : null;
}
