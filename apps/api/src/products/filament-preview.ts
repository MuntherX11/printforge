import type { FilamentSlotMatch, ThreeMfAnalysis } from '@printforge/types';
import { gcodeImportTools, MATERIAL_SNAPSHOT, planFilamentSlots, type GcodeToolsSource, type MatchableMaterial, type PlanSlot } from './slicer-materials';

/**
 * The filament mapping the analysis endpoints show before an import
 * (`?matchFilaments=1`): the same slots and the same resolveSlot the import
 * uses, over a read of the filaments. Never writes.
 */

interface MaterialReader {
  material: { findMany(args: typeof MATERIAL_SNAPSHOT): Promise<MatchableMaterial[]> };
}

/** Used slots of a G-code file, as the G-code import reads them. */
export function gcodePlanSlots(a: GcodeToolsSource): PlanSlot[] {
  return gcodeImportTools(a).tools.map((t) => ({ index: t.index, rawType: t.type, rawHex: t.hex, file: t.filament }));
}

/** Used slots over every plate of a 3MF, once each, by slot index. */
export function threeMfPlanSlots(analysis: ThreeMfAnalysis): PlanSlot[] {
  const seen = new Map<number, PlanSlot>();
  for (const p of analysis.plates) {
    for (const t of p.tools) {
      if (!(t.filamentGrams > 0) || seen.has(t.index)) continue;
      seen.set(t.index, { index: t.index, rawType: t.materialType, rawHex: t.colorHex ?? null, file: t.filament ?? null });
    }
  }
  return [...seen.values()].sort((a, b) => a.index - b.index);
}

export async function previewFilamentMatches(db: MaterialReader, slots: PlanSlot[]): Promise<FilamentSlotMatch[]> {
  if (!slots.length) return [];
  return planFilamentSlots(await db.material.findMany(MATERIAL_SNAPSHOT), slots);
}
