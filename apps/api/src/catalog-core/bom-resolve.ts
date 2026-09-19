import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { MaterialLite, Problem } from '@printforge/types';
import { colourKeyOf, isMultiColourComponent } from '../stock-ledger/colour-key';
import type { ComponentRow, OptionRow, ProductConfig } from './catalog-config';
import { pairLabel, standardColourLabel, standardSizeLabel } from './option-pair';
import type { PlannerLayout } from './plate-planner';

/**
 * The pure half of the BOM resolver (spec §3.2): (config, pair) → ResolvedBom.
 * Resolution is split into a size stage (components, layouts, per-component
 * problems) memoised on the config, and a colour stage that only re-maps slot
 * materials. Cell costs and the bulk floor resolve hundreds of pairs this way
 * without reloading anything.
 */

export interface ResolvedSlot {
  colorIndex: number;
  materialId: string;
  material: MaterialLite;
  gramsPerUnit: number;
  /** own (as-sliced) material */
  baseMaterialId: string;
  /** link; null = fixed or unlinked */
  colourSlotId: string | null;
  colourSlotName: string | null;
  /** colourSlotId null and colourFixed not true (§0.3) */
  unlinked: boolean;
  /** true when the colour option changed this slot */
  assigned: boolean;
}

export interface ResolvedLayout extends PlannerLayout {
  layoutId: string | null;
  label: string;
  unitsPerPlate: number;
  plateMinutes: number;
  plateGrams: number;
  slotGrams: Map<number, number>;
  attachmentId: string | null;
  gcodeFilename: string | null;
  colorChanges: number;
}

export interface ResolvedComponent {
  componentId: string;
  description: string;
  variantId: string | null;
  sortOrder: number;
  isMultiColor: boolean;
  quantity: number;
  gramsPerUnit: number;
  minutesPerUnit: number;
  colorChanges: number;
  attachmentId: string | null;
  gcodeFilename: string | null;
  slots: ResolvedSlot[];
  layouts: ResolvedLayout[];
  /** inactive explicit layouts (validatePlan names them) */
  inactiveLayoutIds: string[];
  colourKey: string;
  baseColourKey: string;
  /** balance of the bucket for colourKey (the column when colourKey === baseColourKey) */
  stockOnHand: number;
  stockConfirmedAt: Date | null;
  perUnitEstimated: boolean;
}

export interface ResolvedPart {
  partId: string;
  name: string;
  quantity: number;
  unitCost: number;
  isActive: boolean;
}

export interface ResolvedBom {
  productId: string;
  sizeOptionId: string | null;
  colourOptionId: string | null;
  sizeLabel: string;
  colourLabel: string;
  label: string;
  fallbackToBase: boolean;
  components: ResolvedComponent[];
  parts: ResolvedPart[];
  hasSlicerComponent: boolean;
  productColorChanges: number;
  complete: boolean;
  productionReady: boolean;
  problems: Problem[];
  warnings: Problem[];
}

interface SizeStage {
  size: OptionRow | null;
  fallbackToBase: boolean;
  components: Array<{ row: ComponentRow; resolved: ResolvedComponent }>;
  problems: Problem[];
  warnings: Problem[];
}

const PRODUCTION_CODES = new Set(['NO_COMPONENTS', 'COMPONENT_NO_MATERIAL', 'SLOT_NO_MATERIAL']);

const UNKNOWN_MATERIAL = (id: string): MaterialLite => ({
  id, name: 'Unknown filament', type: 'OTHER', color: null, colorHex: null, brand: null, costPerGram: 0,
});

function ownSlots(config: ProductConfig, c: ComponentRow): ResolvedSlot[] {
  const slotName = (id: string | null) => (id ? config.colourSlots.find((s) => s.id === id)?.name ?? null : null);
  const mk = (colorIndex: number, materialId: string, grams: number, colourSlotId: string | null, colourFixed: boolean | null): ResolvedSlot => ({
    colorIndex,
    materialId,
    material: config.materials.get(materialId) ?? UNKNOWN_MATERIAL(materialId),
    gramsPerUnit: grams,
    baseMaterialId: materialId,
    colourSlotId,
    colourSlotName: slotName(colourSlotId),
    unlinked: !colourSlotId && colourFixed !== true,
    assigned: false,
  });
  if (isMultiColourComponent(c)) {
    return c.materials.map((m) => mk(m.colorIndex, m.materialId, m.gramsUsed, m.colourSlotId, m.colourFixed));
  }
  return c.materialId ? [mk(0, c.materialId, c.gramsUsed, c.colourSlotId, c.colourFixed)] : [];
}

