import type { MaterialLite } from '@printforge/types';

/**
 * One product's whole catalog configuration, loaded with ONE Prisma query
 * (`PRODUCT_CONFIG_INCLUDE`) and normalised. Everything in catalog-core resolves
 * pairs from this in memory: cell costs, the bulk floor and open-line impact
 * re-map slot materials without touching the database again.
 */

export type MaterialRow = MaterialLite;

export interface OptionRow {
  id: string;
  productId: string;
  name: string;
  sku: string | null;
  kind: 'SIZE' | 'COLOUR';
  isActive: boolean;
  sortOrder: number;
  basePrice: number | null;
  estimatedGrams: number | null;
  estimatedMinutes: number | null;
  createdAt: Date;
  /** COLOUR: filament per colour slot */
  assignments: Array<{ colourSlotId: string; materialId: string }>;
  /** COLOUR: size keys ('standard' | size id) it is NOT made in */
  excludedSizeKeys: string[];
}

export interface LayoutRow {
  id: string;
  name: string;
  unitsPerPlate: number;
  plateMinutes: number;
  plateGrams: number;
  colorChanges: number;
  attachmentId: string | null;
  gcodeFilename: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  slots: Array<{ colorIndex: number; gramsUsed: number }>;
}

export interface ComponentSlotRow {
  colorIndex: number;
  materialId: string;
  gramsUsed: number;
  colourSlotId: string | null;
  colourFixed: boolean | null;
}

export interface ComponentRow {
  id: string;
  productId: string;
  variantId: string | null;
  description: string;
  quantity: number;
  gramsUsed: number;
  printMinutes: number;
  sortOrder: number;
  createdAt: Date;
  isMultiColor: boolean;
  colorChanges: number;
  materialId: string | null;
  colourSlotId: string | null;
  colourFixed: boolean | null;
  attachmentId: string | null;
  gcodeFilename: string | null;
  stockOnHand: number;
  stockConfirmedAt: Date | null;
  perUnitEstimatedFromLayoutId: string | null;
  materials: ComponentSlotRow[];
  layouts: LayoutRow[];
  colourStock: Array<{ colourKey: string; stockOnHand: number }>;
}

export interface PrinterRow {
  id: string;
  name: string;
  hourlyRate: number;
  wattage: number;
  markupMultiplier: number;
}

export interface ProductRow {
  id: string;
  name: string;
  isActive: boolean;
  basePrice: number;
  colorChanges: number;
  baseOptionLabel: string | null;
  baseOptionSellable: boolean | null;
  standardColourLabel: string | null;
  standardColourSellable: boolean | null;
  surplusPolicy: 'KEEP_FOR_STOCK' | 'CANCEL_ON_PRINTER';
  defaultPrinterId: string | null;
  updatedAt: Date;
}

export interface ProductConfig {
  product: ProductRow;
  printer: PrinterRow | null;
  options: OptionRow[];
  /** every component of the product (all sizes), sorted sortOrder, createdAt, id */
  components: ComponentRow[];
  colourSlots: Array<{ id: string; name: string; sortOrder: number }>;
  parts: Array<{ partId: string; name: string; quantity: number; unitCost: number; isActive: boolean; stockQty: number }>;
  /** every material referenced: own slots and colour assignments */
  materials: Map<string, MaterialRow>;
  /** per-config memo of size-stage resolutions (owned by bom-resolver) */
  cache: Map<string, unknown>;
}

/** The single include that loads a ProductConfig. */
export const PRODUCT_CONFIG_INCLUDE = {
  defaultPrinter: true,
  variants: {
    include: {
      colourAssignments: { include: { material: true } },
      sizeExclusions: true,
    },
  },
  components: {
    include: {
      material: true,
      materials: { include: { material: true } },
      plateLayouts: { include: { slots: true } },
      colourStock: true,
    },
  },
  colourSlots: true,
  parts: { include: { part: true } },
} as const;

function lite(m: any): MaterialRow {
  return {
    id: m.id,
    name: m.name,
    type: m.type,
    color: m.color ?? null,
    colorHex: m.colorHex ?? null,
    brand: m.brand ?? null,
    costPerGram: Number(m.costPerGram ?? 0),
  };
}

const time = (d: any) => (d instanceof Date ? d.getTime() : new Date(d ?? 0).getTime());

