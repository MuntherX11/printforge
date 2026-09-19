import { BadRequestException } from '@nestjs/common';
import type { Problem } from '@printforge/types';
import { compareComponents } from './catalog-config';

/**
 * Colour-link starting points (spec §3.3 "Link proposal", §3.12 "Colour links on
 * import"). Pure: nothing here writes; the owner edits the proposal before one
 * C4 save, and imports apply the decisions inside their own transaction.
 */

export const MAX_COLOUR_SLOTS = 12;

export interface LinkSlot {
  colorIndex: number;
  /** own (as-sliced) material */
  materialId: string;
  colourSlotId: string | null;
  colourFixed: boolean | null;
}

export interface LinkComponent {
  id: string;
  description: string;
  variantId: string | null;
  sortOrder: number;
  createdAt: Date;
  /** multicolour (several own slots) */
  isMultiColor: boolean;
  slots: LinkSlot[];
}

export type LinkTarget = { colourSlotId: string } | { ref: string } | 'FIXED';

export interface LinkProposal {
  newSlots: Array<{ ref: string; name: string }>;
  links: Array<{ componentId: string; colorIndex: number; colourSlotId?: string; ref?: string; fixed?: true }>;
}

const decided = (s: LinkSlot) => !!s.colourSlotId || s.colourFixed === true;
const isFixed = (s: LinkSlot) => !s.colourSlotId && s.colourFixed === true;

/** C5 `GET /products/:id/colour-links/proposal`: link by filament. */
export function proposeLinks(input: {
  components: LinkComponent[];
  colourSlots: Array<{ id: string; name: string }>;
  materials: ReadonlyMap<string, { name: string }>;
}): LinkProposal {
  const comps = [...input.components].sort(compareComponents);
  const all = comps.flatMap((c) => c.slots.map((s) => ({ c, s })));
  const unlinked = all.filter(({ s }) => !decided(s));
  const singleMats = new Set(comps.filter((c) => !c.isMultiColor).flatMap((c) => c.slots.map((s) => s.materialId)));

  const order: string[] = [];
  for (const { s } of [...unlinked].sort((a, b) => compareComponents(a.c, b.c) || a.s.colorIndex - b.s.colorIndex)) {
    if (!order.includes(s.materialId)) order.push(s.materialId);
  }

  const newSlots: LinkProposal['newSlots'] = [];
  const links: LinkProposal['links'] = [];
  for (const m of order) {
    const targets = unlinked.filter(({ s }) => s.materialId === m);
    const decidedWithM = all.filter(({ s }) => decided(s) && s.materialId === m);
    const fixed = (decidedWithM.length > 0 && decidedWithM.every(({ s }) => isFixed(s))) || !singleMats.has(m);
    if (fixed) {
      for (const { c, s } of targets) links.push({ componentId: c.id, colorIndex: s.colorIndex, fixed: true });
      continue;
    }
    const name = (input.materials.get(m)?.name ?? 'Colour').slice(0, 40);
    const existing = input.colourSlots.find((x) => x.name.toLowerCase() === name.toLowerCase());
    let target: { colourSlotId?: string; ref?: string };
    if (existing) target = { colourSlotId: existing.id };
    else {
      let ns = newSlots.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!ns) {
        ns = { ref: `new-${newSlots.length + 1}`, name };
        newSlots.push(ns);
      }
      target = { ref: ns.ref };
    }
    for (const { c, s } of targets) links.push({ componentId: c.id, colorIndex: s.colorIndex, ...target });
  }

  const total = input.colourSlots.length + newSlots.length;
  if (total > MAX_COLOUR_SLOTS) {
    throw new BadRequestException(`Link by filament would need ${total} colour slots (maximum 12) — link some parts by hand first`);
  }
  return { newSlots, links };
}

export interface ImportedSlot {
  /** new component's temporary id (or real id once created) */
  componentKey: string;
  description: string;
  colorIndex: number;
  materialId: string;
  materialType: string;
  /** the new component has several used colours */
  isMultiColor: boolean;
  /** 0-based rank of the new component among its size's components, by sortOrder */
  rank: number;
}

