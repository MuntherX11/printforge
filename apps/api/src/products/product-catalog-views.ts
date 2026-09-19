import type { CatalogProduct, CatalogProductDetail } from '@printforge/types';
import { standardColourLabelBySize } from '../catalog-core/bom-resolve';
import { optionsOfKind, type ProductConfig } from '../catalog-core/catalog-config';
import {
  colourOffered, orderedSizes, sizeKey, standardColourLabel, standardColourSellable, standardSizeLabel, standardSizeSellable, type PairContext,
} from '../catalog-core/option-pair';
import { isMultiColourComponent } from '../stock-ledger/colour-key';
import { compareImages, type ImageRow } from './product-images.service';
import { coverUrl } from './product-detail';

/**
 * The staff picker feed (P2) and the customer catalog (P3, P4), each from one
 * resolver pass per product (spec §3.1 rules 6–11, §4.1).
 */

/** Filaments a colour assigns, in colour-slot order, distinct. */
function assignedMaterialIds(config: ProductConfig, colourId: string): string[] {
  const colour = config.options.find((o) => o.id === colourId);
  if (!colour) return [];
  const out: string[] = [];
  for (const slot of config.colourSlots) {
    const a = colour.assignments.find((x) => x.colourSlotId === slot.id);
    if (a && !out.includes(a.materialId)) out.push(a.materialId);
  }
  return out;
}

/** Distinct own filaments of linked slots (the standard colour's swatches). */
function standardLinkedMaterialIds(config: ProductConfig): string[] {
  const out: string[] = [];
  for (const slot of config.colourSlots) {
    for (const c of config.components) {
      const slots = isMultiColourComponent(c)
        ? c.materials.map((m) => ({ materialId: m.materialId, link: m.colourSlotId }))
        : c.materialId ? [{ materialId: c.materialId, link: c.colourSlotId }] : [];
      for (const s of slots) if (s.link === slot.id && !out.includes(s.materialId)) out.push(s.materialId);
    }
  }
  return out;
}

/** P2 row for one active product (`raw` = the findMany row; `config` its normalised configuration). */
export function activeProductView(raw: any, config: ProductConfig, pc: PairContext) {
  const staffSizes = orderedSizes(config, 'STAFF');
  const customerSizes = orderedSizes(config, 'CUSTOMER');
  const activeSizes = optionsOfKind(config, 'SIZE').filter((s) => s.isActive);
  const sizes = activeSizes.map((s) => ({
    id: s.id, name: s.name, sku: s.sku, basePrice: s.basePrice, sortOrder: s.sortOrder,
    sellableToCustomers: config.product.isActive && (s.basePrice ?? 0) > 0,
  }));
  const colours = optionsOfKind(config, 'COLOUR').filter((c) => c.isActive).map((c) => ({
    id: c.id, name: c.name, sku: c.sku, sortOrder: c.sortOrder,
    filamentNames: assignedMaterialIds(config, c.id).map((m) => config.materials.get(m)?.name ?? 'Unknown filament'),
    sizeKeys: staffSizes.filter((s) => colourOffered(pc, s?.id ?? null, c.id, 'STAFF')).map((s) => sizeKey(s?.id ?? null)),
    customerSizeKeys: customerSizes.filter((s) => colourOffered(pc, s?.id ?? null, c.id, 'CUSTOMER')).map((s) => sizeKey(s?.id ?? null)),
    notSetUp: c.assignments.length === 0,
  }));
  return {
    id: raw.id,
    name: raw.name,
    sku: raw.sku ?? null,
    estimatedGrams: raw.estimatedGrams,
    estimatedMinutes: raw.estimatedMinutes,
    colorChanges: raw.colorChanges,
    basePrice: raw.basePrice,
    priceTiers: (raw.priceTiers ?? []).map((t: any) => ({ minQty: t.minQty, unitPrice: t.unitPrice })),
    baseOptionLabel: raw.baseOptionLabel ?? null,
    standardColourLabel: raw.standardColourLabel ?? null,
    standardColourLabelBySize: standardColourLabelBySize(config),
    baseSellable: standardSizeSellable(config, 'STAFF'),
    baseSellableToCustomers: standardSizeSellable(config, 'CUSTOMER'),
    sizes,
    colours,
    // One release only: legacy readers (nothing in the app after WP10).
    variants: [...(raw.variants ?? [])]
      .filter((v: any) => v.isActive)
      .sort((a: any, b: any) => a.sortOrder - b.sortOrder)
      .map((v: any) => ({ id: v.id, name: v.name, sku: v.sku ?? null, kind: v.kind, basePrice: v.basePrice ?? null, estimatedMinutes: v.estimatedMinutes ?? null, estimatedGrams: v.estimatedGrams ?? null })),
  };
}

/** P3 row, or null when the product offers no priced size to customers. */
export function catalogProductView(raw: any, config: ProductConfig): CatalogProduct | null {
  const sizes = orderedSizes(config, 'CUSTOMER');
  const prices = sizes.map((s) => (s ? s.basePrice ?? 0 : config.product.basePrice)).filter((p) => p > 0);
  if (!prices.length) return null;
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description ?? null,
    coverImageUrl: coverUrl(raw.id, raw.images),
    fromPrice: Math.min(...prices),
    optionCount: prices.length,
    estimatedMinutes: raw.estimatedMinutes ?? 0,
  };
}

/** P4, or null (→ 404) when inactive or no priced size is offered. */
export function catalogDetailView(raw: any, config: ProductConfig, pc: PairContext): CatalogProductDetail | null {
  if (!config.product.isActive) return null;
  const sizeRows = orderedSizes(config, 'CUSTOMER').filter((s) => (s ? s.basePrice ?? 0 : config.product.basePrice) > 0);
  if (!sizeRows.length) return null;
  const sizes = sizeRows.map((s) => ({
    sizeOptionId: s?.id ?? null,
    label: s ? s.name : standardSizeLabel(config),
    price: s ? (s.basePrice as number) : config.product.basePrice,
    estimatedMinutes: s ? s.estimatedMinutes : raw.estimatedMinutes ?? null,
    estimatedGrams: s ? s.estimatedGrams : raw.estimatedGrams ?? null,
  }));
  const hex = (ids: string[]) => ids.map((id) => config.materials.get(id)?.colorHex).filter((h): h is string => !!h).slice(0, 4);
  const activeColours = optionsOfKind(config, 'COLOUR').filter((c) => c.isActive);
  const colours: CatalogProductDetail['colours'] = [];
  if (activeColours.length) {
    const entries: Array<{ id: string | null; label: string; swatches: string[] }> = [];
    if (standardColourSellable(pc, 'CUSTOMER')) entries.push({ id: null, label: standardColourLabel(config), swatches: hex(standardLinkedMaterialIds(config)) });
    for (const c of activeColours) entries.push({ id: c.id, label: c.name, swatches: hex(assignedMaterialIds(config, c.id)) });
    for (const e of entries) {
      const on = sizeRows.filter((s) => colourOffered(pc, s?.id ?? null, e.id, 'CUSTOMER')).map((s) => s?.id ?? null);
      if (on.length) colours.push({ colourOptionId: e.id, label: e.label, swatches: e.swatches, sizeOptionIds: on });
    }
  }
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description ?? null,
    images: [...((raw.images ?? []) as ImageRow[])].sort(compareImages).map((i) => ({ id: i.id, url: `/api/products/${raw.id}/images/${i.id}` })),
    hasSizes: optionsOfKind(config, 'SIZE').some((s) => s.isActive),
    sizes,
    colours,
  };
}
