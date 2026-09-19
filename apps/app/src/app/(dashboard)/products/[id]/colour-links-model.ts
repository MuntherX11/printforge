/**
 * Unsaved grid state of ColourLinksDialog (spec §5.1, §5.2 C, §3.3) and its
 * conversion to one C4 batch. Pure functions; the dialog owns the state.
 */
import type { ApiColourLinkInput, ApiColourLinkProposal, MaterialLite, ProductDetail } from '@/lib/types/api';
import { isMultiColour, orderedSizes, standardSizeLabel } from './options-model';

/** Row value: `slot:<id>` (saved slot), `ref:<ref>` (new slot), FIXED or NONE (unlinked). */
export type LinkValue = string;
export const FIXED = 'FIXED';
export const NONE = 'NONE';

export interface GridSlot {
  /** `slot:<id>` or `ref:<ref>`. */
  key: string;
  id: string | null;
  ref: string | null;
  name: string;
  /** Saved name (null for a new slot). */
  savedName: string | null;
}

export interface GridRow {
  key: string;
  componentId: string;
  colorIndex: number;
  sizeLabel: string;
  part: string;
  material: MaterialLite | null;
  initial: LinkValue;
}

export interface GridState {
  slots: GridSlot[];
  values: Record<string, LinkValue>;
  nextRef: number;
}

export const MAX_SLOTS = 12;

export function rowKey(componentId: string, colorIndex: number): string {
  return `${componentId}:${colorIndex}`;
}

/** DOM id of a grid row, for the `focus` scroll. */
export function rowDomId(componentId: string, colorIndex: number): string {
  return `colour-link-row-${componentId}-${colorIndex}`;
}

function valueOf(colourSlotId: string | null, fixed: boolean): LinkValue {
  return colourSlotId ? `slot:${colourSlotId}` : fixed ? FIXED : NONE;
}

/** Every component material slot of every size (standard first), in BOM order. */
export function buildRows(p: ProductDetail): GridRow[] {
  const groups = [
    { label: standardSizeLabel(p), components: p.components },
    ...orderedSizes(p).map(s => ({ label: s.isActive ? s.name : `${s.name} (inactive)`, components: s.components })),
  ];
  const rows: GridRow[] = [];
  for (const g of groups) {
    for (const c of [...g.components].sort((a, b) => a.sortOrder - b.sortOrder)) {
      if (isMultiColour(c)) {
        for (const m of [...c.materials].sort((a, b) => a.colorIndex - b.colorIndex)) {
          rows.push({
            key: rowKey(c.id, m.colorIndex), componentId: c.id, colorIndex: m.colorIndex, sizeLabel: g.label,
            part: `${c.description} colour ${m.colorIndex + 1}`, material: m.material, initial: valueOf(m.colourSlotId, m.colourFixed),
          });
        }
      } else if (c.materialId) {
        rows.push({
          key: rowKey(c.id, 0), componentId: c.id, colorIndex: 0, sizeLabel: g.label,
          part: c.description, material: c.material, initial: valueOf(c.colourSlotId, c.colourFixed),
        });
      }
    }
  }
  return rows;
}

export function initialState(p: ProductDetail, rows: GridRow[]): GridState {
  return {
    slots: [...p.colourSlots].sort((a, b) => a.sortOrder - b.sortOrder)
      .map(s => ({ key: `slot:${s.id}`, id: s.id, ref: null, name: s.name, savedName: s.name })),
    values: Object.fromEntries(rows.map(r => [r.key, r.initial])),
    nextRef: 1,
  };
}

export function addSlot(state: GridState, name: string): GridState {
  const ref = `n${state.nextRef}`;
  return { ...state, slots: [...state.slots, { key: `ref:${ref}`, id: null, ref, name, savedName: null }], nextRef: state.nextRef + 1 };
}

/** Removes an unsaved slot; rows that used it become unlinked again. */
export function removeNewSlot(state: GridState, key: string): GridState {
  const values = Object.fromEntries(Object.entries(state.values).map(([k, v]) => [k, v === key ? NONE : v]));
  return { ...state, slots: state.slots.filter(s => s.key !== key), values };
}

/**
 * Loads the C5 proposal into the unsaved grid. It only fills rows that are
 * still unlinked here (the owner's unsaved choices win), reuses a slot of the
 * same name (ignoring case), and adds only the new slots something uses.
 */
export function applyProposal(state: GridState, proposal: ApiColourLinkProposal): { state: GridState; filled: number } {
  let next = { ...state, slots: [...state.slots], values: { ...state.values } };
  const refKeys = new Map<string, string>();
  const keyForRef = (ref: string): string | null => {
    if (refKeys.has(ref)) return refKeys.get(ref)!;
    const proposed = proposal.newSlots.find(s => s.ref === ref);
    if (!proposed) return null;
    const same = next.slots.find(s => s.name.trim().toLowerCase() === proposed.name.trim().toLowerCase());
    if (same) { refKeys.set(ref, same.key); return same.key; }
    next = addSlot(next, proposed.name.slice(0, 40));
    const key = next.slots[next.slots.length - 1].key;
    refKeys.set(ref, key);
    return key;
  };
  let filled = 0;
  for (const l of proposal.links) {
    const k = rowKey(l.componentId, l.colorIndex);
    if (next.values[k] !== NONE) continue;
    const v = l.fixed ? FIXED : l.colourSlotId ? `slot:${l.colourSlotId}` : l.slotRef ? keyForRef(l.slotRef) : null;
    if (!v) continue;
    next.values[k] = v;
    filled++;
  }
  return { state: next, filled };
}

export function validateSlots(state: GridState): string | null {
  if (state.slots.length > MAX_SLOTS) return `A product can have at most ${MAX_SLOTS} colour slots`;
  const seen = new Set<string>();
  for (const s of state.slots) {
    const n = s.name.trim();
    if (n.length < 1 || n.length > 40) return 'Each colour slot needs a name of 1 to 40 characters';
    const k = n.toLowerCase();
    if (seen.has(k)) return `Two colour slots are named "${n}"`;
    seen.add(k);
  }
  return null;
}

/** The C4 body for everything changed in the grid; null when nothing changed. */
export type SlotPayload = { id: string; name: string } | { ref: string; name: string };

export function buildPayload(state: GridState, rows: GridRow[]): { slots: SlotPayload[]; links: ApiColourLinkInput[] } | null {
  const slots = state.slots.flatMap((s): SlotPayload[] => {
    const name = s.name.trim();
    if (s.id) return name !== s.savedName ? [{ id: s.id, name }] : [];
    return [{ ref: s.ref as string, name }];
  });
  const links: ApiColourLinkInput[] = [];
  for (const r of rows) {
    const v = state.values[r.key] ?? r.initial;
    if (v === r.initial) continue;
    const base = { componentId: r.componentId, colorIndex: r.colorIndex };
    if (v === FIXED) links.push({ ...base, fixed: true });
    else if (v === NONE) links.push({ ...base, colourSlotId: null });
    else if (v.startsWith('slot:')) links.push({ ...base, colourSlotId: v.slice(5) });
    else links.push({ ...base, slotRef: v.slice(4) });
  }
  return slots.length || links.length ? { slots, links } : null;
}

export function unlinkedCount(state: GridState): number {
  return Object.values(state.values).filter(v => v === NONE).length;
}
