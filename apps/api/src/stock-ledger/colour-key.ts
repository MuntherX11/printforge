import { BadRequestException } from '@nestjs/common';

/**
 * Colour keys (spec §0.3): the physical colours of one printed unit of a
 * component, as sorted `colorIndex:materialId` pairs joined by `|`.
 *
 *   single-material Box in PLA Red      -> "0:<PLA Red id>"
 *   Fish in White (0) and Silk Orange (1) -> "0:<White id>|1:<Orange id>"
 *
 * Stock is keyed by physical colour, never by option, so two colour options
 * that give a component the same filament share one bucket.
 */

export interface ColourKeySlot {
  colorIndex: number;
  materialId: string;
}

/** Material ids are cuids (or test ids): no separators, no whitespace. */
const MATERIAL_ID = /^[A-Za-z0-9_-]+$/;

export function colourKeyOf(slots: ReadonlyArray<ColourKeySlot>): string {
  const seen = new Set<number>();
  const sorted = [...slots].sort((a, b) => a.colorIndex - b.colorIndex);
  for (const s of sorted) {
    if (!Number.isInteger(s.colorIndex) || s.colorIndex < 0) {
      throw new BadRequestException(`Colour index ${s.colorIndex} is not valid`);
    }
    if (seen.has(s.colorIndex)) {
      throw new BadRequestException(`Colour index ${s.colorIndex} appears twice`);
    }
    if (!s.materialId || !MATERIAL_ID.test(s.materialId)) {
      throw new BadRequestException(`Colour ${s.colorIndex + 1} has no valid filament`);
    }
    seen.add(s.colorIndex);
  }
  return sorted.map((s) => `${s.colorIndex}:${s.materialId}`).join('|');
}

/**
 * A component's own (as-sliced) slots. Multicolour = it has ComponentMaterial
 * rows and is flagged multicolour (or has no single material at all); every
 * other component is one slot at colour index 0. The resolver and the stock
 * ledger both use this, so they always agree on the base key.
 */
export interface OwnSlotSource {
  materialId: string | null;
  isMultiColor: boolean;
  materials: ReadonlyArray<{ colorIndex: number; materialId: string }>;
}

export function isMultiColourComponent(c: OwnSlotSource): boolean {
  return c.materials.length > 0 && (c.isMultiColor || !c.materialId);
}

export function ownSlotsOf(c: OwnSlotSource): ColourKeySlot[] {
  if (isMultiColourComponent(c)) {
    return c.materials.map((m) => ({ colorIndex: m.colorIndex, materialId: m.materialId }));
  }
  return c.materialId ? [{ colorIndex: 0, materialId: c.materialId }] : [];
}

/** Base colour key of a component: the key of its own filaments ('' when it has none). */
export function baseColourKeyOf(c: OwnSlotSource): string {
  return colourKeyOf(ownSlotsOf(c));
}

/** Inverse of colourKeyOf. Rejects anything colourKeyOf could not have produced. */
export function parseColourKey(key: string): ColourKeySlot[] {
  if (typeof key !== 'string' || key.length === 0 || key.length > 2000) {
    throw new BadRequestException('Invalid colour key');
  }
  const slots: ColourKeySlot[] = [];
  for (const part of key.split('|')) {
    const m = /^(\d{1,3}):([A-Za-z0-9_-]+)$/.exec(part);
    if (!m) throw new BadRequestException('Invalid colour key');
    slots.push({ colorIndex: Number(m[1]), materialId: m[2] });
  }
  for (let i = 1; i < slots.length; i++) {
    if (slots[i].colorIndex <= slots[i - 1].colorIndex) {
      throw new BadRequestException('Invalid colour key');
    }
  }
  return slots;
}

/** True when `key` contains the material (used by the filament delete guard). */
export function colourKeyHasMaterial(key: string, materialId: string): boolean {
  return key.split('|').some((p) => p.slice(p.indexOf(':') + 1) === materialId);
}

/**
 * Human label for a key: filament names in colour-index order, joined by " + ",
 * a name repeated on several slots shown once. `PLA Red`, `White + Silk Orange`.
 */
export function colourLabel(
  key: string,
  materials: ReadonlyMap<string, { name: string }> | ((id: string) => { name: string } | undefined),
): string {
  const lookup = typeof materials === 'function' ? materials : (id: string) => materials.get(id);
  const names: string[] = [];
  for (const s of parseColourKey(key)) {
    const name = lookup(s.materialId)?.name ?? 'Unknown filament';
    if (!names.includes(name)) names.push(name);
  }
  return names.join(' + ');
}