function layoutsOf(c: ComponentRow, desc: string, slots: ResolvedSlot[], minutesPerUnit: number, gramsPerUnit: number) {
  const slotIdx = slots.map((s) => s.colorIndex).sort((a, b) => a - b);
  const slotSum = slots.reduce((s, x) => s + x.gramsPerUnit, 0);
  const active = c.layouts.filter((l) => l.isActive);
  // Dedupe: one per unitsPerPlate, keeping the lowest minutes/unit, then sortOrder, then oldest.
  const best = new Map<number, (typeof active)[number]>();
  for (const l of active) {
    const prev = best.get(l.unitsPerPlate);
    const better = !prev
      || l.plateMinutes / l.unitsPerPlate < prev.plateMinutes / prev.unitsPerPlate
      || (l.plateMinutes / l.unitsPerPlate === prev.plateMinutes / prev.unitsPerPlate
        && (l.sortOrder < prev.sortOrder || (l.sortOrder === prev.sortOrder && new Date(l.createdAt).getTime() < new Date(prev.createdAt).getTime())));
    if (better) best.set(l.unitsPerPlate, l);
  }
  const out: ResolvedLayout[] = [];
  for (const l of best.values()) {
    const rowIdx = l.slots.map((s) => s.colorIndex).sort((a, b) => a - b);
    const same = rowIdx.length === slotIdx.length && rowIdx.every((v, i) => v === slotIdx[i]);
    const slotGrams = new Map<number, number>();
    if (same) {
      for (const s of l.slots) slotGrams.set(s.colorIndex, s.gramsUsed);
    } else {
      for (const s of slots) {
        slotGrams.set(s.colorIndex, slotSum > 0 ? (l.plateGrams * s.gramsPerUnit) / slotSum : l.plateGrams / slots.length);
      }
    }
    out.push({
      layoutId: l.id, label: `${desc} ${l.name}`, unitsPerPlate: l.unitsPerPlate, plateMinutes: l.plateMinutes,
      plateGrams: l.plateGrams, slotGrams, attachmentId: l.attachmentId, gcodeFilename: l.gcodeFilename, colorChanges: l.colorChanges,
    });
  }
  if (minutesPerUnit > 0 && gramsPerUnit > 0 && !best.has(1)) {
    out.push({
      layoutId: null, label: `${desc} single`, unitsPerPlate: 1, plateMinutes: minutesPerUnit, plateGrams: gramsPerUnit,
      slotGrams: new Map(slots.map((s) => [s.colorIndex, s.gramsPerUnit])),
      attachmentId: c.attachmentId, gcodeFilename: c.gcodeFilename, colorChanges: c.colorChanges,
    });
  }
  out.sort((a, b) => b.unitsPerPlate - a.unitsPerPlate);
  return { layouts: out, inactiveLayoutIds: c.layouts.filter((l) => !l.isActive).map((l) => l.id) };
}

