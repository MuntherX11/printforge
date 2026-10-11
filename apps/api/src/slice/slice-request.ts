import { BadRequestException } from '@nestjs/common';
import { MAX_UNITS_PER_PLATE, SLOT_KEYS, type SliceRequestDto, type SlotKey } from '@printforge/types';
import { allowedBody, optionalNumber } from '../common/utils/validate-number';

/**
 * Allowlist parser for `POST /products/:id/components/:cid/slice` (decision
 * 28: bodies are allowlisted, every number bounded). `units` is an integer
 * 1..500; `materials` keys are the slot keys "0".."3" and its values filament
 * ids. Either `units` or `fill: true` must be given; `fill` wins when both are.
 */

export const UNITS_BOUNDS = { min: 1, max: MAX_UNITS_PER_PLATE, integer: true } as const;

export interface SliceRequest {
  printerId: string | null;
  materials: Partial<Record<SlotKey, string>>;
  units: number | null;
  fill: boolean;
}

function id(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 64) throw new BadRequestException(`"${field}" must be an id`);
  return raw.trim();
}

export function parseSliceRequest(raw: unknown): SliceRequest {
  const b = allowedBody(raw, ['printerId', 'materials', 'units', 'fill']) as Partial<SliceRequestDto> & Record<string, unknown>;
  const printerId = b.printerId === undefined || b.printerId === null || b.printerId === '' ? null : id(b.printerId, 'printerId');
  const materials: Partial<Record<SlotKey, string>> = {};
  if (b.materials !== undefined && b.materials !== null) {
    if (typeof b.materials !== 'object' || Array.isArray(b.materials)) throw new BadRequestException('"materials" must be an object');
    for (const [k, v] of Object.entries(b.materials as Record<string, unknown>)) {
      if (!(SLOT_KEYS as readonly string[]).includes(k)) throw new BadRequestException(`"materials" keys must be slot numbers ${SLOT_KEYS.join(', ')}`);
      materials[k as SlotKey] = id(v, `materials[${k}]`);
    }
  }
  if (b.fill !== undefined && typeof b.fill !== 'boolean') throw new BadRequestException('"fill" must be true or false');
  const fill = b.fill === true;
  const units = optionalNumber(b.units, 'units', UNITS_BOUNDS) ?? null;
  if (!fill && units === null) throw new BadRequestException('"units" is required unless "fill" is true');
  return { printerId, materials, units, fill };
}
