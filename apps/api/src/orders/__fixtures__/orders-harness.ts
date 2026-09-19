/**
 * Wires the real WP7 services (orders, pricing preview) over WP6's
 * production harness (WP2 catalog-core, the stock ledger and job planning on the
 * in-memory database), the way OrdersModule and QuotesModule do.
 */
import { SETTINGS } from '../../catalog-core/__fixtures__/box-product';
import { PricingService } from '../../catalog-core/pricing.service';
import { productionHarness } from '../../production/__fixtures__/production-harness';
import { OrdersService } from '../orders.service';

export const CUSTOMER_ID = 'cust-1';

export function ordersHarness(rows: any[] = []) {
  const h = productionHarness(rows);
  const prisma = h.db as any;
  const pricing = new PricingService(prisma, h.resolver, { loadSettings: jest.fn(async () => ({ ...SETTINGS })) } as any);
  const discord = { notifyNewPortalOrder: jest.fn(async () => undefined) } as any;
  const orders = new OrdersService(prisma, pricing, h.resolver, h.planner, h.stock, undefined, undefined, undefined, discord, undefined);
  h.db.insert('customer', {
    id: CUSTOMER_ID, name: 'Ali', email: 'ali@example.com', phone: null, passwordHash: 'HASH', refreshToken: 'RT',
    userType: 'customer', isApproved: true,
  });
  return { ...h, pricing, orders, discord };
}

export type OrdersHarness = ReturnType<typeof ordersHarness>;

/** Keys that must never reach a customer (§0.2 "Customer responses"). */
export const STAFF_ONLY_KEYS = [
  'listUnitPrice', 'priceSource', 'tierMinQty', 'priceOverrideReason', 'estimatedCost', 'marginPercent',
  'passwordHash', 'refreshToken', 'customer',
];

/** Every key anywhere in a JSON value (objects and arrays, recursively). */
export function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) allKeys(v, out);
  else if (value && typeof value === 'object' && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

export function addTier(h: OrdersHarness, productId: string, sizeOptionId: string | null, minQty: number, unitPrice: number) {
  if (sizeOptionId) h.db.insert('variantPriceTier', { variantId: sizeOptionId, minQty, unitPrice });
  else h.db.insert('priceTier', { productId, minQty, unitPrice });
}

export function setTaxRate(h: OrdersHarness, percent: string) {
  h.db.insert('systemSetting', { key: 'tax_rate', value: percent });
}
