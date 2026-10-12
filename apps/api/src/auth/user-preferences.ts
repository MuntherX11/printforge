import { BadRequestException } from '@nestjs/common';
import { PRODUCT_PAGE_LAYOUTS, type ProductPageLayout, type UserPreferences } from '@printforge/types';
import { allowedBody } from '../common/utils/validate-number';

/** The only keys PATCH /auth/me/preferences accepts. */
export const PREFERENCE_KEYS = ['productPageLayout'] as const;

function isObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

function isLayout(raw: unknown): raw is ProductPageLayout {
  return typeof raw === 'string' && (PRODUCT_PAGE_LAYOUTS as readonly string[]).includes(raw);
}

/**
 * What the client is told: the known keys with valid values only. Anything
 * else in the column (a key from a later version, a hand-edited row) is left
 * out rather than failing GET /auth/me.
 */
export function storedPreferences(raw: unknown): UserPreferences {
  const out: UserPreferences = {};
  if (isObject(raw) && isLayout(raw.productPageLayout)) out.productPageLayout = raw.productPageLayout;
  return out;
}

/** The request body as a patch: unknown keys and unknown values are a 400. */
export function parsePreferencesPatch(raw: unknown): UserPreferences {
  const body = allowedBody(raw, PREFERENCE_KEYS);
  const patch: UserPreferences = {};
  if (body.productPageLayout !== undefined) {
    if (!isLayout(body.productPageLayout)) {
      throw new BadRequestException(`"productPageLayout" must be one of: ${PRODUCT_PAGE_LAYOUTS.join(', ')}`);
    }
    patch.productPageLayout = body.productPageLayout;
  }
  return patch;
}

/** The stored JSON with the patch laid over it; keys the patch does not name are kept as stored. */
export function mergePreferences(stored: unknown, patch: UserPreferences): Record<string, unknown> {
  return { ...(isObject(stored) ? stored : {}), ...patch };
}
