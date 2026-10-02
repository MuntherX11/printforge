import { baseColourKeyOf, colourKeyHasMaterial, type OwnSlotSource } from '../stock-ledger/colour-key';

/**
 * Pure rules of a filament merge (POST /materials/:id/merge): how every place
 * that stores a material id — FK columns, colour-key strings and the JobPlate
 * slot snapshot — reads once the source id is replaced by the target id.
 *
 * Merging says "these two rows are the same physical filament", so a colour
 * key is relabelled in place (history included), and two printed-stock
 * buckets that become the same colour are added together.
 */

/** `key` with every slot of `from` relabelled `to` ("0:a|1:b" → "0:a|1:c"). */
export function renameColourKey(key: string, from: string, to: string): string {
  return key
    .split('|')
    .map((part) => {
      const i = part.indexOf(':');
      return part.slice(i + 1) === from ? `${part.slice(0, i)}:${to}` : part;
    })
    .join('|');
}

/** The component's own slots after the merge (materialId and multicolour slots relabelled). */
export function renameComponent<T extends OwnSlotSource>(c: T, from: string, to: string): T {
  return {
    ...c,
    materialId: c.materialId === from ? to : c.materialId,
    materials: c.materials.map((m) => (m.materialId === from ? { ...m, materialId: to } : m)),
  };
}

// ------------------------------------------------------------ printed stock

export interface MergeStockComponent extends OwnSlotSource {
  id: string;
}

export interface MergeStockRow {
  id: string;
  componentId: string;
  colourKey: string;
  stockOnHand: number;
}

/**
 * One change to a component's printed-stock buckets, in execution order.
 *  - rename:  the row is relabelled `to`; no other bucket has that colour, so nothing is added up.
 *  - combine: the row's units join bucket `to` (the column when `to` is the component's
 *             new base key, else the row already holding `to`); the row is deleted.
 *  - foldBase: the component's base key changed to `key`, and a row already held `key`:
 *             its units move into the column (as ProductStockService.rekeyBase does).
 */
export type MergeStockStep =
  | { kind: 'rename'; componentId: string; rowId: string; from: string; to: string }
  | { kind: 'combine'; componentId: string; rowId: string; from: string; to: string; into: 'column' | 'row'; units: number }
  | { kind: 'foldBase'; componentId: string; rowId: string; key: string; units: number };

export interface MergeStockPlan {
  steps: MergeStockStep[];
  /** Rows whose key names the source. */
  rows: number;
  /** Units held in those rows. */
  units: number;
  /** Buckets with units that join another bucket. */
  combined: number;
}

/**
 * The printed-stock steps of a merge, component by component in id order,
 * rows in key order (the order the transaction locks them). Keeps the ledger
 * invariant: no row with units holds a component's base key afterwards.
 */
export function planMergeStock(
  components: ReadonlyArray<MergeStockComponent>,
  rows: ReadonlyArray<MergeStockRow>,
  from: string,
  to: string,
): MergeStockPlan {
  const steps: MergeStockStep[] = [];
  let count = 0;
  let units = 0;
  let combined = 0;
  const sorted = [...components].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const c of sorted) {
    const oldBase = baseColourKeyOf(c);
    const newBase = baseColourKeyOf(renameComponent(c, from, to));
    const own = rows.filter((r) => r.componentId === c.id).sort((a, b) => (a.colourKey < b.colourKey ? -1 : 1));
    /** key → row as it stands after the steps so far */
    const state = new Map(own.filter((r) => !colourKeyHasMaterial(r.colourKey, from)).map((r) => [r.colourKey, r]));
    for (const r of own) {
      if (!colourKeyHasMaterial(r.colourKey, from)) continue;
      count++;
      units += Math.max(0, r.stockOnHand);
      const next = renameColourKey(r.colourKey, from, to);
      const into = next === newBase ? 'column' : state.has(next) ? 'row' : null;
      if (into) {
        if (r.stockOnHand > 0) combined++;
        steps.push({ kind: 'combine', componentId: c.id, rowId: r.id, from: r.colourKey, to: next, into, units: r.stockOnHand });
      } else {
        steps.push({ kind: 'rename', componentId: c.id, rowId: r.id, from: r.colourKey, to: next });
        state.set(next, { ...r, colourKey: next });
      }
    }
    if (oldBase !== newBase) {
      const clash = state.get(newBase);
      if (clash && clash.stockOnHand > 0) {
        combined++;
        steps.push({ kind: 'foldBase', componentId: c.id, rowId: clash.id, key: newBase, units: clash.stockOnHand });
      }
    }
  }
  return { steps, rows: count, units, combined };
}

// --------------------------------------------------------------- job lines