function sizeStage(config: ProductConfig, sizeOptionId: string | null): SizeStage {
  const memoKey = `size:${sizeOptionId ?? ''}`;
  const hit = config.cache.get(memoKey) as SizeStage | undefined;
  if (hit) return hit;

  let size: OptionRow | null = null;
  if (sizeOptionId) {
    size = config.options.find((o) => o.id === sizeOptionId) ?? null;
    if (!size) throw new NotFoundException('Size not found');
    if (size.kind !== 'SIZE') throw new BadRequestException(`"${size.name}" is a colour, not a size`);
  }
  const problems: Problem[] = [];
  const warnings: Problem[] = [];
  let rows = config.components.filter((c) => c.variantId === (size ? size.id : null));
  let fallbackToBase = false;
  if (size && rows.length === 0) {
    rows = config.components.filter((c) => c.variantId === null);
    fallbackToBase = true;
    problems.push({ code: 'SIZE_OPTION_NO_COMPONENTS', message: `"${size.name}" has no components of its own` });
  }
  if (rows.length === 0) problems.push({ code: 'NO_COMPONENTS', message: 'No components — add or import the parts that are printed' });

  const components = rows.map((c) => {
    const d = c.description;
    const slots = ownSlots(config, c);
    const multi = isMultiColourComponent(c);
    const gramsPerUnit = multi ? slots.reduce((s, x) => s + x.gramsPerUnit, 0) : c.gramsUsed;
    const minutesPerUnit = c.printMinutes;
    if (!multi && !c.materialId) problems.push({ code: 'COMPONENT_NO_MATERIAL', componentId: c.id, message: `"${d}" has no filament set` });
    for (const s of slots) {
      if (!s.materialId || !config.materials.has(s.materialId)) {
        problems.push({ code: 'SLOT_NO_MATERIAL', componentId: c.id, message: `"${d}" colour ${s.colorIndex + 1} has no filament set` });
      }
    }
    if (!(gramsPerUnit > 0)) problems.push({ code: 'COMPONENT_ZERO_GRAMS', componentId: c.id, message: `"${d}" weighs 0 g — slice it or enter its grams` });
    if (!(minutesPerUnit > 0)) problems.push({ code: 'COMPONENT_ZERO_MINUTES', componentId: c.id, message: `"${d}" has no print time — slice it or enter its minutes` });
    if (c.perUnitEstimatedFromLayoutId) {
      const l = c.layouts.find((x) => x.id === c.perUnitEstimatedFromLayoutId);
      warnings.push({
        code: 'PER_UNIT_ESTIMATED', componentId: c.id,
        message: `"${d}" per-unit weight and time were estimated from its ×${l?.unitsPerPlate ?? '?'} plate — slice a single unit for an exact price`,
      });
    }
    const { layouts, inactiveLayoutIds } = layoutsOf(c, d, slots, minutesPerUnit, gramsPerUnit);
    const baseKey = colourKeyOf(slots);
    const resolved: ResolvedComponent = {
      componentId: c.id, description: d, variantId: c.variantId, sortOrder: c.sortOrder, isMultiColor: multi,
      quantity: c.quantity, gramsPerUnit, minutesPerUnit, colorChanges: c.colorChanges,
      attachmentId: c.attachmentId, gcodeFilename: c.gcodeFilename, slots, layouts, inactiveLayoutIds,
      colourKey: baseKey, baseColourKey: baseKey, stockOnHand: c.stockOnHand, stockConfirmedAt: c.stockConfirmedAt,
      perUnitEstimated: !!c.perUnitEstimatedFromLayoutId,
    };
    return { row: c, resolved };
  });

  if (!config.printer) warnings.push({ code: 'NO_PRICING_PRINTER', message: 'No pricing printer — machine rate and markup come from Settings' });
  for (const p of config.parts) {
    if (!p.isActive) warnings.push({ code: 'PART_INACTIVE', message: `Part "${p.name}" is inactive` });
  }
  const stage: SizeStage = { size, fallbackToBase, components, problems, warnings };
  config.cache.set(memoKey, stage);
  return stage;
}

/** Resolve a pair against an in-memory configuration. Throws 404/400 on ownership or kind. */
export function resolveInConfig(config: ProductConfig, sizeOptionId: string | null, colourOptionId: string | null): ResolvedBom {
  const stage = sizeStage(config, sizeOptionId);
  let colour: OptionRow | null = null;
  if (colourOptionId) {
    colour = config.options.find((o) => o.id === colourOptionId) ?? null;
    if (!colour) throw new NotFoundException('Colour not found');
    if (colour.kind !== 'COLOUR') throw new BadRequestException(`"${colour.name}" is a size, not a colour`);
  }
  const problems = [...stage.problems];
  const warnings = [...stage.warnings];
  const sizeLabel = stage.size ? stage.size.name : standardSizeLabel(config);
  const assign = new Map((colour?.assignments ?? []).map((a) => [a.colourSlotId, a.materialId]));

  const usedSlotIds = new Set<string>();
  let anyAssigned = false;
  const components: ResolvedComponent[] = stage.components.map(({ row, resolved }) => {
    if (!colour) return resolved;
    const slots = resolved.slots.map((s) => {
      if (s.colourSlotId) usedSlotIds.add(s.colourSlotId);
      if (s.colourSlotId && assign.has(s.colourSlotId)) {
        const materialId = assign.get(s.colourSlotId)!;
        anyAssigned = true;
        return { ...s, materialId, material: config.materials.get(materialId) ?? UNKNOWN_MATERIAL(materialId), assigned: true };
      }
      return s;
    });
    const colourKey = colourKeyOf(slots);
    const stockOnHand = colourKey === resolved.baseColourKey
      ? row.stockOnHand
      : row.colourStock.find((x) => x.colourKey === colourKey)?.stockOnHand ?? 0;
    return { ...resolved, slots, colourKey, stockOnHand };
  });

  if (colour) {
    if (colour.assignments.length === 0) {
      warnings.push({ code: 'COLOUR_OPTION_NOT_SET_UP', message: `"${colour.name}" has no filaments assigned — it prints in the standard colours` });
    }
    for (const a of colour.assignments) {
      if (usedSlotIds.has(a.colourSlotId)) continue;
      const slot = config.colourSlots.find((s) => s.id === a.colourSlotId)?.name ?? 'Colour slot';
      const mat = config.materials.get(a.materialId)?.name ?? 'Unknown filament';
      warnings.push({
        code: 'COLOUR_SLOT_UNUSED', colourSlotId: a.colourSlotId,
        message: `"${slot}" isn't used by ${sizeLabel} — ${colour.name}'s ${slot} filament (${mat}) is ignored`,
      });
    }
    if (colour.assignments.length > 0 && !anyAssigned) {
      warnings.push({ code: 'COLOUR_OPTION_NO_EFFECT', message: `"${colour.name}" changes nothing on ${sizeLabel} — link component colours to the product's colour slots` });
    }
    for (const c of components) {
      for (const s of c.slots) {
        if (s.unlinked) {
          warnings.push({
            code: 'COLOUR_SLOT_UNLINKED', componentId: c.componentId,
            message: `"${c.description}" colour ${s.colorIndex + 1} isn't linked or marked fixed — ${colour.name} won't change it`,
          });
        }
      }
    }
  }

  const zeroCost = new Map<string, MaterialLite>();
  for (const c of components) for (const s of c.slots) if (!(s.material.costPerGram > 0)) zeroCost.set(s.materialId, s.material);
  for (const m of zeroCost.values()) {
    problems.push({ code: 'MATERIAL_ZERO_COST', materialId: m.id, message: `Filament "${m.name}" has no cost per gram — set it on the Filaments page` });
  }

  return {
    productId: config.product.id,
    sizeOptionId: stage.size?.id ?? null,
    colourOptionId: colour?.id ?? null,
    sizeLabel,
    colourLabel: colour ? colour.name : standardColourLabel(config),
    label: pairLabel(config, stage.size, colour),
    fallbackToBase: stage.fallbackToBase,
    components,
    parts: config.parts.map((p) => ({ partId: p.partId, name: p.name, quantity: p.quantity, unitCost: p.unitCost, isActive: p.isActive })),
    hasSlicerComponent: stage.components.some(({ row }) => isMultiColourComponent(row) || !!row.gcodeFilename || !!row.attachmentId),
    productColorChanges: config.product.colorChanges,
    complete: problems.length === 0,
    productionReady: !problems.some((p) => PRODUCTION_CODES.has(p.code)),
    problems,
    warnings,
  };
}

