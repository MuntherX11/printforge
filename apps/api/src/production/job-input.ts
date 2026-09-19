import { BadRequestException } from '@nestjs/common';
import type { SurplusPolicy } from '@printforge/types';
import { optionalNumber, requiredEnum, requiredNumber } from '../common/utils/validate-number';

/**
 * Allowlist parsers for the production routes (spec §0.2 "Validation", §4.4,
 * §4.7 bounds). Plain-interface DTOs are never trusted: every body is read key
 * by key, unknown keys are ignored, and nothing is ever spread into Prisma data.
 */

export const JOB_PURPOSES = ['CUSTOMER', 'TEST', 'SAMPLE', 'WASTE'] as const;
export const SURPLUS_POLICIES = ['CANCEL_ON_PRINTER', 'KEEP_FOR_STOCK'] as const;
export const STOCK_MODES = ['BUILD_STOCK', 'DIRECT_SALE'] as const;
export const PATCH_STATUSES = ['QUEUED', 'IN_PROGRESS', 'PAUSED', 'CANCELLED'] as const;

export const MAX_PLATES = 200;
export const MAX_PLATE_COUNT = 10_000;
export const MAX_JOB_QTY = 100_000;

type Body = Record<string, unknown>;

export interface PlateInput {
  componentId: string;
  layoutId: string | null;
  plateCount: number;
}

const obj = (raw: unknown): Body => (raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Body) : {});

/** A string id, or undefined when absent. */
export function optionalId(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new BadRequestException(`"${field}" must be a string`);
  return raw.trim() || undefined;
}

/** A string id or explicit null (for "clear it"); undefined when absent. */
export function nullableId(raw: unknown, field: string): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new BadRequestException(`"${field}" must be a string or null`);
  return raw.trim() || null;
}

function optionalText(raw: unknown, field: string, max: number): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new BadRequestException(`"${field}" must be text`);
  const s = raw.trim();
  if (s.length > max) throw new BadRequestException(`"${field}" must be at most ${max} characters`);
  return s || undefined;
}

export function optionalPolicy(raw: unknown): SurplusPolicy | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  return requiredEnum(raw, 'surplusPolicy', SURPLUS_POLICIES);
}

export function optionalStockMode(raw: unknown): 'BUILD_STOCK' | 'DIRECT_SALE' | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  return requiredEnum(raw, 'stockMode', STOCK_MODES);
}

/**
 * J1/J2 `plates`: ≤200 entries of `{ componentId, layoutId|null, plateCount }`,
 * plateCount int 1–10000 (§3.5, §4.7). J5 rows omit componentId (the row names it).
 */
export function parsePlates(raw: unknown, field = 'plates', opts: { componentId?: string } = {}): PlateInput[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new BadRequestException(`"${field}" must be a list`);
  if (raw.length > MAX_PLATES) throw new BadRequestException(`"${field}" can have at most ${MAX_PLATES} entries`);
  return raw.map((p, i) => {
    const e = obj(p);
    const componentId = opts.componentId ?? optionalId(e.componentId, `${field}[${i}].componentId`);
    if (!componentId) throw new BadRequestException(`"${field}[${i}].componentId" is required`);
    const layoutId = nullableId(e.layoutId, `${field}[${i}].layoutId`) ?? null;
    const plateCount = requiredNumber(e.plateCount, `${field}[${i}].plateCount`, { min: 1, max: MAX_PLATE_COUNT, integer: true });
    return { componentId, layoutId, plateCount };
  });
}

export interface CreateJobInput {
  name?: string;
  purpose: (typeof JOB_PURPOSES)[number];
  productId?: string;
  variantId?: string;
  sizeOptionId?: string | null;
  colourOptionId?: string | null;
  printerId?: string;
  assignedToId?: string;
  orderId?: string;
  orderItemId?: string;
  gcodeFilename?: string;
  colorChanges: number;
  quantityToProduce: number;
  surplusPolicy?: SurplusPolicy;
  stockMode?: 'BUILD_STOCK' | 'DIRECT_SALE';
  plates?: PlateInput[];
  materials: Array<{ spoolId: string; gramsUsed: number }>;
}

