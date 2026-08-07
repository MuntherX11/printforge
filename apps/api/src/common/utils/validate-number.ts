import { BadRequestException } from '@nestjs/common';

/**
 * Shared numeric guards for inventory input.
 *
 * Written after live E2E testing found that materials, spools and parts all
 * accepted negative, fractional, absurd and non-finite values straight into the
 * database — which during a bulk inventory entry silently corrupts stock counts
 * and product costing. A typo of "-5" or "2.5" must fail loudly, not persist.
 *
 * All of these throw BadRequestException, so a bad value is a clean 400 rather
 * than a 500 from Prisma or NaN propagating into arithmetic.
 */

/** Finite number within [min, max]. Returns undefined when not supplied. */
export function optionalNumber(
  raw: unknown,
  field: string,
  { min = 0, max = 1e9, integer = false }: { min?: number; max?: number; integer?: boolean } = {},
): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  return requiredNumber(raw, field, { min, max, integer });
}

/** Finite number within [min, max]. Throws when missing or invalid. */
export function requiredNumber(
  raw: unknown,
  field: string,
  { min = 0, max = 1e9, integer = false }: { min?: number; max?: number; integer?: boolean } = {},
): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    throw new BadRequestException(`"${field}" must be a number`);
  }
  if (integer && !Number.isInteger(n)) {
    throw new BadRequestException(`"${field}" must be a whole number`);
  }
  if (n < min || n > max) {
    throw new BadRequestException(`"${field}" must be between ${min} and ${max}`);
  }
  return n;
}

/** Non-empty trimmed string, length-capped. */
export function requiredText(raw: unknown, field: string, maxLen = 200): string {
  const s = String(raw ?? '').trim();
  if (!s) throw new BadRequestException(`${field} is required`);
  return s.slice(0, maxLen);
}

/** Value must be one of `allowed`, else a clean 400 (not a Prisma enum 500). */
export function requiredEnum<T extends string>(raw: unknown, field: string, allowed: readonly T[]): T {
  const v = String(raw ?? '').trim().toUpperCase() as T;
  if (!allowed.includes(v)) {
    throw new BadRequestException(`"${field}" must be one of: ${allowed.join(', ')}`);
  }
  return v;
}