export function compareComponents(a: { sortOrder: number; createdAt: Date; id: string }, b: { sortOrder: number; createdAt: Date; id: string }) {
  return a.sortOrder - b.sortOrder || time(a.createdAt) - time(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Normalise the row returned by `product.findUnique({ include: PRODUCT_CONFIG_INCLUDE })`. */
export function toProductConfig(row: any): ProductConfig {
  const materials = new Map<string, MaterialRow>();
  const addMat = (m: any) => { if (m?.id && !materials.has(m.id)) materials.set(m.id, lite(m)); };

  const components: ComponentRow[] = (row.components ?? []).map((c: any) => {
    addMat(c.material);
    for (const cm of c.materials ?? []) addMat(cm.material);
    return {
      id: c.id,
      productId: c.productId ?? row.id,
      variantId: c.variantId ?? null,
      description: c.description,
      quantity: Number(c.quantity ?? 1),
      gramsUsed: Number(c.gramsUsed ?? 0),
      printMinutes: Number(c.printMinutes ?? 0),
      sortOrder: Number(c.sortOrder ?? 0),
      createdAt: c.createdAt ?? new Date(0),
      isMultiColor: !!c.isMultiColor,
      colorChanges: Number(c.colorChanges ?? 0),
      materialId: c.materialId ?? null,
      colourSlotId: c.colourSlotId ?? null,
      colourFixed: c.colourFixed ?? null,
      attachmentId: c.attachmentId ?? null,
      gcodeFilename: c.gcodeFilename ?? null,
      stockOnHand: Number(c.stockOnHand ?? 0),
      stockConfirmedAt: c.stockConfirmedAt ?? null,
      perUnitEstimatedFromLayoutId: c.perUnitEstimatedFromLayoutId ?? null,
      materials: [...(c.materials ?? [])]
        .sort((a: any, b: any) => a.colorIndex - b.colorIndex)
        .map((cm: any) => ({
          colorIndex: cm.colorIndex,
          materialId: cm.materialId,
          gramsUsed: Number(cm.gramsUsed ?? 0),
          colourSlotId: cm.colourSlotId ?? null,
          colourFixed: cm.colourFixed ?? null,
        })),
      layouts: (c.plateLayouts ?? []).map((l: any) => ({
        id: l.id,
        name: l.name ?? `×${l.unitsPerPlate}`,
        unitsPerPlate: l.unitsPerPlate,
        plateMinutes: Number(l.plateMinutes),
        plateGrams: Number(l.plateGrams),
        colorChanges: Number(l.colorChanges ?? 0),
        attachmentId: l.attachmentId ?? null,
        gcodeFilename: l.gcodeFilename ?? null,
        isActive: l.isActive !== false,
        sortOrder: Number(l.sortOrder ?? 0),
        createdAt: l.createdAt ?? new Date(0),
        updatedAt: l.updatedAt ?? l.createdAt ?? new Date(0),
        slots: (l.slots ?? []).map((s: any) => ({ colorIndex: s.colorIndex, gramsUsed: Number(s.gramsUsed) })),
      })),
      colourStock: (c.colourStock ?? []).map((s: any) => ({ colourKey: s.colourKey, stockOnHand: Number(s.stockOnHand) })),
    };
  });
  components.sort(compareComponents);

  const options: OptionRow[] = (row.variants ?? []).map((v: any) => {
    for (const a of v.colourAssignments ?? []) addMat(a.material);
    return {
      id: v.id,
      productId: v.productId ?? row.id,
      name: v.name,
      sku: v.sku ?? null,
      kind: v.kind === 'COLOUR' ? 'COLOUR' : 'SIZE',
      isActive: v.isActive !== false,
      sortOrder: Number(v.sortOrder ?? 0),
      basePrice: v.basePrice ?? null,
      estimatedGrams: v.estimatedGrams ?? null,
      estimatedMinutes: v.estimatedMinutes ?? null,
      createdAt: v.createdAt ?? new Date(0),
      assignments: (v.colourAssignments ?? []).map((a: any) => ({ colourSlotId: a.colourSlotId, materialId: a.materialId })),
      excludedSizeKeys: (v.sizeExclusions ?? []).map((e: any) => e.sizeKey),
    };
  });

  const p = row.defaultPrinter;
  return {
    product: {
      id: row.id,
      name: row.name,
      isActive: row.isActive !== false,
      basePrice: Number(row.basePrice ?? 0),
      colorChanges: Number(row.colorChanges ?? 0),
      baseOptionLabel: row.baseOptionLabel ?? null,
      baseOptionSellable: row.baseOptionSellable ?? null,
      standardColourLabel: row.standardColourLabel ?? null,
      standardColourSellable: row.standardColourSellable ?? null,
      surplusPolicy: row.surplusPolicy === 'CANCEL_ON_PRINTER' ? 'CANCEL_ON_PRINTER' : 'KEEP_FOR_STOCK',
      defaultPrinterId: row.defaultPrinterId ?? null,
      updatedAt: row.updatedAt ?? new Date(0),
    },
    printer: p
      ? { id: p.id, name: p.name, hourlyRate: Number(p.hourlyRate ?? 0), wattage: Number(p.wattage ?? 0), markupMultiplier: Number(p.markupMultiplier ?? 0) }
      : null,
    options,
    components,
    colourSlots: [...(row.colourSlots ?? [])]
      .map((s: any) => ({ id: s.id, name: s.name, sortOrder: Number(s.sortOrder ?? 0) }))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    parts: (row.parts ?? []).map((pp: any) => ({
      partId: pp.partId,
      name: pp.part?.name ?? 'Part',
      quantity: Number(pp.quantity ?? 1),
      unitCost: Number(pp.part?.unitCost ?? 0),
      isActive: pp.part?.isActive !== false,
      stockQty: Number(pp.part?.stockQty ?? 0),
    })),
    materials,
    cache: new Map(),
  };
}

/** Options of one kind in display order: sortOrder asc, name asc, id asc (§3.1 rule 10). */
export function optionsOfKind(config: ProductConfig, kind: 'SIZE' | 'COLOUR'): OptionRow[] {
  return config.options
    .filter((o) => o.kind === kind)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Deep-enough copy for in-memory "what if" changes (open-line impact); fresh memo. */
export function cloneConfig(config: ProductConfig): ProductConfig {
  return {
    product: { ...config.product },
    printer: config.printer ? { ...config.printer } : null,
    options: config.options.map((o) => ({ ...o, assignments: o.assignments.map((a) => ({ ...a })), excludedSizeKeys: [...o.excludedSizeKeys] })),
    components: config.components.map((c) => ({
      ...c,
      materials: c.materials.map((m) => ({ ...m })),
      layouts: c.layouts,
      colourStock: c.colourStock,
    })),
    colourSlots: config.colourSlots.map((s) => ({ ...s })),
    parts: config.parts.map((p) => ({ ...p })),
    materials: new Map(config.materials),
    cache: new Map(),
  };
}