/** J1 body (§4.4, §3.7 "Linkage validation"). */
export function parseCreateJob(raw: unknown): CreateJobInput {
  const b = obj(raw);
  if (b.componentId !== undefined && b.componentId !== null && b.componentId !== '') {
    throw new BadRequestException("componentId is set by the order's production plan");
  }
  const purpose = b.purpose === undefined || b.purpose === null ? 'CUSTOMER' : requiredEnum(b.purpose, 'purpose', JOB_PURPOSES);
  const orderId = optionalId(b.orderId, 'orderId');
  const stockMode = optionalStockMode(b.stockMode);
  if (stockMode && orderId) throw new BadRequestException('stockMode is only for jobs that are not for an order');
  const productId = optionalId(b.productId, 'productId');
  const plates = parsePlates(b.plates);
  if (plates && !productId) throw new BadRequestException('plates need a product');
  const materials = b.materials === undefined || b.materials === null ? [] : b.materials;
  if (!Array.isArray(materials)) throw new BadRequestException('"materials" must be a list');
  if (materials.length > 50) throw new BadRequestException('"materials" can have at most 50 lines');
  return {
    name: optionalText(b.name, 'name', 200),
    purpose,
    productId,
    variantId: optionalId(b.variantId, 'variantId'),
    sizeOptionId: nullableId(b.sizeOptionId, 'sizeOptionId'),
    colourOptionId: nullableId(b.colourOptionId, 'colourOptionId'),
    printerId: optionalId(b.printerId, 'printerId'),
    assignedToId: optionalId(b.assignedToId, 'assignedToId'),
    orderId,
    orderItemId: optionalId(b.orderItemId, 'orderItemId'),
    gcodeFilename: optionalText(b.gcodeFilename, 'gcodeFilename', 255),
    colorChanges: optionalNumber(b.colorChanges, 'colorChanges', { min: 0, max: 10_000, integer: true }) ?? 0,
    quantityToProduce: b.quantityToProduce === undefined || b.quantityToProduce === null
      ? 1
      : requiredNumber(b.quantityToProduce, 'quantityToProduce', { min: 1, max: MAX_JOB_QTY, integer: true }),
    surplusPolicy: optionalPolicy(b.surplusPolicy),
    stockMode,
    plates,
    materials: materials.map((m, i) => {
      const e = obj(m);
      return {
        spoolId: optionalId(e.spoolId, `materials[${i}].spoolId`) ?? '',
        gramsUsed: requiredNumber(e.gramsUsed, `materials[${i}].gramsUsed`, { min: 0.1, max: 100_000 }),
      };
    }),
  };
}

export interface PreviewInput {
  productId: string;
  variantId?: string;
  sizeOptionId?: string | null;
  colourOptionId?: string | null;
  quantity: number;
  surplusPolicy?: SurplusPolicy;
  stockMode?: 'BUILD_STOCK' | 'DIRECT_SALE';
  plates?: PlateInput[];
}

/** J2 body. */
export function parsePreview(raw: unknown): PreviewInput {
  const b = obj(raw);
  const productId = optionalId(b.productId, 'productId');
  const variantId = optionalId(b.variantId, 'variantId');
  if (!productId && !variantId) throw new BadRequestException('productId is required');
  return {
    productId: productId ?? '',
    variantId,
    sizeOptionId: nullableId(b.sizeOptionId, 'sizeOptionId'),
    colourOptionId: nullableId(b.colourOptionId, 'colourOptionId'),
    quantity: requiredNumber(b.quantity ?? b.qty, 'quantity', { min: 1, max: MAX_JOB_QTY, integer: true }),
    surplusPolicy: optionalPolicy(b.surplusPolicy),
    stockMode: optionalStockMode(b.stockMode),
    plates: parsePlates(b.plates),
  };
}

export interface UpdateJobInput {
  status?: (typeof PATCH_STATUSES)[number];
  printerId?: string | null;
  assignedToId?: string | null;
  printDuration?: number;
  filamentUsedMm?: number;
}

/** J8 allowlist (§3.7 "Updating a job"). Every other key is ignored. */
export function parseUpdateJob(raw: unknown): UpdateJobInput {
  const b = obj(raw);
  const out: UpdateJobInput = {};
  if (b.status !== undefined && b.status !== null) {
    const s = String(b.status).toUpperCase();
    if (s === 'COMPLETED' || s === 'FAILED') {
      throw new BadRequestException('Use /jobs/:id/complete or /jobs/:id/fail to transition to terminal states');
    }
    out.status = requiredEnum(s, 'status', PATCH_STATUSES);
  }
  if ('printerId' in b) out.printerId = nullableId(b.printerId, 'printerId') ?? null;
  if ('assignedToId' in b) out.assignedToId = nullableId(b.assignedToId, 'assignedToId') ?? null;
  const pd = optionalNumber(b.printDuration, 'printDuration', { min: 0, max: 10_000_000 });
  if (pd !== undefined) out.printDuration = pd;
  const mm = optionalNumber(b.filamentUsedMm, 'filamentUsedMm', { min: 0, max: 1_000_000_000 });
  if (mm !== undefined) out.filamentUsedMm = mm;
  return out;
}

