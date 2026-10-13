import { BadRequestException } from '@nestjs/common';
import { MAX_UNITS_PER_PLATE, ORDER_PLATE_MAX_ITEMS, OrderPlateKind } from '@printforge/types';
import { allowedBody, optionalNumber, requiredNumber } from '../common/utils/validate-number';

/**
 * Allowlist parsers for the order print-plan routes (decision 28: bodies are
 * allowlisted, every number bounded). A body is read key by key; nothing of
 * it ever reaches Prisma as it came.
 */

export const ITEM_UNITS = { min: 1, max: MAX_UNITS_PER_PLATE, integer: true } as const;
export const LAYOUT_PLATE_COUNT = { min: 1, max: 200, integer: true } as const;
/** `<orderItemId>:<componentId>`, two ids of at most 64 characters. */
const ROW_KEY = /^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/;
const KINDS = Object.values(OrderPlateKind);

export interface PlateItemInput {
  rowKey: string;
  units: number;
}

export interface CreatePlateInput {
  kind: OrderPlateKind;
  /** undefined = not sent */
  printerId?: string | null;
  items: PlateItemInput[];
  layoutId: string | null;
  plateCount?: number;
}

export interface UpdatePlateInput {
  printerId?: string | null;
  items?: PlateItemInput[];
  plateCount?: number;
}

function nullableId(raw: unknown, field: string): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 64) throw new BadRequestException(`"${field}" must be an id`);
  return raw.trim();
}

function parseItems(raw: unknown): PlateItemInput[] {
  if (!Array.isArray(raw)) throw new BadRequestException('"items" must be a list of parts');
  if (!raw.length) throw new BadRequestException('A plate needs at least one part');
  if (raw.length > ORDER_PLATE_MAX_ITEMS) throw new BadRequestException(`A plate can hold at most ${ORDER_PLATE_MAX_ITEMS} different parts`);
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new BadRequestException(`"items[${i}]" must be a part and its units`);
    const e = allowedBody(entry, ['rowKey', 'units']);
    if (typeof e.rowKey !== 'string' || !ROW_KEY.test(e.rowKey)) throw new BadRequestException(`"items[${i}].rowKey" is not a part of this order`);
    if (seen.has(e.rowKey)) throw new BadRequestException('The same part is on the plate twice — give it one line with all its units');
    seen.add(e.rowKey);
    return { rowKey: e.rowKey, units: requiredNumber(e.units, `items[${i}].units`, ITEM_UNITS) };
  });
}

/** POST /orders/:id/print-plan/plates */
export function parseCreatePlate(raw: unknown): CreatePlateInput {
  const b = allowedBody(raw, ['kind', 'printerId', 'items', 'layoutId', 'plateCount']);
  const kind = typeof b.kind === 'string' ? (b.kind.trim().toUpperCase() as OrderPlateKind) : ('' as OrderPlateKind);
  if (!KINDS.includes(kind)) throw new BadRequestException(`"kind" must be one of: ${KINDS.join(', ')}`);
  const out: CreatePlateInput = {
    kind,
    items: parseItems(b.items),
    layoutId: nullableId(b.layoutId, 'layoutId') ?? null,
  };
  const printerId = nullableId(b.printerId, 'printerId');
  if (printerId !== undefined) out.printerId = printerId;
  const plateCount = optionalNumber(b.plateCount, 'plateCount', LAYOUT_PLATE_COUNT);
  if (plateCount !== undefined) out.plateCount = plateCount;
  return out;
}

/** PATCH /order-plates/:id — at least one of its three keys. */
export function parseUpdatePlate(raw: unknown): UpdatePlateInput {
  const b = allowedBody(raw, ['printerId', 'items', 'plateCount']);
  const out: UpdatePlateInput = {};
  const printerId = nullableId(b.printerId, 'printerId');
  if (printerId !== undefined) out.printerId = printerId;
  if (b.items !== undefined) out.items = parseItems(b.items);
  const plateCount = optionalNumber(b.plateCount, 'plateCount', LAYOUT_PLATE_COUNT);
  if (plateCount !== undefined) out.plateCount = plateCount;
  if (!Object.keys(out).length) throw new BadRequestException('Nothing to change — send a printer, the parts or a plate count');
  return out;
}

/** A route with no body: anything sent is refused, as the other routes refuse unknown keys. */
export function parseNoBody(raw: unknown): void {
  allowedBody(raw, []);
}
