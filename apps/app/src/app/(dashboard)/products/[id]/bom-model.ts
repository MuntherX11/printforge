/**
 * Pure helpers for section D (bill of materials, spec §5.2 D) and E (plate
 * layouts). No React, no fetching.
 */
import type { ComponentDetail, MaterialLite, ProductDetail } from '@/lib/types/api';
import { STANDARD_KEY, isMultiColour, orderedSizes, standardSizeLabel } from './options-model';

/** The components section D shows for a scope ('standard' or a size id). */
export function componentsInScope(p: ProductDetail, scope: string): ComponentDetail[] {
  const list = scope === STANDARD_KEY ? p.components : p.sizes.find(s => s.id === scope)?.components ?? [];
  return [...list].sort((a, b) => a.sortOrder - b.sortOrder);
}

export function scopeSizeOptionId(scope: string): string | null {
  return scope === STANDARD_KEY ? null : scope;
}

export function scopeLabel(p: ProductDetail, scope: string): string {
  if (scope === STANDARD_KEY) return standardSizeLabel(p);
  return p.sizes.find(s => s.id === scope)?.name ?? 'Unknown size';
}

/** Scope select entries: the standard size, then every size (inactive ones marked). */
export function scopeOptions(p: ProductDetail): Array<{ value: string; label: string }> {
  return [
    { value: STANDARD_KEY, label: standardSizeLabel(p) },
    ...orderedSizes(p).map(s => ({ value: s.id, label: s.isActive ? s.name : `${s.name} (inactive)` })),
  ];
}

export type LinkState = { kind: 'slot'; name: string } | { kind: 'fixed' } | { kind: 'unlinked' };

export interface SlotView {
  colorIndex: number;
  material: MaterialLite | null;
  /** Grams per unit of this slot. */
  grams: number;
  link: LinkState;
}

function linkOf(p: ProductDetail, colourSlotId: string | null, colourFixed: boolean): LinkState {
  if (colourSlotId) return { kind: 'slot', name: p.colourSlots.find(s => s.id === colourSlotId)?.name ?? 'Unknown slot' };
  return colourFixed ? { kind: 'fixed' } : { kind: 'unlinked' };
}

/** One entry per component material slot (colour index 0 of a single-material part). */
export function slotViews(p: ProductDetail, c: ComponentDetail): SlotView[] {
  if (isMultiColour(c)) {
    return [...c.materials]
      .sort((a, b) => a.colorIndex - b.colorIndex)
      .map(m => ({ colorIndex: m.colorIndex, material: m.material, grams: m.gramsUsed, link: linkOf(p, m.colourSlotId, m.colourFixed) }));
  }
  return [{ colorIndex: 0, material: c.material, grams: c.gramsUsed, link: linkOf(p, c.colourSlotId, c.colourFixed) }];
}

/** Every filament the product references (own and assigned), for swatches by material id. */
export function materialIndex(p: ProductDetail): Map<string, MaterialLite> {
  const out = new Map<string, MaterialLite>();
  const all = [...p.components, ...p.sizes.flatMap(s => s.components)];
  for (const c of all) {
    if (c.material) out.set(c.material.id, c.material);
    for (const m of c.materials) out.set(m.material.id, m.material);
  }
  for (const col of p.colours) for (const a of col.assignments) out.set(a.material.id, a.material);
  return out;
}

/** Swatch colours of a colour key (`0:matA|1:matB`). */
export function colourKeyHexes(key: string, materials: Map<string, MaterialLite>): Array<string | null> {
  return key.split('|').map(part => materials.get(part.split(':')[1] ?? '')?.colorHex ?? null);
}

/** Σ grams and minutes of one product unit, over the scope's components. */
export function perProductTotals(components: ComponentDetail[]): { grams: number; minutes: number } {
  return components.reduce(
    (t, c) => ({ grams: t.grams + c.gramsUsed * c.quantity, minutes: t.minutes + c.printMinutes * c.quantity }),
    { grams: 0, minutes: 0 },
  );
}

/** "−40 % time/unit" against the component's single-unit time; null when there is nothing to compare. */
export function vsSingle(minutesPerUnit: number, singleMinutes: number): string | null {
  if (!(singleMinutes > 0) || !Number.isFinite(minutesPerUnit)) return null;
  const pct = ((minutesPerUnit - singleMinutes) / singleMinutes) * 100;
  if (Math.abs(pct) < 0.5) return 'same time/unit';
  return `${pct < 0 ? '−' : '+'}${Math.abs(Math.round(pct))} % time/unit`;
}

/** Parse a whole number within bounds from an input string; null when invalid. */
export function parseWhole(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

/** Parse a decimal within bounds from an input string; null when invalid. */
export function parseDecimal(raw: string, min: number, max: number): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