/** J9 body: wasteGrams 0–100000, failureReason ≤500. */
export function parseFail(raw: unknown): { failureReason: string | null; wasteGrams: number } {
  const b = obj(raw);
  return {
    failureReason: optionalText(b.failureReason, 'failureReason', 500) ?? null,
    wasteGrams: optionalNumber(b.wasteGrams, 'wasteGrams', { min: 0, max: 100_000 }) ?? 0,
  };
}

/** J7 body: `{ plates?: [{ jobPlateId, plateCount }] }`; counts are checked against the originals by the service. */
export function parseReprint(raw: unknown): Array<{ jobPlateId: string; plateCount: number }> | undefined {
  const b = obj(raw);
  if (b.plates === undefined || b.plates === null) return undefined;
  if (!Array.isArray(b.plates)) throw new BadRequestException('"plates" must be a list');
  if (b.plates.length > MAX_PLATES) throw new BadRequestException(`"plates" can have at most ${MAX_PLATES} entries`);
  return b.plates.map((p, i) => {
    const e = obj(p);
    const jobPlateId = optionalId(e.jobPlateId, `plates[${i}].jobPlateId`);
    if (!jobPlateId) throw new BadRequestException(`"plates[${i}].jobPlateId" is required`);
    return { jobPlateId, plateCount: requiredNumber(e.plateCount, `plates[${i}].plateCount`, { min: 1, max: MAX_PLATE_COUNT, integer: true }) };
  });
}

export interface PlanRowInput {
  rowKey: string;
  fromStock?: number;
  toProduce?: number;
  plates?: Array<{ layoutId: string | null; plateCount: number }>;
  surplusPolicy?: SurplusPolicy;
  printerId?: string | null;
  spools?: Array<{ materialId: string; spoolId: string }>;
}

export interface PlanSubmitInput {
  planVersion: string;
  rows: PlanRowInput[];
}

/** J5 body (§4.4 J5 rule 7): bounds are checked before any lock is taken. */
export function parsePlanSubmit(raw: unknown): PlanSubmitInput {
  const b = obj(raw);
  if (b.overrides !== undefined) throw new BadRequestException('Reload the production plan');
  if (typeof b.planVersion !== 'string' || !b.planVersion.trim()) throw new BadRequestException('Reload the production plan');
  const rawRows = b.rows === undefined || b.rows === null ? [] : b.rows;
  if (!Array.isArray(rawRows)) throw new BadRequestException('"rows" must be a list');
  if (rawRows.length > 10_000) throw new BadRequestException('"rows" has too many entries');
  const rows = rawRows.map((r, i) => {
    const e = obj(r);
    const rowKey = optionalId(e.rowKey, `rows[${i}].rowKey`);
    if (!rowKey) throw new BadRequestException(`"rows[${i}].rowKey" is required`);
    const spools = e.spools === undefined || e.spools === null ? undefined : e.spools;
    if (spools !== undefined && !Array.isArray(spools)) throw new BadRequestException(`"rows[${i}].spools" must be a list`);
    if (spools && spools.length > 12) throw new BadRequestException(`"rows[${i}].spools" can have at most 12 entries`);
    return {
      rowKey,
      fromStock: optionalNumber(e.fromStock, `rows[${i}].fromStock`, { min: 0, max: 1_000_000, integer: true }),
      toProduce: optionalNumber(e.toProduce, `rows[${i}].toProduce`, { min: 0, max: 1_000_000, integer: true }),
      plates: parsePlates(e.plates, `rows[${i}].plates`, { componentId: '-' })?.map(({ layoutId, plateCount }) => ({ layoutId, plateCount })),
      surplusPolicy: optionalPolicy(e.surplusPolicy),
      printerId: 'printerId' in e ? nullableId(e.printerId, `rows[${i}].printerId`) ?? null : undefined,
      spools: spools?.map((s: unknown, k: number) => {
        const x = obj(s);
        const materialId = optionalId(x.materialId, `rows[${i}].spools[${k}].materialId`);
        const spoolId = optionalId(x.spoolId, `rows[${i}].spools[${k}].spoolId`);
        if (!materialId || !spoolId) throw new BadRequestException(`"rows[${i}].spools[${k}]" needs a materialId and a spoolId`);
        return { materialId, spoolId };
      }),
    };
  });
  return { planVersion: b.planVersion.trim(), rows };
}