/**
 * SLOT_STANDARD_MIXED (§3.3): per colour slot, the set of own filaments of its
 * links differs between two sizes (standard + active sizes with own components).
 * Differences inside one size are part of the design and don't count.
 */
export function standardMixedWarnings(config: ProductConfig): Problem[] {
  const sizes: Array<{ key: string | null; label: string }> = [{ key: null, label: standardSizeLabel(config) }];
  for (const o of config.options) if (o.kind === 'SIZE' && o.isActive) sizes.push({ key: o.id, label: o.name });
  const out: Problem[] = [];
  for (const slot of config.colourSlots) {
    const perSize: Array<{ label: string; set: string; parts: string[] }> = [];
    for (const sz of sizes) {
      const mats = new Set<string>();
      const parts: string[] = [];
      for (const c of config.components.filter((x) => x.variantId === sz.key)) {
        for (const s of ownSlots(config, c)) {
          if (s.colourSlotId !== slot.id) continue;
          mats.add(s.materialId);
          parts.push(`${s.material.name} on ${c.description}`);
        }
      }
      if (mats.size) perSize.push({ label: sz.label, set: [...mats].sort().join(','), parts });
    }
    if (new Set(perSize.map((p) => p.set)).size > 1) {
      const detail = [...new Set(perSize.flatMap((p) => p.parts))].join(', ');
      out.push({
        code: 'SLOT_STANDARD_MIXED', colourSlotId: slot.id,
        message: `"${slot.name}" is sliced in different filaments (${detail}) — the standard colour differs between sizes`,
      });
    }
  }
  return out;
}

/** `As sliced (<own filaments of the linked slots>)` per size while mixed (P2); null when not mixed. */
export function standardColourLabelBySize(config: ProductConfig): Record<string, string> | null {
  if (!standardMixedWarnings(config).length) return null;
  const out: Record<string, string> = {};
  const sizes: Array<string | null> = [null, ...config.options.filter((o) => o.kind === 'SIZE' && o.isActive).map((o) => o.id)];
  for (const key of sizes) {
    let rows = config.components.filter((c) => c.variantId === key);
    if (!rows.length && key) rows = config.components.filter((c) => c.variantId === null);
    const names: string[] = [];
    for (const c of rows) for (const s of ownSlots(config, c)) if (s.colourSlotId && !names.includes(s.material.name)) names.push(s.material.name);
    out[key ?? 'standard'] = `As sliced (${names.join(', ')})`;
  }
  return out;
}
