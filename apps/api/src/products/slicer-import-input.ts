import { BadRequestException } from '@nestjs/common';
import { optionalNumber, requiredNumber } from '../common/utils/validate-number';
import { asBody, stripHtml } from './product-input';

/**
 * Allowlist parsers for the slicer-import and plate-layout routes (spec §4.3
 * M1–M5, bounds §3.4 / §4.7). Multipart form fields arrive as JSON strings;
 * already-parsed values are accepted too. Every number is bounded and a bad
 * value is a 400 naming the field. Nothing here touches the database or a
 * staged upload, so every check runs before an upload is consumed.
 */

type Body = Record<string, unknown>;

export const MAX_IMPORT_FILES = 20;
export const MAX_SELECTED_PLATES = 100;
export const UNITS_BOUNDS = { min: 1, max: 500, integer: true } as const;
export const MINUTES_BOUNDS = { min: 1, max: 100_000 } as const;
export const GRAMS_BOUNDS = { min: 0.1, max: 100_000 } as const;
export const COLOR_CHANGES_BOUNDS = { min: 0, max: 10_000, integer: true } as const;
export const SORT_ORDER_BOUNDS = { min: 0, max: 10_000, integer: true } as const;
export const LAYOUT_NAME_MAX = 60;

/** A multipart JSON field: absent/'' → undefined; a string must be valid JSON. */
export function jsonField(raw: unknown, field: string): unknown {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequestException(`"${field}" must be valid JSON`);
  }
}

function id(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 64) throw new BadRequestException(`"${field}" must be an id`);
  return raw.trim();
}

/** `sizeOptionId`, or its one-release alias `variantId` (§3.12 "Target"). */
export function parseImportTarget(body: unknown): string | null {
  const b = asBody(body);
  const raw = b.sizeOptionId ?? b.variantId;
  if (raw === undefined || raw === null || raw === '' || raw === 'standard') return null;
  return id(raw, b.sizeOptionId !== undefined ? 'sizeOptionId' : 'variantId');
}

function keyOf(k: string, field: string, allowed: (n: number) => boolean, what: string): number {
  if (!/^\d{1,6}$/.test(k)) throw new BadRequestException(`"${field}" keys must be ${what}`);
  const n = Number(k);
  if (!allowed(n)) throw new BadRequestException(`"${field}[${k}]" isn't ${what}`);
  return n;
}

function mapOf(raw: unknown, field: string): Body | undefined {
  const v = jsonField(raw, field);
  if (v === undefined) return undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BadRequestException(`"${field}" must be an object`);
  return v as Body;
}

/** `units`: `{ [key]: int 1–500 }`, keys restricted to `allowed`. */
export function parseUnits(raw: unknown, allowed: (n: number) => boolean, what: string): Map<number, number> {
  const out = new Map<number, number>();
  const m = mapOf(raw, 'units');
  if (!m) return out;
  for (const [k, v] of Object.entries(m)) {
    const key = keyOf(k, 'units', allowed, what);
    out.set(key, requiredNumber(v, `units[${k}]`, UNITS_BOUNDS));
  }
  return out;
}

/** `targets`: `{ [key]: componentId }`, keys restricted to `allowed`. */
export function parseTargets(raw: unknown, allowed: (n: number) => boolean, what: string): Map<number, string> {
  const out = new Map<number, string>();
  const m = mapOf(raw, 'targets');
  if (!m) return out;
  for (const [k, v] of Object.entries(m)) {
    const key = keyOf(k, 'targets', allowed, what);
    out.set(key, id(v, `targets[${k}]`));
  }
  return out;
}

/** M1 `assembledUploadIds`: a JSON list of staged-upload ids (format checked again by ChunkUploadsService). */
export function parseAssembledIds(raw: unknown): string[] {
  const v = jsonField(raw, 'assembledUploadIds');
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new BadRequestException('"assembledUploadIds" must be a list');
  if (v.length > MAX_IMPORT_FILES) throw new BadRequestException(`At most ${MAX_IMPORT_FILES} files per import`);
  return v.map((x, i) => id(x, `assembledUploadIds[${i}]`));
}

/** M2 `selectedPlates`: 1–100 distinct int plate indexes (presence in the file is checked once it is read). */
export function parseSelectedPlates(raw: unknown): number[] {
  const v = jsonField(raw, 'selectedPlates');
  if (!Array.isArray(v)) throw new BadRequestException('"selectedPlates" must be a list of plate numbers');
  if (v.length < 1) throw new BadRequestException('No plates selected');
  if (v.length > MAX_SELECTED_PLATES) throw new BadRequestException(`"selectedPlates" must have 1 to ${MAX_SELECTED_PLATES} entries`);
  const out = v.map((x, i) => {
    if (typeof x !== 'number') throw new BadRequestException(`"selectedPlates[${i}]" must be a number`);
    return requiredNumber(x, `selectedPlates[${i}]`, { min: 0, max: 10_000, integer: true });
  });
  if (new Set(out).size !== out.length) throw new BadRequestException('"selectedPlates" lists a plate twice');
  return out;
}

/** M2 `plateNames`: `{ [plateIndex]: name }`, trimmed, HTML stripped, ≤120 chars. */
export function parsePlateNames(raw: unknown): Record<string, string> {
  const m = mapOf(raw, 'plateNames');
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const [k, v] of Object.entries(m)) {
    if (!/^\d{1,6}$/.test(k)) continue;
    if (typeof v !== 'string') continue;
    const s = stripHtml(v).slice(0, 120);
    if (s) out[k] = s;
  }
  return out;
}

