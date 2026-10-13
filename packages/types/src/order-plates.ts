// Print files for a whole order (v2.19.0): the plates an order needs, which printer
// prints each, and the sliced file of every plate. Pure types and helpers only.
//
//  order lines ──needs──▶ suggest ──▶ OrderPlate (DRAFT, editable) ──Slice──▶ DONE (+ G-code)
//                                                                   └──Create jobs──▶ ProductionJob per (plan row, plate)

import type { MaterialType } from './index';

export const OrderPlateKind = {
  /** Single-colour parts of ONE filament sliced together from their models (STL, or the shape of a one-slot 3MF). */
  MIXED: 'MIXED',
  /** One 3MF project part sliced with its own settings on the printer the project names. */
  PROJECT: 'PROJECT',
  /** An existing plate file of a part (hand-sliced or sliced earlier); nothing is sliced. */
  LAYOUT: 'LAYOUT',
} as const;
export type OrderPlateKind = (typeof OrderPlateKind)[keyof typeof OrderPlateKind];

export const OrderPlateStatus = { DRAFT: 'DRAFT', QUEUED: 'QUEUED', RUNNING: 'RUNNING', DONE: 'DONE', FAILED: 'FAILED' } as const;
export type OrderPlateStatus = (typeof OrderPlateStatus)[keyof typeof OrderPlateStatus];

/** How a need can be printed. */
export const OrderNeedMode = {
  /** Has a model and one filament: may share MIXED plates. */
  MIX: 'MIX',
  /** A multi-colour project: PROJECT plates only, on the project's printer. */
  PROJECT: 'PROJECT',
  /** No model: only its existing plate files (LAYOUT plates). */
  LAYOUT: 'LAYOUT',
  /** Cannot be planned; see `blockedReason`. */
  BLOCKED: 'BLOCKED',
} as const;
export type OrderNeedMode = (typeof OrderNeedMode)[keyof typeof OrderNeedMode];

/** Most parts on one plate and most plates in one order plan. */
export const ORDER_PLATE_MAX_ITEMS = 24;
export const ORDER_PLAN_MAX_PLATES = 200;

/** One part on a plate. `rowKey` is the production plan row (order line x part) it serves. */
export interface OrderPlateItemDto {
  rowKey: string;
  orderItemId: string;
  componentId: string;
  productName: string;
  componentDescription: string;
  /** Size / colour label of the order line, '' for the standard pair. */
  optionLabel: string;
  /** Units asked for on this plate (1..500). */
  units: number;
  /** DONE: units the slicer placed; fewer than `units` when the plate was too full. */
  unitsSliced: number | null;
  /** DONE: this part's share of the plate's minutes and grams (by its own per-unit numbers). */
  minutes: number | null;
  grams: number | null;
}

export interface OrderPlateFilamentDto {
  /** Slot index 0..3. A MIXED plate has slot 0 only. */
  slot: number;
  materialId: string;
  name: string;
  type: MaterialType | string;
  colorHex: string | null;
}

/**
 * A top-down drawing of a plate, in bed millimetres (origin = the bed's front-left corner, y up).
 * `exact` true: outlines read from the sliced file's object labels. False: a sketch that lays each
 * part's bounding box out in rows, drawn before the plate is sliced (positions are not the slicer's).
 */
export interface OrderPlatePreviewDto {
  bed: { x: number; y: number };
  exact: boolean;
  objects: Array<{
    /** The plan row the object belongs to; null when a label matched no part. */
    rowKey: string | null;
    /** Closed outline, at most 64 points. A sketch has 4. */
    polygon: Array<[number, number]>;
  }>;
  /** Sketch only: units that did not fit the drawing (the plate is probably too full). */
  overflow: number;
}

export interface OrderPlateDto {
  /** Null when no footprint is known for any part on the plate. */
  preview: OrderPlatePreviewDto | null;
  id: string;
  orderId: string;
  kind: OrderPlateKind;
  status: OrderPlateStatus;
  printerId: string | null;
  printerName: string | null;
  sortOrder: number;
  /** "Plate 3 · Ender" style name, unique in the order. */
  label: string;
  items: OrderPlateItemDto[];
  filaments: OrderPlateFilamentDto[];
  /** LAYOUT: the existing plate layout (null = the part's own single-unit file) and how many times it prints. Else null / 1. */
  layoutId: string | null;
  plateCount: number;
  /** Before slicing: from each part's per-unit minutes and grams. */
  estMinutes: number;
  estGrams: number;
  /** DONE (or LAYOUT): the file's own numbers, for ONE plate. */
  minutes: number | null;
  grams: number | null;
  hasFile: boolean;
  gcodeFilename: string | null;
  /** FAILED: one plain sentence, and the slicer's raw output when there is any. */
  error: string | null;
  errorDetail: string | null;
  /** Jobs made from this plate. A plate with jobs is locked: it cannot be edited, re-sliced or deleted. */
  jobIds: string[];
  locked: boolean;
}

