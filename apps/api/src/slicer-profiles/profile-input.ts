import { BadRequestException } from '@nestjs/common';
import { MaterialType, SlicerProfileKind, type CreateStockProfileDto } from '@printforge/types';
import { allowedBody } from '../common/utils/validate-number';

/** PATCH /slicer-profiles/:id after the allowlist. undefined = leave alone, null = clear. */
export interface SlicerProfilePatch {
  printerId?: string | null;
  materialId?: string | null;
  materialType?: MaterialType | null;
  isDefault?: boolean;
}

const PATCH_KEYS = ['printerId', 'materialId', 'materialType', 'isDefault'] as const;
const KINDS = Object.values(SlicerProfileKind) as SlicerProfileKind[];
const MATERIAL_TYPES = Object.values(MaterialType) as MaterialType[];
const MAX_STOCK_NAME = 200;
const MAX_STOCK_QUERY = 100;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function optionalId(raw: unknown, field: string): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !ID_RE.test(raw)) throw new BadRequestException(`"${field}" must be an id`);
  return raw;
}

/**
 * Allowlisted PATCH body: the DTO is an interface, so the global ValidationPipe
 * cannot whitelist it; without this an extra key would reach Prisma as a
 * nested write.
 */
export function parseProfilePatch(raw: unknown): SlicerProfilePatch {
  const body = allowedBody(raw, PATCH_KEYS);
  const patch: SlicerProfilePatch = {};
  const printerId = optionalId(body.printerId, 'printerId');
  if (printerId !== undefined) patch.printerId = printerId;
  const materialId = optionalId(body.materialId, 'materialId');
  if (materialId !== undefined) patch.materialId = materialId;
  if (body.materialType !== undefined) {
    if (body.materialType === null || body.materialType === '') patch.materialType = null;
    else if (MATERIAL_TYPES.includes(body.materialType as MaterialType)) patch.materialType = body.materialType as MaterialType;
    else throw new BadRequestException(`"materialType" must be one of ${MATERIAL_TYPES.join(', ')}`);
  }
  if (body.isDefault !== undefined) {
    if (typeof body.isDefault !== 'boolean') throw new BadRequestException('"isDefault" must be true or false');
    patch.isDefault = body.isDefault;
  }
  if (Object.keys(patch).length === 0) throw new BadRequestException('Nothing to update');
  return patch;
}

function parseKind(raw: unknown): SlicerProfileKind {
  if (typeof raw !== 'string' || !KINDS.includes(raw as SlicerProfileKind)) {
    throw new BadRequestException(`"kind" must be one of ${KINDS.join(', ')}`);
  }
  return raw as SlicerProfileKind;
}

/** GET /slicer-profiles/stock query: a kind and an optional search text (at most 100 characters). */
export function parseStockQuery(kind: unknown, q: unknown): { kind: SlicerProfileKind; q: string } {
  if (q !== undefined && typeof q !== 'string') throw new BadRequestException('"q" must be text');
  return { kind: parseKind(kind), q: (q ?? '').trim().slice(0, MAX_STOCK_QUERY) };
}

/** Allowlisted POST /slicer-profiles/stock body. */
export function parseCreateStock(raw: unknown): CreateStockProfileDto {
  const body = allowedBody(raw, ['kind', 'name']);
  const kind = parseKind(body.kind);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > MAX_STOCK_NAME) throw new BadRequestException('"name" must be the name of a stock preset');
  return { kind, name };
}
