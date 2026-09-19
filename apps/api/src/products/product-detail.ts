import type {
  CellCost, ColourOptionDetail, ColourSlotDetail, ComponentDetail, MaterialLite, ProductDetail, Problem, SizeOptionDetail, UnlinkedSlot,
} from '@printforge/types';
import { resolveInConfig, standardMixedWarnings, type ResolvedBom } from '../catalog-core/bom-resolve';
import { optionsOfKind, PRODUCT_CONFIG_INCLUDE, type ComponentRow, type OptionRow, type ProductConfig } from '../catalog-core/catalog-config';
import { likelyColour } from '../catalog-core/colour-words';
import {
  colourOffered, orderedSizes, sizeKey, standardColourSellable, standardSizeSellable, type PairContext,
} from '../catalog-core/option-pair';
import { colourCostWarnings } from '../catalog-core/pricing-core';
import { baseColourKeyOf, colourLabel, isMultiColourComponent } from '../stock-ledger/colour-key';
import { compareImages, type ImageRow } from './product-images.service';

/**
 * Assembly of `ProductDetail` (spec §4.1.1) from one product row. Pure: the
 * service loads the row (DETAIL_INCLUDE, one query), the attachments it names,
 * the option references of order/quote/job rows and the cell costs, and this
 * turns them into the page's shape.
 */

export const DETAIL_INCLUDE = {
  ...PRODUCT_CONFIG_INCLUDE,
  priceTiers: { orderBy: { minQty: 'asc' } },
  images: true,
  variants: {
    include: {
      colourAssignments: { include: { material: true } },
      sizeExclusions: true,
      priceTiers: { orderBy: { minQty: 'asc' } },
    },
  },
} as const;

export interface AttachmentLite { id: string; originalName: string | null; filename: string; sizeBytes: number }

/** An order line, quote line or job that names an option through this release's columns. */
export interface OptionRef { sizeOptionId: string | null; colourOptionId: string | null }

export interface DetailExtras {
  attachments: Map<string, AttachmentLite>;
  optionRefs: OptionRef[];
  cells: CellCost[];
  /** materials named only by stock keys (not by the configuration) */
  extraMaterials: Map<string, MaterialLite>;
}

export const coverUrl = (productId: string, images: ImageRow[] | undefined): string | null => {
  const first = [...(images ?? [])].sort(compareImages)[0];
  return first ? `/api/products/${productId}/images/${first.id}` : null;
};

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d ?? ''));
const round3 = (x: number) => Math.round(x * 1000) / 1000;

function fileOf(id: string | null | undefined, extras: DetailExtras) {
  if (!id) return null;
  const a = extras.attachments.get(id);
  if (!a) return null;
  return { attachmentId: a.id, filename: a.originalName || a.filename, sizeBytes: a.sizeBytes, downloadUrl: `/api/attachments/${a.id}/download` };
}

/** Unlinked slots (§0.3) of the given components. */
export function unlinkedSlotsOf(rows: ComponentRow[]): UnlinkedSlot[] {
  const out: UnlinkedSlot[] = [];
  for (const c of rows) {
    if (isMultiColourComponent(c)) {
      for (const m of c.materials) if (!m.colourSlotId && m.colourFixed !== true) out.push({ componentId: c.id, description: c.description, colorIndex: m.colorIndex });
    } else if (c.materialId && !c.colourSlotId && c.colourFixed !== true) {
      out.push({ componentId: c.id, description: c.description, colorIndex: 0 });
    }
  }
  return out;
}

class Resolutions {
  private memo = new Map<string, ResolvedBom | null>();
  constructor(private readonly config: ProductConfig) {}
  get(size: string | null, colour: string | null): ResolvedBom | null {
    const k = `${size ?? ''}|${colour ?? ''}`;
    if (!this.memo.has(k)) {
      let bom: ResolvedBom | null = null;
      try { bom = resolveInConfig(this.config, size, colour); } catch { bom = null; }
      this.memo.set(k, bom);
    }
    return this.memo.get(k)!;
  }
}