export interface GcodeImportInput {
  sizeOptionId: string | null;
  assembledUploadIds: string[];
  units: Map<number, number>;
  targets: Map<number, string>;
}

/** M1 body. `fileCount` = multipart files + staged ids; unit/target keys must name one of them. */
export function parseGcodeImport(body: unknown, multipartCount: number): GcodeImportInput {
  const b = asBody(body);
  const assembledUploadIds = parseAssembledIds(b.assembledUploadIds);
  const total = multipartCount + assembledUploadIds.length;
  if (total > MAX_IMPORT_FILES) throw new BadRequestException(`At most ${MAX_IMPORT_FILES} files per import`);
  const isFile = (n: number) => n >= 0 && n < Math.min(total, MAX_IMPORT_FILES);
  const what = 'the index of a sent file';
  return {
    sizeOptionId: parseImportTarget(b),
    assembledUploadIds,
    units: parseUnits(b.units, isFile, what),
    targets: parseTargets(b.targets, isFile, what),
  };
}

export interface ThreeMfImportInput {
  sizeOptionId: string | null;
  selectedPlates: number[];
  plateNames: Record<string, string>;
  units: Map<number, number>;
  targets: Map<number, string>;
}

/** M2 body (everything but the file). Unit/target keys must be selected plates. */
export function parseThreeMfImport(body: unknown): ThreeMfImportInput {
  const b = asBody(body);
  const selectedPlates = parseSelectedPlates(b.selectedPlates);
  const isSelected = (n: number) => selectedPlates.includes(n);
  const what = 'one of the selected plates';
  return {
    sizeOptionId: parseImportTarget(b),
    selectedPlates,
    plateNames: parsePlateNames(b.plateNames),
    units: parseUnits(b.units, isSelected, what),
    targets: parseTargets(b.targets, isSelected, what),
  };
}

// ------------------------------------------------------------- plate layouts

function layoutName(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new BadRequestException('"name" must be text');
  const s = stripHtml(raw);
  if (s.length > LAYOUT_NAME_MAX) throw new BadRequestException(`"name" must be at most ${LAYOUT_NAME_MAX} characters`);
  return s || undefined;
}

export interface LayoutCreateInput {
  assembledUploadId: string | null;
  unitsPerPlate?: number;
  plateMinutes?: number;
  plateGrams?: number;
  colorChanges?: number;
  name?: string;
}

/** M3. Without `assembledUploadId` (manual) all three numbers are required. */
export function parseLayoutCreate(raw: unknown): LayoutCreateInput {
  const b = asBody(raw);
  const assembledUploadId = b.assembledUploadId === undefined || b.assembledUploadId === null || b.assembledUploadId === ''
    ? null : id(b.assembledUploadId, 'assembledUploadId');
  const out: LayoutCreateInput = {
    assembledUploadId,
    unitsPerPlate: optionalNumber(b.unitsPerPlate, 'unitsPerPlate', UNITS_BOUNDS),
    plateMinutes: optionalNumber(b.plateMinutes, 'plateMinutes', MINUTES_BOUNDS),
    plateGrams: optionalNumber(b.plateGrams, 'plateGrams', GRAMS_BOUNDS),
    colorChanges: optionalNumber(b.colorChanges, 'colorChanges', COLOR_CHANGES_BOUNDS),
    name: layoutName(b.name),
  };
  if (!assembledUploadId) {
    if (out.unitsPerPlate === undefined) throw new BadRequestException('"unitsPerPlate" is required');
    if (out.plateMinutes === undefined) throw new BadRequestException('"plateMinutes" is required');
    if (out.plateGrams === undefined) throw new BadRequestException('"plateGrams" is required');
  }
  return out;
}

export interface LayoutPatchInput {
  name?: string;
  unitsPerPlate?: number;
  plateMinutes?: number;
  plateGrams?: number;
  colorChanges?: number;
  isActive?: boolean;
  sortOrder?: number;
}

/** M4 allowlist. */
export function parseLayoutPatch(raw: unknown): LayoutPatchInput {
  const b = asBody(raw);
  const out: LayoutPatchInput = {};
  if (b.name !== undefined) {
    const n = layoutName(b.name);
    if (!n) throw new BadRequestException('"name" can\'t be empty');
    out.name = n;
  }
  const units = optionalNumber(b.unitsPerPlate, 'unitsPerPlate', UNITS_BOUNDS);
  if (units !== undefined) out.unitsPerPlate = units;
  const minutes = optionalNumber(b.plateMinutes, 'plateMinutes', MINUTES_BOUNDS);
  if (minutes !== undefined) out.plateMinutes = minutes;
  const grams = optionalNumber(b.plateGrams, 'plateGrams', GRAMS_BOUNDS);
  if (grams !== undefined) out.plateGrams = grams;
  const cc = optionalNumber(b.colorChanges, 'colorChanges', COLOR_CHANGES_BOUNDS);
  if (cc !== undefined) out.colorChanges = cc;
  const so = optionalNumber(b.sortOrder, 'sortOrder', SORT_ORDER_BOUNDS);
  if (so !== undefined) out.sortOrder = so;
  if (b.isActive !== undefined) {
    if (typeof b.isActive !== 'boolean') throw new BadRequestException('"isActive" must be true or false');
    out.isActive = b.isActive;
  }
  return out;
}
