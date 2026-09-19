import { gramsForPlan, type PlannerLayout } from '../catalog-core/plate-planner';
import { round1 } from './job-builder';

/**
 * J7 rows (spec §4.4 "J7 rules"). Per component group, with U' the units on the
 * reprinted plates: unitsRequired' = max(0, R − (U − U')) — the plates not
 * reprinted are taken to have finished first. Lines are rebuilt from the chosen
 * plates' slot snapshot by the job's policy, aggregated by planned identity and
 * mapped to the original line of that identity (keeping a colour swap, spool,
 * cost and slicedMaterialId). Legacy jobs without plates copy their lines,
 * including slicedMaterialId. Pure.
 */
export function reprintRows(original: any, counts: ReadonlyMap<string, number>, costOf: (materialId: string) => number) {
  const plates: any[] = original.plates ?? [];
  const newPlates: any[] = [];
  let lines: any[];
  if (plates.length) {
    const needs = new Map<string, { materialId: string; slicedMaterialId: string | null; colorIndex: number; grams: number }>();
    const groups = new Map<string | null, any[]>();
    for (const p of plates) groups.set(p.componentId, [...(groups.get(p.componentId) ?? []), p]);
    for (const rows of groups.values()) {
      const R = rows[0].unitsRequired;
      const U = rows.reduce((s, r) => s + r.unitsPerPlate * r.plateCount, 0);
      const chosen = rows.filter((r) => counts.has(r.id));
      if (!chosen.length) continue;
      const Uc = chosen.reduce((s, r) => s + r.unitsPerPlate * counts.get(r.id)!, 0);
      const Rn = Math.max(0, R - (U - Uc));
      const plan = chosen.map((r) => ({
        plateCount: counts.get(r.id)!,
        layout: {
          layoutId: r.layoutId, label: r.label, unitsPerPlate: r.unitsPerPlate, plateMinutes: r.plateMinutes, plateGrams: r.plateGrams,
          slotGrams: new Map<number, number>((r.slots as any[]).map((s) => [s.colorIndex, s.gramsPerPlate ?? 0])),
        } as PlannerLayout,
      }));
      for (const s of (chosen[0].slots as any[]) ?? []) {
        const g = gramsForPlan(plan, s.colorIndex, Rn, (original.surplusPolicy ?? 'KEEP_FOR_STOCK') as any);
        const key = `${s.materialId}|${s.slicedMaterialId ?? ''}`;
        const n = needs.get(key) ?? { materialId: s.materialId, slicedMaterialId: s.slicedMaterialId ?? null, colorIndex: s.colorIndex, grams: 0 };
        n.grams += g;
        needs.set(key, n);
      }
      for (const r of chosen) {
        const { id: _id, jobId: _j, createdAt: _c, ...copy } = r;
        newPlates.push({ ...copy, plateCount: counts.get(r.id)!, unitsRequired: Rn });
      }
    }
    lines = [...needs.values()].filter((n) => n.grams > 0).map((n) => {
      const orig = original.materials.find(
        (m: any) => m.plannedMaterialId === n.materialId && (m.plannedSlicedMaterialId ?? null) === n.slicedMaterialId,
      );
      return orig
        ? {
            materialId: orig.materialId, spoolId: orig.spoolId, costPerGram: orig.costPerGram, colorIndex: orig.colorIndex,
            slicedMaterialId: orig.slicedMaterialId, plannedMaterialId: orig.plannedMaterialId, plannedSlicedMaterialId: orig.plannedSlicedMaterialId,
            gramsUsed: round1(n.grams),
          }
        : {
            materialId: n.materialId, spoolId: null, costPerGram: costOf(n.materialId), colorIndex: n.colorIndex,
            slicedMaterialId: n.slicedMaterialId, plannedMaterialId: n.materialId, plannedSlicedMaterialId: n.slicedMaterialId,
            gramsUsed: round1(n.grams),
          };
    });
  } else {
    lines = original.materials.map((m: any) => ({
      materialId: m.materialId, spoolId: m.spoolId, gramsUsed: m.gramsUsed, costPerGram: m.costPerGram, colorIndex: m.colorIndex,
      slicedMaterialId: m.slicedMaterialId, plannedMaterialId: m.plannedMaterialId, plannedSlicedMaterialId: m.plannedSlicedMaterialId,
    }));
  }

  return { newPlates, lines };
}