function componentDetail(productId: string, raw: any, row: ComponentRow, config: ProductConfig, res: Resolutions, extras: DetailExtras): ComponentDetail {
  const mat = (id: string) => config.materials.get(id) ?? extras.extraMaterials.get(id);
  const baseKey = (() => { try { return baseColourKeyOf(row); } catch { return ''; } })();
  const label = (key: string) => { try { return colourLabel(key, (id) => mat(id)); } catch { return key; } };

  const stock = new Map<string, { stockOnHand: number; usedBy: string[] }>();
  for (const s of row.colourStock) if (s.colourKey !== baseKey && s.stockOnHand !== 0) stock.set(s.colourKey, { stockOnHand: s.stockOnHand, usedBy: [] });
  for (const colour of optionsOfKind(config, 'COLOUR').filter((o) => o.isActive)) {
    const bom = res.get(row.variantId, colour.id);
    const rc = bom?.components.find((c) => c.componentId === row.id);
    if (!rc || !rc.colourKey || rc.colourKey === baseKey) continue;
    const entry = stock.get(rc.colourKey) ?? { stockOnHand: row.colourStock.find((s) => s.colourKey === rc.colourKey)?.stockOnHand ?? 0, usedBy: [] };
    if (!entry.usedBy.includes(colour.name)) entry.usedBy.push(colour.name);
    stock.set(rc.colourKey, entry);
  }
  const standard = res.get(row.variantId, null);
  const est = row.perUnitEstimatedFromLayoutId ? row.layouts.find((l) => l.id === row.perUnitEstimatedFromLayoutId) : null;
  const layouts = [...(raw.plateLayouts ?? [])].sort((a: any, b: any) => a.sortOrder - b.sortOrder || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return {
    id: row.id,
    variantId: row.variantId,
    description: row.description,
    quantity: row.quantity,
    gramsUsed: row.gramsUsed,
    printMinutes: row.printMinutes,
    sortOrder: row.sortOrder,
    isMultiColor: row.isMultiColor,
    colorChanges: row.colorChanges,
    materialId: row.materialId,
    material: row.materialId ? mat(row.materialId) ?? null : null,
    colourSlotId: row.colourSlotId,
    colourFixed: row.colourFixed === true,
    materials: [...(raw.materials ?? [])]
      .sort((a: any, b: any) => a.colorIndex - b.colorIndex)
      .map((m: any) => ({
        id: m.id, colorIndex: m.colorIndex, materialId: m.materialId, material: mat(m.materialId)!, gramsUsed: m.gramsUsed,
        colourSlotId: m.colourSlotId ?? null, colourFixed: m.colourFixed === true,
      })),
    stockOnHand: row.stockOnHand,
    stockConfirmed: row.stockConfirmedAt != null || row.stockOnHand === 0,
    baseColourKey: baseKey,
    colourStock: [...stock.entries()].map(([colourKey, v]) => ({ colourKey, label: label(colourKey), stockOnHand: v.stockOnHand, usedBy: v.usedBy })),
    perUnitEstimatedFrom: est ? { layoutId: est.id, unitsPerPlate: est.unitsPerPlate } : null,
    file: fileOf(row.attachmentId, extras),
    thumbnailUrl: raw.thumbnailAttachmentId ? `/api/products/${productId}/components/${row.id}/thumbnail` : null,
    plateLayouts: layouts.map((l: any) => ({
      id: l.id, name: l.name, unitsPerPlate: l.unitsPerPlate, plateMinutes: l.plateMinutes, plateGrams: l.plateGrams,
      colorChanges: l.colorChanges ?? 0, source: l.source ?? 'MANUAL', objectCount: l.objectCount ?? null, isActive: l.isActive !== false,
      sortOrder: l.sortOrder ?? 0, minutesPerUnit: round3(l.plateMinutes / l.unitsPerPlate), gramsPerUnit: round3(l.plateGrams / l.unitsPerPlate),
      file: fileOf(l.attachmentId, extras),
      slots: [...(l.slots ?? [])].sort((a: any, b: any) => a.colorIndex - b.colorIndex).map((s: any) => ({ colorIndex: s.colorIndex, gramsUsed: s.gramsUsed })),
    })),
    problems: (standard?.problems ?? []).filter((p) => p.componentId === row.id),
  };
}

/** The O7 blockers of one option (§3.1 rule 3, §4.2 O7 sentences), from pre-loaded counts. */
export function kindChangeBlockers(
  config: ProductConfig,
  option: OptionRow,
  counts: { ownComponents: number; ownTiers: number; refsWithColour: number; colourRefs: number },
): string[] {
  const out: string[] = [];
  if (option.kind === 'SIZE') {
    if (counts.ownComponents > 0) out.push(`"${option.name}" can't become a colour: it has its own components.`);
    if (counts.ownTiers > 0) out.push(`"${option.name}" can't become a colour: it has its own bulk tiers.`);
    if (counts.refsWithColour > 0) out.push(`"${option.name}" can't become a colour: it is used as a size with a colour on ${counts.refsWithColour} orders, quotes or jobs.`);
    if (config.components.length === 0) out.push("Add the product's components before adding colours");
  } else {
    if (option.assignments.length > 0) out.push(`"${option.name}" can't become a size: it has filament assignments — clear them first.`);
    if (counts.colourRefs > 0) out.push(`"${option.name}" can't become a size: it is used as a colour on ${counts.colourRefs} orders, quotes or jobs made since the update.`);
  }
  return out;
}

const COLOUR_SETUP_CODES = new Set(['COLOUR_OPTION_NOT_SET_UP', 'COLOUR_SLOT_UNUSED', 'COLOUR_OPTION_NO_EFFECT', 'COLOUR_SLOT_UNLINKED']);

/** Customer-offered sizes on which `colourId` is offered (§3.1 rule 8), as size keys. */
export function customerSizeKeysOf(pc: PairContext, colourId: string | null): string[] {
  return orderedSizes(pc.config, 'CUSTOMER')
    .filter((s) => colourOffered(pc, s?.id ?? null, colourId, 'CUSTOMER'))
    .map((s) => sizeKey(s?.id ?? null));
}

export function buildProductDetail(raw: any, config: ProductConfig, pc: PairContext, extras: DetailExtras): ProductDetail {
  const res = new Resolutions(config);
  const rawComponents = new Map<string, any>((raw.components ?? []).map((c: any) => [c.id, c]));
  const detailOf = (row: ComponentRow) => componentDetail(config.product.id, rawComponents.get(row.id) ?? {}, row, config, res, extras);
  const rawVariants = new Map<string, any>((raw.variants ?? []).map((v: any) => [v.id, v]));
  const allMaterials = [...config.materials.values()];
  const mixed = standardMixedWarnings(config);

  const sizes: SizeOptionDetail[] = optionsOfKind(config, 'SIZE').map((s) => {
    const own = config.components.filter((c) => c.variantId === s.id);
    const tiers = (rawVariants.get(s.id)?.priceTiers ?? []).map((t: any) => ({ id: t.id, minQty: t.minQty, unitPrice: t.unitPrice }));
    const bom = res.get(s.id, null);
    const refsWithColour = extras.optionRefs.filter((r) => r.sizeOptionId === s.id && r.colourOptionId).length;
    const blockers = kindChangeBlockers(config, s, { ownComponents: own.length, ownTiers: tiers.length, refsWithColour, colourRefs: 0 });
    const notSetUp = own.length === 0 && tiers.length === 0;
    return {
      id: s.id, name: s.name, sku: s.sku, isActive: s.isActive, sortOrder: s.sortOrder, basePrice: s.basePrice,
      estimatedGrams: s.estimatedGrams, estimatedMinutes: s.estimatedMinutes,
      unlinkedSlots: unlinkedSlotsOf(own),
      notSetUp,
      likelyColour: likelyColour(s.name, allMaterials),
      components: own.map(detailOf),
      priceTiers: tiers,
      setup: { complete: !!bom?.complete, problems: bom?.problems ?? [] },
      kindChange: { allowed: blockers.length === 0, blockers },
    };
  });

  const sizeIds: Array<string | null> = [null, ...optionsOfKind(config, 'SIZE').filter((s) => s.isActive).map((s) => s.id)];
  const colours: ColourOptionDetail[] = optionsOfKind(config, 'COLOUR').map((c) => {
    const warnings: Problem[] = [];
    for (const sid of sizeIds) {
      for (const w of res.get(sid, c.id)?.warnings ?? []) {
        if (COLOUR_SETUP_CODES.has(w.code) && !warnings.some((x) => x.message === w.message)) warnings.push(w);
      }
    }
    const colourRefs = extras.optionRefs.filter((r) => r.colourOptionId === c.id).length;
    const blockers = kindChangeBlockers(config, c, { ownComponents: 0, ownTiers: 0, refsWithColour: 0, colourRefs });
    return {
      id: c.id, name: c.name, sku: c.sku, isActive: c.isActive, sortOrder: c.sortOrder,
      legacyPrice: c.basePrice,
      assignments: c.assignments.map((a) => ({ colourSlotId: a.colourSlotId, materialId: a.materialId, material: config.materials.get(a.materialId)! })),
      excludedSizeKeys: [...c.excludedSizeKeys],
      customerSizeKeys: customerSizeKeysOf(pc, c.id),
      setup: { warnings },
      kindChange: { allowed: blockers.length === 0, blockers, rewrites: 0 },
    };
  });

  const colourSlots: ColourSlotDetail[] = config.colourSlots.map((slot) => {
    const links: ColourSlotDetail['links'] = [];
    const mats: MaterialLite[] = [];
    for (const c of config.components) {
      const slots = isMultiColourComponent(c)
        ? c.materials.map((m) => ({ colorIndex: m.colorIndex, materialId: m.materialId, link: m.colourSlotId }))
        : c.materialId ? [{ colorIndex: 0, materialId: c.materialId, link: c.colourSlotId }] : [];
      for (const s of slots) {
        if (s.link !== slot.id) continue;
        links.push({ componentId: c.id, componentDescription: c.description, sizeOptionId: c.variantId, colorIndex: s.colorIndex });
        const m = config.materials.get(s.materialId);
        if (m && !mats.some((x) => x.id === m.id)) mats.push(m);
      }
    }
    return { id: slot.id, name: slot.name, sortOrder: slot.sortOrder, links, standardMaterials: mats };
  });

  const standardRows = config.components.filter((c) => c.variantId === null);
  const p = raw;
  return {
    id: p.id, name: p.name, description: p.description ?? null, sku: p.sku ?? null, isActive: p.isActive,
    basePrice: p.basePrice, estimatedGrams: p.estimatedGrams, estimatedMinutes: p.estimatedMinutes, colorChanges: p.colorChanges,
    baseOptionLabel: p.baseOptionLabel ?? null, baseOptionSellable: p.baseOptionSellable ?? null,
    standardColourLabel: p.standardColourLabel ?? null, standardColourSellable: p.standardColourSellable ?? null,
    surplusPolicy: p.surplusPolicy, defaultPrinterId: p.defaultPrinterId ?? null,
    defaultPrinter: p.defaultPrinter
      ? { id: p.defaultPrinter.id, name: p.defaultPrinter.name, hourlyRate: p.defaultPrinter.hourlyRate, wattage: p.defaultPrinter.wattage, markupMultiplier: p.defaultPrinter.markupMultiplier }
      : null,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
    coverImageUrl: coverUrl(p.id, p.images),
    hasSlicerComponent: config.components.some((c) => isMultiColourComponent(c) || !!c.gcodeFilename || !!c.attachmentId),
    baseSellable: standardSizeSellable(config, 'STAFF'),
    baseSellableToCustomers: standardSizeSellable(config, 'CUSTOMER'),
    standardColourSellableToCustomers: standardColourSellable(pc, 'CUSTOMER'),
    components: standardRows.map(detailOf),
    priceTiers: (p.priceTiers ?? []).map((t: any) => ({ id: t.id, minQty: t.minQty, unitPrice: t.unitPrice })),
    colourSlots,
    standardColourMixed: mixed.length > 0,
    sizes,
    colours,
    unlinkedSlots: unlinkedSlotsOf(standardRows),
    warnings: [...mixed, ...colourCostWarnings(extras.cells)],
  };
}
