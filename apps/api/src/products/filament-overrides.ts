import { BadRequestException } from '@nestjs/common';
import { FILAMENT_TYPE_DIFFERS, shopFilamentLabel, type Problem } from '@printforge/types';
import type { FilamentOverrides } from './slicer-import-input';
import type { MatchableMaterial, SlotFilament } from './slicer-materials';

/**
 * The owner's own filament for a slot of an imported file (owner: "I should be
 * able to override on import to avoid the system creating phantom colors").
 * A chosen slot skips matching and never creates a filament; every other slot
 * is matched as before. Any existing filament may be chosen: one of another
 * material type than the file's slot is used and reported, never refused.
 */

export const UNKNOWN_FILAMENT = "A filament you chose for this import doesn't exist any more — choose another";

interface MaterialIdReader {
  material: { findMany(args: { where: { id: { in: string[] } }; select: { id: true } }): Promise<Array<{ id: string }>> };
}

/** 400 unless every chosen filament exists. Runs before a file is stored. */
export async function assertOverridesExist(db: MaterialIdReader, overrides: FilamentOverrides | undefined): Promise<void> {
  const ids = [...new Set([...(overrides?.values() ?? [])].flatMap((slots) => [...slots.values()]))];
  if (!ids.length) return;
  const found = await db.material.findMany({ where: { id: { in: ids } }, select: { id: true } });
  if (found.length !== ids.length) throw new BadRequestException(UNKNOWN_FILAMENT);
}

/**
 * The filament chosen for slot `index` of item `key`, from the import's own
 * snapshot; undefined when the slot has no override (match it as usual).
 * `warnings` gets FILAMENT_TYPE_DIFFERS when the file names another type.
 */
export function chosenMaterial<M extends MatchableMaterial>(
  materials: M[], overrides: FilamentOverrides | undefined, key: number, index: number,
  slot: SlotFilament, label: string, warnings: Problem[],
): M | undefined {
  const id = overrides?.get(key)?.get(index);
  if (!id) return undefined;
  const m = materials.find((x) => x.id === id);
  if (!m) throw new BadRequestException(UNKNOWN_FILAMENT);
  const fileType = String(slot.rawType ?? '').trim();
  if (fileType && m.type !== slot.type) {
    warnings.push({
      code: FILAMENT_TYPE_DIFFERS, materialId: m.id,
      message: `${label} slot ${index + 1}: the file prints ${fileType} but your choice ${shopFilamentLabel({ ...m, brand: m.brand ?? null })} is ${m.type} — check the filament`,
    });
  }
  return m;
}
