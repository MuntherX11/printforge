/**
 * The §3.6.1 "Sardine tin, 2 sizes × 3 colours" fixture, as the nested row
 * `product.findUnique({ include: PRODUCT_CONFIG_INCLUDE })` returns. Shared by
 * the catalog-core specs (and later the job-planning and jobs specs).
 *
 * Every call returns a fresh deep copy, so a spec can mutate its rows.
 */
import { toProductConfig, type ProductConfig } from '../catalog-config';

export const PRODUCT_ID = 'p-sardine';

export const M = {
  black: 'm-black',
  silver: 'm-silver',
  white: 'm-white',
  orange: 'm-orange',
  red: 'm-red',
  blue: 'm-blue',
  gold: 'm-gold',
  crimson: 'm-crimson',
  grey: 'm-grey',
} as const;

export const MATERIALS: Record<string, { id: string; name: string; type: string; color: string; colorHex: string; brand: null; costPerGram: number }> = {
  [M.black]: { id: M.black, name: 'PLA Black', type: 'PLA', color: 'Black', colorHex: '#111111', brand: null, costPerGram: 0.01 },
  [M.silver]: { id: M.silver, name: 'PLA Silver', type: 'PLA', color: 'Silver', colorHex: '#C0C0C0', brand: null, costPerGram: 0.012 },
  [M.white]: { id: M.white, name: 'PLA White', type: 'PLA', color: 'White', colorHex: '#FFFFFF', brand: null, costPerGram: 0.01 },
  [M.orange]: { id: M.orange, name: 'Silk Orange', type: 'PLA', color: 'Orange', colorHex: '#FF8000', brand: null, costPerGram: 0.03 },
  [M.red]: { id: M.red, name: 'PLA Red', type: 'PLA', color: 'Red', colorHex: '#C4402A', brand: null, costPerGram: 0.012 },
  [M.blue]: { id: M.blue, name: 'PLA Blue', type: 'PLA', color: 'Blue', colorHex: '#2040C0', brand: null, costPerGram: 0.012 },
  [M.gold]: { id: M.gold, name: 'PLA Gold', type: 'PLA', color: 'Gold', colorHex: '#D4AF37', brand: null, costPerGram: 0.02 },
  [M.crimson]: { id: M.crimson, name: 'PLA Crimson', type: 'PLA', color: 'Crimson', colorHex: '#91202B', brand: null, costPerGram: 0.012 },
  [M.grey]: { id: M.grey, name: 'PLA Grey', type: 'PLA', color: 'Grey', colorHex: '#808080', brand: null, costPerGram: 0.01 },
};

export const SLOT = { tin: 'slot-tin', trim: 'slot-trim', band: 'slot-band' } as const;
export const OPT = { large: 'v-large', red: 'v-red', blue: 'v-blue' } as const;

const mat = (id: string) => ({ ...MATERIALS[id] });
const T0 = new Date('2026-01-01T00:00:00Z');
const at = (n: number) => new Date(T0.getTime() + n * 1000);

type Slot = [colorIndex: number, materialId: string, grams: number, link: string | 'fixed' | null];
type Layout = { id: string; units: number; minutes: number; grams: number; slots?: Array<[number, number]>; isActive?: boolean; sortOrder?: number };

