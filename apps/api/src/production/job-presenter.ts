import type { BomResolverService, ResolvedBom } from '../catalog-core/bom-resolver.service';
import type { CatalogRequestContext } from '../catalog-core/catalog-context';
import { pairLabel } from '../catalog-core/option-pair';
import type { ProductionPlannerService } from '../catalog-core/production-planner.service';
import { pickSpools } from '../catalog-core/spool-picker';
import { creditUnits, round1 } from './job-builder';

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];

/**
 * J3 read model (spec §4.4 J3): the job's pair from effectiveOptions (so a
 * pre-release job shows its reclassified option), its plates, the surplus and
 * credit per component, and the picking list.
 */

export async function jobDetailExtras(job: any, resolver: BomResolverService, ctx: CatalogRequestContext) {
  await resolver.preloadVariants([job.variantId, job.sizeOptionId, job.colourOptionId].filter(Boolean), ctx);
  if (job.orderItemId) await resolver.preloadOrderItems([job.orderItemId], ctx);
  const eff = resolver.effectiveOptions(job, ctx);
  const sizeOptionId = eff.skip ? null : eff.sizeOptionId;
  const colourOptionId = eff.skip ? null : eff.colourOptionId;
  const opt = (id: string | null) => {
    if (!id) return null;
    const v = ctx.variants.get(id);
    return v ? { id: v.id, name: v.name ?? '' } : null;
  };
  const size = opt(sizeOptionId);
  const colour = opt(colourOptionId);

  const productId = job.productId ?? job.orderItem?.productId ?? null;
  let bom: ResolvedBom | null = null;
  let optionLabel: string | null = null;
  if (productId) {
    const config = await resolver.loadConfig(productId, ctx);
    if (config) {
      const sizeRow = sizeOptionId ? config.options.find((o) => o.id === sizeOptionId) ?? null : null;
      const colourRow = colourOptionId ? config.options.find((o) => o.id === colourOptionId) ?? null : null;
      optionLabel = pairLabel(config, sizeRow, colourRow);
      try {
        bom = resolver.resolveWithConfig(config, { sizeOptionId: sizeRow?.id ?? null, colourOptionId: colourRow?.id ?? null });
      } catch {
        bom = null;
      }
    }
  }

  const plates = (job.plates ?? []).map((p: any) => ({
    id: p.id,
    componentId: p.componentId,
    componentDescription: bom?.components.find((c) => c.componentId === p.componentId)?.description ?? p.label,
    label: p.label,
    unitsPerPlate: p.unitsPerPlate,
    plateCount: p.plateCount,
    unitsRequired: p.unitsRequired,
    plateMinutes: p.plateMinutes,
    plateGrams: p.plateGrams,
    gcodeFilename: p.gcodeFilename,
    downloadUrl: p.attachmentId ? `/api/attachments/${p.attachmentId}/download` : null,
  }));

  const groups = new Map<string | null, any[]>();
  for (const p of plates) groups.set(p.componentId, [...(groups.get(p.componentId) ?? []), p]);
  const surplusByComponent = [...groups.entries()].map(([componentId, rows]) => {
    const unitsRequired = rows[0].unitsRequired;
    const unitsPrinted = rows.reduce((s: number, r: any) => s + r.unitsPerPlate * r.plateCount, 0);
    const surplus = Math.max(0, unitsPrinted - unitsRequired);
    return {
      componentId,
      description: rows[0].componentDescription,
      unitsRequired,
      unitsPrinted,
      surplus,
      creditOnComplete: componentId ? creditUnits(job, unitsRequired, surplus) : 0,
    };
  });

  return {
    bom,
    detail: {
      size,
      colour,
      optionLabel,
      surplusPolicy: job.surplusPolicy ?? null,
      stockMode: job.stockMode ?? null,
      plates,
      surplusByComponent,
    },
  };
}

const label = (m: any) => [m?.color, m?.type, m?.brand].filter(Boolean).join(' · ') || m?.name || 'Unknown filament';

/**
 * What to load into the printer. Assigned lines are reported as they are (with
 * `optionColour` when the job's colour gave the slot another filament than the
 * file's, and `swapped` when the line was recoloured after planning);
 * `substituted` is judged against the resolved pair's BOM. A job without lines
 * shows the suggestion the planner would make.
 */
export async function buildFilamentPlan(job: any, bom: ResolvedBom | null, planner: ProductionPlannerService, ctx: CatalogRequestContext) {
  const fmt = (m: any, spool: any, grams: number, assigned: boolean, enough: boolean) => ({
    materialId: m?.id ?? null,
    colour: m?.color ?? null,
    type: m?.type ?? null,
    brand: m?.brand ?? null,
    // "White · PLA · eSUN" — how it reads on the shelf
    label: label(m),
    gramsNeeded: round1(grams),
    spoolId: spool?.id ?? null,
    spoolRef: spool?.printforgeId ?? null,
    location: spool?.location?.name ?? null,
    spoolRemaining: spool ? Math.round(spool.currentWeight) : null,
    assigned,
    hasEnough: enough,
  });

  if (job.materials?.length) {
    const wanted = new Set<string>(bom ? bom.components.flatMap((c) => c.slots.map((s) => s.materialId)) : []);
    return job.materials.map((jm: any) => ({
      ...fmt(jm.material, jm.spool, jm.gramsUsed, true, jm.spool ? jm.spool.currentWeight >= jm.gramsUsed : false),
      lineId: jm.id,
      substituted: wanted.size > 0 && !wanted.has(jm.materialId),
      overridden: !!jm.slicedMaterialId && jm.slicedMaterialId !== jm.materialId,
      optionColour: !!jm.plannedSlicedMaterialId,
      swapped: !!jm.plannedMaterialId && jm.materialId !== jm.plannedMaterialId,
      slicedColour: jm.slicedMaterial ? [jm.slicedMaterial.color, jm.slicedMaterial.type].filter(Boolean).join(' ') : null,
    }));
  }

  if (!bom || !job.productId || TERMINAL.includes(job.status)) return [];
  const plan = await planner.planOption(
    { productId: bom.productId, sizeOptionId: bom.sizeOptionId, colourOptionId: bom.colourOptionId, quantity: job.quantityToProduce || 1 },
    ctx,
  ).catch(() => null);
  if (!plan) return [];
  const needs = plan.filamentNeeds;
  const picks = pickSpools(needs, await planner.spoolsFor(needs), { reservedBySpool: await planner.reservedBySpool() });
  return picks.map((p) => ({
    ...fmt(p.spool?.material ?? p.material, p.spool, p.grams, false, p.hasEnough),
    substituted: p.substituted,
  }));
}

