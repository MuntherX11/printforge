/**
 * The product page's BOM filament picker ("assign a filament colour manually"):
 * which filaments a colour slot is offered and in what order, what a pick
 * writes, and the request plan Edit component shares with it (dry run first,
 * then the write, then `Save anyway` with confirm).
 *
 * Pure and DOM-free: the app runs it in the browser and the api jest suite
 * tests it (through the '@printforge/types' moduleNameMapper). Only types come
 * from ./index, so there is no runtime import cycle.
 */
import type { FilamentStockRow, Problem } from './index';
import { filamentQueryMatcher } from './filament-filter';

// ---------------------------------------------------------------- writes

/** One colour slot's filament, as P11 (PUT …/materials) takes it. */
export interface SlotMaterialPick {
  colorIndex: number;
  materialId: string;
}

/**
 * One component change. `fields` holds the changed P10 fields only;
 * `materialId` is a single-material filament change; `slots` is a multicolour
 * change. P11 writes only the slots listed and keeps the rest: Edit component
 * lists every slot of its form, a BOM chip pick lists just its own slot.
 */
export interface ComponentWrite {
  fields: { description?: string; gramsUsed?: number; printMinutes?: number; quantity?: number };
  materialId: string | null;
  slots: SlotMaterialPick[] | null;
}

/** Body of PATCH /products/:id/components/:componentId (P10). */
export interface ComponentPatchBody {
  description?: string;
  gramsUsed?: number;
  printMinutes?: number;
  quantity?: number;
  materialId?: string;
  confirm?: true;
}

/** Body of PUT /products/:id/components/:componentId/materials (P11). */
export interface ComponentSlotsBody {
  slots: SlotMaterialPick[];
  confirm?: true;
}

export type ComponentWriteRequest =
  | { method: 'PATCH'; path: string; body: ComponentPatchBody }
  | { method: 'PUT'; path: string; body: ComponentSlotsBody };

function copySlots(slots: readonly SlotMaterialPick[]): SlotMaterialPick[] {
  return slots.map((s) => ({ colorIndex: s.colorIndex, materialId: s.materialId }));
}

function hasSlots(w: ComponentWrite): w is ComponentWrite & { slots: SlotMaterialPick[] } {
  return w.slots !== null && w.slots.length > 0;
}

/** The changed P10 fields, in body order, without undefined keys. */
function changedFields(f: ComponentWrite['fields']): ComponentWrite['fields'] {
  const out: ComponentWrite['fields'] = {};
  if (f.description !== undefined) out.description = f.description;
  if (f.gramsUsed !== undefined) out.gramsUsed = f.gramsUsed;
  if (f.printMinutes !== undefined) out.printMinutes = f.printMinutes;
  if (f.quantity !== undefined) out.quantity = f.quantity;
  return out;
}

/**
 * The open-line impact checks (`?dryRun=1`) a write needs: only a filament
 * change has one. [] when the write changes no filament.
 */
export function componentDryRunRequests(base: string, w: ComponentWrite): ComponentWriteRequest[] {
  const out: ComponentWriteRequest[] = [];
  if (w.materialId) out.push({ method: 'PATCH', path: `${base}?dryRun=1`, body: { materialId: w.materialId } });
  if (hasSlots(w)) out.push({ method: 'PUT', path: `${base}/materials?dryRun=1`, body: { slots: copySlots(w.slots) } });
  return out;
}

/**
 * The writes, in order: PATCH the fields and single filament, then PUT the
 * slots. `confirm` adds `confirm: true` to each (after the impact was shown);
 * without it the bodies carry no confirm key at all.
 */