function component(
  id: string,
  variantId: string | null,
  description: string,
  quantity: number,
  sortOrder: number,
  minutes: number,
  slots: Slot[],
  layouts: Layout[],
  extra: Record<string, unknown> = {},
): any {
  const multi = slots.length > 1;
  const link = (l: Slot[3]) => ({ colourSlotId: l && l !== 'fixed' ? l : null, colourFixed: l === 'fixed' ? true : null });
  return {
    id,
    productId: PRODUCT_ID,
    variantId,
    description,
    quantity,
    sortOrder,
    createdAt: at(sortOrder + (variantId ? 100 : 0)),
    printMinutes: minutes,
    gramsUsed: slots.reduce((s, x) => s + x[2], 0),
    isMultiColor: multi,
    colorChanges: multi ? slots.length - 1 : 0,
    materialId: multi ? null : slots[0][1],
    material: multi ? null : mat(slots[0][1]),
    ...(multi ? { colourSlotId: null, colourFixed: null } : link(slots[0][3])),
    attachmentId: null,
    gcodeFilename: `${description}.gcode`,
    stockOnHand: 0,
    stockConfirmedAt: T0,
    perUnitEstimatedFromLayoutId: null,
    materials: multi
      ? slots.map(([colorIndex, materialId, gramsUsed, l]) => ({ colorIndex, materialId, gramsUsed, material: mat(materialId), ...link(l) }))
      : [],
    plateLayouts: layouts.map((l) => ({
      id: l.id,
      componentId: id,
      name: `×${l.units}`,
      unitsPerPlate: l.units,
      plateMinutes: l.minutes,
      plateGrams: l.grams,
      colorChanges: 0,
      attachmentId: null,
      gcodeFilename: `${description} x${l.units}.gcode`,
      isActive: l.isActive ?? true,
      sortOrder: l.sortOrder ?? 0,
      createdAt: T0,
      updatedAt: T0,
      slots: (l.slots ?? []).map(([colorIndex, gramsUsed]) => ({ colorIndex, gramsUsed })),
    })),
    colourStock: [] as Array<{ colourKey: string; stockOnHand: number }>,
    ...extra,
  };
}

/** Loosely typed so specs can add options and components of any shape. */
export interface FixtureRow {
  [k: string]: any;
  variants: any[];
  components: any[];
  colourSlots: any[];
  parts: any[];
}

