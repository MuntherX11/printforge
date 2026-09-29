import { BadRequestException } from '@nestjs/common';
import { allowedBody, optionalText } from '../common/utils/validate-number';

/**
 * Allowlist parsers for the staff customer bodies (POST and PATCH /customers).
 *
 * CreateCustomerDto and UpdateCustomerDto are interfaces, so the global
 * ValidationPipe never strips extra keys, and the body used to reach Prisma
 * as-is. Any staff role could then write passwordHash, refreshToken,
 * isApproved or portalAccess (a ready-to-use portal login that skips the
 * ADMIN-only approve route), or nested relation writes such as
 * `orders: { connect: [...] }` or `orders: { update: { data: { status } } }`.
 *
 * These routes write only the contact card the staff screens edit. Portal
 * approval stays on POST /auth/customers/:id/approve and /reject (ADMIN), and
 * the login secrets are never writable here. Any other key is refused with a
 * 400 worded like the ValidationPipe ("property x should not exist").
 */
export const CUSTOMER_KEYS = ['name', 'email', 'phone', 'address', 'notes'] as const;

/** Length caps. Longer text is cut, as optionalText does elsewhere. */
const MAX = { name: 200, email: 254, phone: 50, address: 1000, notes: 10_000 } as const;

export interface CustomerCreateInput {
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
}

export type CustomerPatchInput = Partial<CustomerCreateInput>;

function customerName(raw: unknown): string {
  if (typeof raw !== 'string') throw new BadRequestException('Name is required');
  const s = raw.trim().slice(0, MAX.name).trim();
  if (!s) throw new BadRequestException('Name is required');
  return s;
}

/** POST /customers: name is required; the other fields are optional text. */
export function parseCustomerCreate(raw: unknown): CustomerCreateInput {
  const b = allowedBody(raw, CUSTOMER_KEYS);
  return {
    name: customerName(b.name),
    email: optionalText(b.email, 'email', MAX.email) ?? null,
    phone: optionalText(b.phone, 'phone', MAX.phone) ?? null,
    address: optionalText(b.address, 'address', MAX.address) ?? null,
    notes: optionalText(b.notes, 'notes', MAX.notes) ?? null,
  };
}

/**
 * PATCH /customers/:id: a key that is absent (or undefined) is left alone, a
 * null or blank optional field is cleared, and name, when sent, must not be
 * blank.
 */
export function parseCustomerPatch(raw: unknown): CustomerPatchInput {
  const b = allowedBody(raw, CUSTOMER_KEYS);
  const out: CustomerPatchInput = {};
  if (b.name !== undefined) out.name = customerName(b.name);
  for (const key of ['email', 'phone', 'address', 'notes'] as const) {
    const value = optionalText(b[key], key, MAX[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}
