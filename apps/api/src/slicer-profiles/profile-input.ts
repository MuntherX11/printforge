import { BadRequestException } from '@nestjs/common';
import { allowedBody } from '../common/utils/validate-number';

/** PATCH /slicer-profiles/:id after the allowlist. undefined = leave alone, null = clear. */
export interface SlicerProfilePatch {
  printerId?: string | null;
  materialId?: string | null;
  isDefault?: boolean;
}

const PATCH_KEYS = ['printerId', 'materialId', 'isDefault'] as const;
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
  if (body.isDefault !== undefined) {
    if (typeof body.isDefault !== 'boolean') throw new BadRequestException('"isDefault" must be true or false');
    patch.isDefault = body.isDefault;
  }
  if (Object.keys(patch).length === 0) throw new BadRequestException('Nothing to update');
  return patch;
}
