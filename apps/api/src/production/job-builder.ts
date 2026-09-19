import type { FilamentNeed, PlannedComponent } from '../catalog-core/production-planner.service';
import type { SpoolPick, SpoolRow } from '../catalog-core/spool-picker';

/**
 * Turns a catalog-core plan into the rows a job stores (spec §3.7 "Job
 * creation", §4.4 J5 rule 6), shared by J1 (JobsService.create) and J5
 * (JobPlanningService.createFromPlan): JobPlate rows with their per-plate slot
 * snapshot, JobMaterial lines with their planned identity, and the
 * single-plate gcodeFilename rule. Pure.
 */

export const round1 = (x: number) => Math.round(x * 10) / 10;

export interface PlateSlotSnapshot {
  colorIndex: number;
  materialId: string;
  slicedMaterialId: string | null;
  colourSlotId: string | null;
  gramsPerPlate: number;
}

/** JobPlate create data (without jobId) for the planned component groups, in plan order. */
export function plateRows(components: ReadonlyArray<PlannedComponent>) {
  const rows: any[] = [];
  let sortOrder = 0;
  for (const c of components) {
    for (const p of c.plates) {
      const slots: PlateSlotSnapshot[] = c.slots.map((s) => ({
        colorIndex: s.colorIndex,
        materialId: s.materialId,
        slicedMaterialId: s.slicedMaterialId,
        colourSlotId: s.colourSlotId,
        gramsPerPlate: Math.round((p.layout.slotGrams.get(s.colorIndex) ?? 0) * 1000) / 1000,
      }));
      rows.push({
        componentId: c.componentId,
        layoutId: p.layout.layoutId,
        colourKey: c.colourKey,
        slots,
        label: p.layout.label,
        unitsPerPlate: p.layout.unitsPerPlate,
        plateCount: p.plateCount,
        unitsRequired: c.unitsRequired,
        plateMinutes: p.layout.plateMinutes,
        plateGrams: p.layout.plateGrams,
        attachmentId: p.layout.attachmentId ?? null,
        gcodeFilename: p.layout.gcodeFilename ?? null,
        sortOrder: sortOrder++,
      });
    }
  }
  return rows;
}

/**
 * §3.7: a job carries the plate's file name only when it prints exactly one
 * physical plate (Σ plateCount === 1), so a printer bridge can never complete a
 * multi-plate job on its first plate.
 */
export function singlePlateFilename(plates: ReadonlyArray<{ plateCount: number; gcodeFilename?: string | null }>): string | null {
  const total = plates.reduce((s, p) => s + p.plateCount, 0);
  if (total !== 1) return null;
  return plates.find((p) => p.plateCount === 1)?.gcodeFilename ?? null;
}

/** First colour index each planned filament identity appears at (JobMaterial.colorIndex). */
function colourIndexOf(components: ReadonlyArray<PlannedComponent>, n: FilamentNeed): number {
  for (const c of components) {
    for (const s of c.slots) {
      if (s.materialId === n.materialId && (s.slicedMaterialId ?? null) === (n.slicedMaterialId ?? null)) return s.colorIndex;
    }
  }
  return 0;
}

/**
 * JobMaterial create data (without jobId) from the aggregated needs and their
 * spool picks: materialId = the spool's material (a substitution) or the
 * planned one; plannedMaterialId / plannedSlicedMaterialId = the planned
 * identity (never changed afterwards); slicedMaterialId = the file's own
 * filament when the colour gave the slot another one; grams to 1 dp; cost snapshot.
 */
export function materialLines(
  components: ReadonlyArray<PlannedComponent>,
  needs: ReadonlyArray<FilamentNeed>,
  picks: ReadonlyArray<SpoolPick<any, SpoolRow>>,
) {
  return needs.map((n, i) => {
    const spool = picks[i]?.spool ?? null;
    return {
      materialId: spool?.materialId ?? n.materialId,
      spoolId: spool?.id ?? null,
      gramsUsed: round1(n.grams),
      costPerGram: spool?.material?.costPerGram ?? n.material.costPerGram ?? 0,
      colorIndex: colourIndexOf(components, n),
      slicedMaterialId: n.slicedMaterialId,
      plannedMaterialId: n.materialId,
      plannedSlicedMaterialId: n.slicedMaterialId,
    };
  });
}

/** J1 `reservation`: how many lines got a spool, and which are short. */
export function reservationSummary(needs: ReadonlyArray<FilamentNeed>, picks: ReadonlyArray<SpoolPick<any, SpoolRow>>) {
  const short = picks
    .map((p, i) => ({ p, n: needs[i] }))
    .filter(({ p }) => !p.hasEnough)
    .map(({ p, n }) => ({ label: n.material.name, gramsShort: round1(Math.max(0, n.grams - (p.spool ? p.effectiveRemaining : 0))) }));
  return { lines: needs.length, withSpool: picks.filter((p) => !!p.spool).length, short };
}

/**
 * Units a completion will credit per component group (§3.6 table), for J2's
 * `creditOnComplete` and J3's `surplusByComponent`. Mirrors
 * ProductStockService.creditOnComplete.
 */
export function creditUnits(
  job: { purpose?: string | null; orderId?: string | null; stockMode?: string | null; surplusPolicy?: string | null },
  R: number,
  S: number,
): number {
  if ((job.purpose ?? 'CUSTOMER') !== 'CUSTOMER') return 0;
  const keep = job.surplusPolicy === 'KEEP_FOR_STOCK';
  if (job.orderId) return keep ? S : 0;
  if (job.stockMode === 'BUILD_STOCK') return keep ? R + S : R;
  return keep ? S : 0;
}