export function componentWriteRequests(base: string, w: ComponentWrite, confirm: boolean): ComponentWriteRequest[] {
  const out: ComponentWriteRequest[] = [];
  const fields = changedFields(w.fields);
  const flag: { confirm?: true } = confirm ? { confirm: true } : {};
  if (Object.keys(fields).length > 0 || w.materialId) {
    out.push({ method: 'PATCH', path: base, body: { ...fields, ...(w.materialId ? { materialId: w.materialId } : {}), ...flag } });
  }
  if (hasSlots(w)) out.push({ method: 'PUT', path: `${base}/materials`, body: { slots: copySlots(w.slots), ...flag } });
  return out;
}

/** A component's own filaments, as the picker reads them. */
export interface SlotFilamentState {
  /** The server's multicolour test (slots come from `materials`). */
  multi: boolean;
  /** Single-material filament; null = no filament. */
  materialId: string | null;
  /** Multicolour slots. */
  slots: readonly SlotMaterialPick[];
}

/**
 * The write for picking `pickedId` for colour slot `colorIndex`, or null when
 * nothing would change (same filament, unknown slot, or no pick). A
 * multicolour pick sends only the picked slot: P11 keeps the others as they
 * are in the database, so a page loaded before another slot changed can't
 * put that slot back. Never mutates `state`.
 */
export function filamentPickWrite(state: SlotFilamentState, colorIndex: number, pickedId: string): ComponentWrite | null {
  if (!pickedId) return null;
  if (!state.multi) {
    if (colorIndex !== 0 || state.materialId === pickedId) return null;
    return { fields: {}, materialId: pickedId, slots: null };
  }
  const slot = state.slots.find((s) => s.colorIndex === colorIndex);
  if (!slot || slot.materialId === pickedId) return null;
  return { fields: {}, materialId: null, slots: [{ colorIndex, materialId: pickedId }] };
}

/**
 * The toast after a write: the warnings the owner must see (STOCK_REKEYED…),
 * joined, or the success text. OPEN_LINES_AFFECTED is never shown; the impact
 * list already did.
 */
export function writeResultMessage(warnings: readonly Problem[], successText: string): { tone: 'success' | 'warning'; text: string } {
  const shown = warnings.filter((w) => w.code !== 'OPEN_LINES_AFFECTED');
  return shown.length > 0
    ? { tone: 'warning', text: shown.map((w) => w.message).join(' ') }
    : { tone: 'success', text: successText };
}

// ---------------------------------------------------------------- ranking

/**
 * Grams on active spools above zero. Not stockStatus: with reorder point 0 a
 * filament with no grams is still 'ok'.
 */
export function filamentInStock(row: Pick<FilamentStockRow, 'totalStock'>): boolean {
  return Number.isFinite(row.totalStock) && row.totalStock > 0;
}

export interface FilamentChoiceQuery {
  /** Search text as typed (the Filaments list rules). */
  q: string;
  /** The slot's current material type; its rows come first. null = no grouping. */
  preferType: string | null;
  currentMaterialId: string | null;
}

export interface FilamentChoice {
  row: FilamentStockRow;
  sameType: boolean;
  inStock: boolean;
  current: boolean;
}

function cmpId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The filaments matching the search, same type as the slot first, then in
 * stock, then name A–Z, then id. The current filament keeps its place and is
 * flagged. Returns a new array; `rows` is not touched.
 */
export function rankFilamentChoices(rows: readonly FilamentStockRow[], query: FilamentChoiceQuery): FilamentChoice[] {
  const matches = filamentQueryMatcher(query.q, rows);
  const prefer = (query.preferType ?? '').trim().toUpperCase();
  return rows
    .filter(matches)
    .map((row) => ({
      row,
      sameType: prefer !== '' && String(row.type) === prefer,
      inStock: filamentInStock(row),
      current: query.currentMaterialId !== null && row.id === query.currentMaterialId,
    }))
    .sort((a, b) =>
      Number(b.sameType) - Number(a.sameType)
      || Number(b.inStock) - Number(a.inStock)
      || a.row.name.localeCompare(b.row.name, 'en', { sensitivity: 'base' })
      || cmpId(a.row.id, b.row.id));
}