export interface ImportDecision {
  componentKey: string;
  colorIndex: number;
  colourSlotId: string | null;
  colourFixed: boolean | null;
  how: 'FILAMENT' | 'POSITION' | 'NONE';
}

/**
 * §3.12: each new slot takes a decision from the product's already-decided slots
 * (all sizes): by filament, then (imports onto a SIZE only) by position, else it
 * stays unlinked with a warning. Imports never create colour slots, and a product
 * without colour slots leaves everything unlinked.
 */
export function decideImportLinks(input: {
  newSlots: ImportedSlot[];
  existing: LinkComponent[];
  colourSlots: Array<{ id: string; name: string }>;
  materials: ReadonlyMap<string, { name: string; type: string }>;
  /** the target size's name when importing onto a SIZE; null for the standard size */
  targetSize: { id: string; name: string } | null;
  standardSizeLabel: string;
}): { decisions: ImportDecision[]; warnings: Problem[] } {
  const decisions: ImportDecision[] = [];
  const warnings: Problem[] = [];
  const byPosition: string[] = [];
  const slotName = (id: string) => input.colourSlots.find((s) => s.id === id)?.name ?? 'colour slot';
  if (input.colourSlots.length === 0) {
    return { decisions: input.newSlots.map((s) => ({ componentKey: s.componentKey, colorIndex: s.colorIndex, colourSlotId: null, colourFixed: null, how: 'NONE' })), warnings };
  }
  const decidedAll = input.existing.flatMap((c) => c.slots.filter(decided).map((s) => ({ c, s })));
  const standard = input.existing.filter((c) => c.variantId === null).sort(compareComponents);

  for (const ns of input.newSlots) {
    const same = decidedAll.filter(({ s }) => s.materialId === ns.materialId);
    const linkedTo = new Set(same.map(({ s }) => s.colourSlotId ?? '#FIXED'));
    let d: ImportDecision | null = null;
    if (same.length && linkedTo.size === 1) {
      const only = [...linkedTo][0];
      d = { componentKey: ns.componentKey, colorIndex: ns.colorIndex, colourSlotId: only === '#FIXED' ? null : only, colourFixed: only === '#FIXED' ? true : null, how: 'FILAMENT' };
    }
    if (!d && input.targetSize) {
      const peer = standard[ns.rank];
      const ps = peer?.slots.find((s) => s.colorIndex === ns.colorIndex);
      const peerType = ps ? input.materials.get(ps.materialId)?.type : undefined;
      if (ps && decided(ps) && peerType !== undefined && peerType === ns.materialType) {
        d = { componentKey: ns.componentKey, colorIndex: ns.colorIndex, colourSlotId: ps.colourSlotId, colourFixed: ps.colourSlotId ? null : true, how: 'POSITION' };
        const where = ns.isMultiColor ? `${ns.description} colour ${ns.colorIndex + 1}` : ns.description;
        byPosition.push(`${where} → ${ps.colourSlotId ? slotName(ps.colourSlotId) : 'Fixed'}`);
      }
    }
    if (!d) {
      d = { componentKey: ns.componentKey, colorIndex: ns.colorIndex, colourSlotId: null, colourFixed: null, how: 'NONE' };
      const mat = input.materials.get(ns.materialId)?.name ?? 'Unknown filament';
      warnings.push({
        code: 'COLOUR_SLOT_NOT_LINKED',
        message: `"${ns.description}" colour ${ns.colorIndex + 1} (${mat}) isn't linked to a colour slot — colours won't change it and won't be offered on ${input.targetSize?.name ?? input.standardSizeLabel} in the shop; link it in Edit links`,
      });
    }
    decisions.push(d);
  }
  if (byPosition.length) {
    warnings.unshift({
      code: 'COLOUR_LINKED_BY_POSITION',
      message: `${byPosition.length} parts linked by position (${byPosition.join(', ')}) — check them in Edit links`,
    });
  }
  return { decisions, warnings };
}
