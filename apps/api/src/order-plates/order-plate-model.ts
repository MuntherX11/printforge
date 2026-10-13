import type { OrderNeedMode, OrderPlanNeedDto, OrderPlateKind, OrderPlatePreviewDto, OrderPlateStatus, SliceFilamentMap } from '@printforge/types';
import type { PlannerLayout } from '../catalog-core/plate-planner';

/**
 * What the order-plates module keeps and passes around (v2.19.0). Nothing here
 * is sent to a client as it is: the DTOs are built in order-plate-view.ts.
 */

/** One part on a plate, as stored in `OrderPlate.items`. */
export interface StoredItem {
  rowKey: string;
  orderItemId: string;
  componentId: string;
  /** Units asked for on the plate. */
  units: number;
  /** Units the slicer placed (a LAYOUT plate: the layout's units per plate). Null until sliced. */
  unitsSliced: number | null;
  /** This part's share of the plate's minutes and grams. Null until sliced. */
  minutes: number | null;
  grams: number | null;
  /** PROJECT plates: grams per slot of the sliced file ("0".."3"), for the job's filament lines. */
  slotGrams?: Record<string, number>;
}

/** An OrderPlate row with its JSON columns read back. */
export interface PlateRow {
  id: string;
  orderId: string;
  kind: OrderPlateKind;
  status: OrderPlateStatus;
  printerId: string | null;
  printerName: string | null;
  sortOrder: number;
  items: StoredItem[];
  filamentMap: SliceFilamentMap;
  layoutId: string | null;
  plateCount: number;
  estMinutes: number;
  estGrams: number;
  minutes: number | null;
  grams: number | null;
  colorChanges: number;
  attachmentId: string | null;
  gcodeFilename: string | null;
  preview: OrderPlatePreviewDto | null;
  error: string | null;
  errorDetail: string | null;
  createdAt: Date;
}

/** A job made from a plate, as the lock and the coverage read it. */
export interface PlateJob {
  id: string;
  status: string;
  orderPlateId: string;
  orderItemId: string | null;
  componentId: string | null;
  quantityToProduce: number;
}

export interface NeedFilament {
  slot: number;
  materialId: string;
  name: string;
  type: string;
  colorHex: string | null;
}

/** A need with what the server knows besides the DTO. */
export interface PlanNeed extends OrderPlanNeedDto {
  mode: OrderNeedMode;
  productId: string;
  /** The plan row's own units still to print: `toProduce` minus the units of live jobs made from plates. */
  open: number;
  minutesPerUnit: number;
  gramsPerUnit: number;
  /** Width and depth (mm) of one unit; null when it is not known. */
  footprint: { x: number; y: number } | null;
  /** The model the slicer slices from. */
  source: { attachmentId: string; storagePath: string; kind: 'STL' | 'THREEMF' } | null;
  /** MIX: slot 0. PROJECT (and a one-slot project printed alone): the order line's filament per project slot. */
  filaments: NeedFilament[];
  /** A 3MF part's project printer (PROJECT: the lock; a one-slot project: where it prints alone). */
  projectPrinterId: string | null;
  pricingPrinterId: string | null;
  /** The part's usable plates, for LAYOUT plates. */
  plannerLayouts: ReadonlyArray<PlannerLayout>;
  /** PROJECT: units one plate holds as far as is known (suggest only). */
  capacity: number | null;
}

/** An active printer as the plan sees it. */
export interface PlanPrinter {
  id: string;
  name: string;
  /** What the printer is (a project is matched to its printer by it). */
  model?: string | null;
  /** The bed from the machine profile; null without one. */
  bed: { x: number; y: number } | null;
  /** Has a machine profile and a default process: MIXED plates can be sliced for it. */
  canSliceModels: boolean;
  hasMachine: boolean;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** `OrderPlate.items` read back defensively: anything that is not an item is dropped. */
export function storedItemsOf(json: unknown): StoredItem[] {
  if (!Array.isArray(json)) return [];
  const out: StoredItem[] = [];
  for (const raw of json) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.rowKey !== 'string' || typeof r.orderItemId !== 'string' || typeof r.componentId !== 'string') continue;
    const units = num(r.units);
    if (units === null || units < 1) continue;
    const item: StoredItem = {
      rowKey: r.rowKey, orderItemId: r.orderItemId, componentId: r.componentId, units: Math.floor(units),
      unitsSliced: num(r.unitsSliced), minutes: num(r.minutes), grams: num(r.grams),
    };
    if (r.slotGrams && typeof r.slotGrams === 'object' && !Array.isArray(r.slotGrams)) {
      const slots: Record<string, number> = {};
      for (const [k, v] of Object.entries(r.slotGrams as Record<string, unknown>)) if (/^[0-3]$/.test(k) && num(v) !== null) slots[k] = v as number;
      item.slotGrams = slots;
    }
    out.push(item);
  }
  return out;
}

/** `OrderPlate.preview` read back: null unless it has a bed and a list of objects. */
export function storedPreviewOf(json: unknown): OrderPlatePreviewDto | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const p = json as Record<string, any>;
  if (!p.bed || num(p.bed.x) === null || num(p.bed.y) === null || !Array.isArray(p.objects)) return null;
  return { bed: { x: p.bed.x, y: p.bed.y }, exact: p.exact === true, objects: p.objects, overflow: num(p.overflow) ?? 0 };
}

/** Units of a plate item that count: what the slicer placed once known, else what was asked for; times the plate count. */
export const itemUnits = (item: Pick<StoredItem, 'units' | 'unitsSliced'>, plateCount: number): number =>
  (item.unitsSliced ?? item.units) * Math.max(1, plateCount || 1);

const NOT_COUNTED = new Set(['CANCELLED', 'FAILED']);
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

/**
 * The jobs that lock a plate: every job made from it that is neither cancelled
 * nor failed (a reprint of a failed job carries the plate's id too, so an open
 * reprint locks it). A locked plate cannot be edited, re-sliced or deleted; one
 * whose jobs all failed or were cancelled is free again.
 */
export const liveJobsOf = (jobs: ReadonlyArray<PlateJob>, plateId: string): PlateJob[] =>
  jobs.filter((j) => j.orderPlateId === plateId && !NOT_COUNTED.has(j.status));

/** The plate has jobs and none of them is open: it is printed (or given up), so it is no work left for its printer. */
export function plateFinished(jobs: ReadonlyArray<PlateJob>, plateId: string): boolean {
  const own = jobs.filter((j) => j.orderPlateId === plateId);
  return own.length > 0 && own.every((j) => TERMINAL.has(j.status));
}

/** Units of a plan row that jobs made from plates still stand for (a failed job's units go back to the plan). */
export function liveJobUnits(jobs: ReadonlyArray<PlateJob>): Map<string, number> {
  const out = new Map<string, number>();
  for (const j of jobs) {
    if (NOT_COUNTED.has(j.status) || !j.orderItemId || !j.componentId) continue;
    const key = `${j.orderItemId}:${j.componentId}`;
    out.set(key, (out.get(key) ?? 0) + j.quantityToProduce);
  }
  return out;
}