/** What the order still has to print, one per production plan row. */
export interface OrderPlanNeedDto {
  rowKey: string;
  orderItemId: string;
  componentId: string;
  productName: string;
  componentDescription: string;
  optionLabel: string;
  colourLabel: string;
  /** Units to print after printed stock is taken, as the production plan suggests. */
  toProduce: number;
  /** Units on this order's plates (locked or not). */
  planned: number;
  mode: OrderNeedMode;
  /** MIX: the one filament it prints in. */
  materialId: string | null;
  materialName: string | null;
  /** MIX with a 3MF source: it can also be printed alone with the project's own settings (a PROJECT plate). */
  canOwnSettings: boolean;
  /** LAYOUT / any: the part's existing plates, for "use an existing file". */
  layouts: Array<{ layoutId: string | null; label: string; unitsPerPlate: number; printerId: string | null; printerName: string | null; hasFile: boolean }>;
  /** PROJECT: the printer the project is locked to. */
  lockedPrinterId: string | null;
  blockedReason: string | null;
}

export interface OrderPlanPrinterDto {
  id: string;
  name: string;
  /** Printers a MIXED plate can be sliced for: has a machine profile and a default process. */
  canSliceModels: boolean;
  plates: number;
  /** Sum of the plates' minutes (sliced numbers where known, estimates otherwise). */
  minutes: number;
}

export interface OrderPlanWarning {
  code: 'SHORT' | 'OVER' | 'BLOCKED' | 'SLICER_DOWN' | 'PLATE_TOO_FULL' | 'NO_PRINTER';
  message: string;
  rowKey?: string;
  plateId?: string;
}

/** GET /orders/:id/print-plan */
export interface OrderPrintPlanDto {
  orderId: string;
  /** False when the order's status does not allow planning (cancelled, completed…): everything is read-only. */
  plannable: boolean;
  needs: OrderPlanNeedDto[];
  plates: OrderPlateDto[];
  printers: OrderPlanPrinterDto[];
  /** The longest printer's total: when the order is finished if every printer starts now. */
  finishMinutes: number;
  warnings: OrderPlanWarning[];
  slicerReachable: boolean;
}

/** One part on a plate, as the client sends it. */
export interface OrderPlateItemInput {
  rowKey: string;
  units: number;
}

/** POST /orders/:id/print-plan/plates */
export interface CreateOrderPlateDto {
  kind: OrderPlateKind;
  /** MIXED: required. PROJECT: ignored (the project's printer). LAYOUT: optional. */
  printerId?: string | null;
  /** MIXED: 1..24 parts of one filament. PROJECT / LAYOUT: exactly one. */
  items: OrderPlateItemInput[];
  /** LAYOUT only. */
  layoutId?: string | null;
  plateCount?: number;
}

/** PATCH /order-plates/:id. Any change to a sliced plate drops its file and returns it to DRAFT. */
export interface UpdateOrderPlateDto {
  printerId?: string | null;
  items?: OrderPlateItemInput[];
  plateCount?: number;
}

/** POST /orders/:id/print-plan/jobs response. */
export interface OrderPlanJobsResult {
  jobsCreated: number;
  jobIds: string[];
  warnings: OrderPlanWarning[];
}

/** Websocket event `order-plate`: a plate changed status. */
export interface OrderPlateEvent {
  id: string;
  orderId: string;
  status: OrderPlateStatus;
  error: string | null;
}

// ---------- pure helpers shared by the API and the order page ----------

/** A part's share of a plate total, by weight `w_i = units_i x perUnit_i` (equal shares when every weight is 0). */
export function plateShares(total: number, weights: ReadonlyArray<number>): number[] {
  const safe = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const sum = safe.reduce((s, w) => s + w, 0);
  if (!weights.length) return [];
  if (!(Number.isFinite(total) && total > 0)) return weights.map(() => 0);
  if (sum <= 0) return weights.map(() => total / weights.length);
  return safe.map((w) => (total * w) / sum);
}

/** Units of each plan row on the plates (LAYOUT plates count `units x plateCount`). */
export function plannedByRow(plates: ReadonlyArray<Pick<OrderPlateDto, 'items' | 'plateCount'>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of plates) {
    for (const it of p.items) out.set(it.rowKey, (out.get(it.rowKey) ?? 0) + it.units * Math.max(1, p.plateCount || 1));
  }
  return out;
}

/** A plate's minutes: the sliced number when known, else the estimate; times its plate count. */
export function plateTotalMinutes(p: Pick<OrderPlateDto, 'minutes' | 'estMinutes' | 'plateCount'>): number {
  return (p.minutes ?? p.estMinutes ?? 0) * Math.max(1, p.plateCount || 1);
}