/** The nested product row (§3.6.1 data rows). */
export function sardineRow(): FixtureRow {
  return {
    id: PRODUCT_ID,
    name: 'Sardine tin',
    isActive: true,
    basePrice: 1.5,
    colorChanges: 0,
    baseOptionLabel: 'Regular',
    baseOptionSellable: true,
    standardColourLabel: 'Black',
    standardColourSellable: true,
    surplusPolicy: 'KEEP_FOR_STOCK',
    defaultPrinterId: 'pr-1',
    updatedAt: T0,
    defaultPrinter: { id: 'pr-1', name: 'K1', hourlyRate: 0.4, wattage: 200, markupMultiplier: 2.5 },
    colourSlots: [
      { id: SLOT.tin, productId: PRODUCT_ID, name: 'Tin', sortOrder: 0 },
      { id: SLOT.trim, productId: PRODUCT_ID, name: 'Trim', sortOrder: 1 },
      { id: SLOT.band, productId: PRODUCT_ID, name: 'Band', sortOrder: 2 },
    ],
    variants: [
      { id: OPT.large, productId: PRODUCT_ID, name: 'Large', sku: null, kind: 'SIZE', isActive: true, sortOrder: 0, basePrice: 2.8, estimatedGrams: null, estimatedMinutes: null, createdAt: T0, colourAssignments: [], sizeExclusions: [] },
      {
        id: OPT.red, productId: PRODUCT_ID, name: 'Red', sku: null, kind: 'COLOUR', isActive: true, sortOrder: 0, basePrice: null, estimatedGrams: null, estimatedMinutes: null, createdAt: T0,
        colourAssignments: [
          { colourSlotId: SLOT.tin, materialId: M.red, material: mat(M.red) },
          { colourSlotId: SLOT.band, materialId: M.gold, material: mat(M.gold) },
        ],
        sizeExclusions: [],
      },
      {
        id: OPT.blue, productId: PRODUCT_ID, name: 'Blue', sku: null, kind: 'COLOUR', isActive: true, sortOrder: 1, basePrice: null, estimatedGrams: null, estimatedMinutes: null, createdAt: T0,
        colourAssignments: [
          { colourSlotId: SLOT.tin, materialId: M.blue, material: mat(M.blue) },
          { colourSlotId: SLOT.trim, materialId: M.white, material: mat(M.white) },
          { colourSlotId: SLOT.band, materialId: M.gold, material: mat(M.gold) },
        ],
        sizeExclusions: [],
      },
    ],
    components: [
      // Regular (standard size)
      component('c1', null, 'Box', 1, 0, 34, [[0, M.black, 9.4, SLOT.tin]], [{ id: 'l1', units: 12, minutes: 243, grams: 112.8 }]),
      component('c2', null, 'Lid', 1, 1, 26, [[0, M.black, 5.2, SLOT.tin], [1, M.silver, 0.8, SLOT.trim]], [{ id: 'l2', units: 15, minutes: 260, grams: 90 }]),
      component('c3', null, 'Fish', 2, 2, 9, [[0, M.white, 1.2, 'fixed'], [1, M.orange, 0.3, 'fixed']], [{ id: 'l3', units: 24, minutes: 175, grams: 36, slots: [[0, 28.8], [1, 7.2]] }]),
      component('c4', null, 'Key', 1, 3, 6, [[0, M.silver, 1.5, SLOT.trim]], [{ id: 'l4', units: 10, minutes: 55, grams: 15 }]),
      component('c5', null, 'Band', 1, 4, 11, [[0, M.black, 2.0, SLOT.band], [1, M.white, 0.6, 'fixed']], [{ id: 'l5', units: 8, minutes: 80, grams: 20.8 }]),
      // Large
      component('c6', OPT.large, 'Large Box', 1, 0, 70, [[0, M.black, 21.0, SLOT.tin]], [{ id: 'l6', units: 4, minutes: 250, grams: 84.0 }]),
      component('c7', OPT.large, 'Large Lid', 1, 1, 45, [[0, M.black, 12.5, SLOT.tin], [1, M.silver, 1.6, SLOT.trim]], [{ id: 'l7', units: 6, minutes: 240, grams: 90.0, slots: [[0, 79.8], [1, 10.2]] }]),
      component('c8', OPT.large, 'Large Fish', 3, 2, 9, [[0, M.white, 1.2, 'fixed'], [1, M.orange, 0.3, 'fixed']], [{ id: 'l8', units: 24, minutes: 175, grams: 39.0, slots: [[0, 30.5], [1, 8.5]] }]),
      component('c9', OPT.large, 'Large Key', 1, 3, 9, [[0, M.silver, 2.4, SLOT.trim]], [{ id: 'l9', units: 10, minutes: 85, grams: 24.0 }]),
    ],
    parts: [] as any[],
  };
}

export type SardineRow = FixtureRow;

export const sardineConfig = (mutate?: (row: SardineRow) => void): ProductConfig => {
  const row = sardineRow();
  mutate?.(row);
  return toProductConfig(row);
};

/** Helper for a spec to add a component or option: same shape as the fixture's. */
export { component as fixtureComponent, mat as fixtureMaterial };

/** Colour key helper: `key([0, M.red])` → "0:m-red". */
export const key = (...slots: Array<[number, string]>) => slots.map(([i, m]) => `${i}:${m}`).join('|');

/**
 * A Prisma stand-in for the resolver: product.findUnique serves the given rows,
 * productVariant/orderItem lookups serve the rows' options.
 */
export function resolverPrisma(rows: any[], extra: Record<string, any> = {}) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const variants = rows.flatMap((r) => (r.variants ?? []).map((v: any) => ({ id: v.id, productId: r.id, kind: v.kind, name: v.name })));
  return {
    product: {
      findUnique: jest.fn(async ({ where }: any) => byId.get(where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    productVariant: {
      findMany: jest.fn(async ({ where }: any) => variants.filter((v) => where.id.in.includes(v.id))),
      findUnique: jest.fn(async ({ where }: any) => variants.find((v) => v.id === where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    orderItem: { findMany: jest.fn(async () => extra.orderItems ?? []) },
    ...extra,
  };
}