export interface MergeJobLine {
  id: string;
  jobId: string;
  materialId: string;
  slicedMaterialId: string | null;
  plannedMaterialId: string | null;
  plannedSlicedMaterialId: string | null;
}

type LinePatch = Partial<Pick<MergeJobLine, 'materialId' | 'slicedMaterialId' | 'plannedMaterialId' | 'plannedSlicedMaterialId'>>;

/**
 * A job line after the merge: every column naming `from` names `to`, and a
 * "sliced with" that now equals the filament it qualifies is cleared (null),
 * the way the planner writes it when the two are the same. null = untouched.
 */
export function renameJobLine(line: MergeJobLine, from: string, to: string): { next: MergeJobLine; patch: LinePatch } | null {
  const swap = (v: string | null) => (v === from ? to : v);
  const next: MergeJobLine = {
    ...line,
    materialId: swap(line.materialId)!,
    slicedMaterialId: swap(line.slicedMaterialId),
    plannedMaterialId: swap(line.plannedMaterialId),
    plannedSlicedMaterialId: swap(line.plannedSlicedMaterialId),
  };
  const touched = (['materialId', 'slicedMaterialId', 'plannedMaterialId', 'plannedSlicedMaterialId'] as const).some((k) => line[k] === from);
  if (!touched) return null;
  if (next.slicedMaterialId !== null && next.slicedMaterialId === next.materialId) next.slicedMaterialId = null;
  if (next.plannedSlicedMaterialId !== null && next.plannedSlicedMaterialId === next.plannedMaterialId) next.plannedSlicedMaterialId = null;
  const patch: LinePatch = {};
  for (const k of ['materialId', 'slicedMaterialId', 'plannedMaterialId', 'plannedSlicedMaterialId'] as const) {
    if (next[k] !== line[k]) (patch as Record<string, string | null>)[k] = next[k];
  }
  return { next, patch };
}

/**
 * Open jobs that would hold two lines with the same planned identity after
 * the merge: completion can't tell which line printed which slot, and asks
 * for the printed units to be added by hand. `lines` = every line of the
 * open jobs concerned, already renamed.
 */
export function jobsWithDoubledLines(lines: ReadonlyArray<MergeJobLine>): string[] {
  const seen = new Map<string, number>();
  for (const l of lines) {
    if (!l.plannedMaterialId) continue;
    const k = `${l.jobId}\u0000${l.plannedMaterialId}\u0000${l.plannedSlicedMaterialId ?? ''}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const jobs = new Set<string>();
  for (const [k, n] of seen) if (n > 1) jobs.add(k.split('\u0000')[0]);
  return [...jobs].sort();
}

// -------------------------------------------------------------- job plates

interface PlateSlot {
  materialId?: unknown;
  slicedMaterialId?: unknown;
  [k: string]: unknown;
}

/**
 * A JobPlate snapshot after the merge: its planned colour key relabelled and
 * every slot's materialId / slicedMaterialId swapped (a slicedMaterialId equal
 * to its slot's materialId is cleared). null = the plate doesn't name `from`.
 */
export function renameJobPlate(
  plate: { colourKey: string; slots: unknown },
  from: string,
  to: string,
): { colourKey: string; slots: unknown } | null {
  const colourKey = plate.colourKey && colourKeyHasMaterial(plate.colourKey, from) ? renameColourKey(plate.colourKey, from, to) : plate.colourKey;
  let slotsChanged = false;
  const slots = Array.isArray(plate.slots)
    ? (plate.slots as PlateSlot[]).map((s) => {
      if (!s || typeof s !== 'object' || (s.materialId !== from && s.slicedMaterialId !== from)) return s;
      slotsChanged = true;
      const materialId = s.materialId === from ? to : s.materialId;
      let slicedMaterialId = s.slicedMaterialId === from ? to : s.slicedMaterialId;
      if (slicedMaterialId != null && slicedMaterialId === materialId) slicedMaterialId = null;
      return { ...s, materialId, slicedMaterialId };
    })
    : plate.slots;
  if (colourKey === plate.colourKey && !slotsChanged) return null;
  return { colourKey, slots };
}

/** Multicolour parts that would print two of their colours in the same filament. */
export function partsWithRepeatedFilament(
  components: ReadonlyArray<{ id: string; materials: ReadonlyArray<{ materialId: string }> }>,
  from: string,
  to: string,
): number {
  let n = 0;
  for (const c of components) {
    const ids = c.materials.map((m) => (m.materialId === from ? to : m.materialId));
    const hadSource = c.materials.some((m) => m.materialId === from);
    if (hadSource && ids.filter((id) => id === to).length > 1) n++;
  }
  return n;
}
