/**
 * Shared fixtures of the e2e run: sessions, §3.8 settings, the pricing printer,
 * test filaments and spools, the test customer, and small API helpers.
 */
import { check } from './client.mjs';

/** §3.8 worked-example settings (plus tax 0 so step 6's total is 24.000). */
const TEST_SETTINGS = { overhead_percent: '15', electricity_rate_kwh: '0.025', purge_waste_grams: '5', tax_rate: '0' };

export async function setup(ctx) {
  const { args, admin, viewer, customer, ts, ids } = ctx;
  await admin.loginStaff(args.admin.email, args.admin.password);
  const me = await admin.ok('GET', '/auth/me');
  check(me?.role === 'ADMIN', `--admin must be an ADMIN user (got ${me?.role})`);
  await viewer.loginStaff(args.viewer.email, args.viewer.password);
  const vme = await viewer.ok('GET', '/auth/me');
  check(vme?.role === 'VIEWER', `--viewer must be a VIEWER user (got ${vme?.role})`);

  const current = await admin.ok('GET', '/settings');
  ctx.savedSettings = Object.fromEntries(Object.keys(TEST_SETTINGS).map((k) => [k, current?.[k] ?? null]));
  await admin.ok('PUT', '/settings', { settings: Object.entries(TEST_SETTINGS).map(([key, value]) => ({ key, value })) });

  const printer = await admin.ok('POST', '/printers', { name: `${ts} printer`, connectionType: 'MANUAL', hourlyRate: 0.4, wattage: 200, markupMultiplier: 2.5 });
  ids.printer = printer.id;

  const material = async (colour, costPerGram, hex) =>
    (await admin.ok('POST', '/materials', { name: `${ts} PLA ${colour}`, type: 'PLA', color: colour, colorHex: hex, brand: 'E2E', costPerGram })).id;
  ids.black = await material('Black', 0.01, '0B0B0C');
  ids.red = await material('Red', 0.012, 'C4402B');
  ids.blue = await material('Blue', 0.012, '2041C1');
  const spool = async (materialId) => (await admin.ok('POST', '/spools', { materialId, initialWeight: 1000, currentWeight: 1000 })).id;
  ids.blackSpool = await spool(ids.black);
  ids.redSpool = await spool(ids.red);
  ids.blueSpool = await spool(ids.blue);

  const email = `${ts.toLowerCase()}@example.com`;
  const password = `E2e-${Math.random().toString(36).slice(2)}-pw`;
  const signup = await customer.ok('POST', '/auth/customer/signup', { name: `${ts} Customer`, email, password });
  ids.customer = signup.id;
  await admin.ok('POST', `/auth/customers/${ids.customer}/approve`);
  await customer.loginCustomer(email, password);
}

export async function restoreSettings(ctx) {
  if (!ctx.savedSettings || !ctx.admin.cookie) return;
  const settings = Object.entries(ctx.savedSettings).filter(([, v]) => v !== null).map(([key, value]) => ({ key, value: String(value) }));
  if (settings.length) await ctx.admin.ok('PUT', '/settings', { settings });
}

// ---- helpers -----------------------------------------------------------------

export const product = (ctx, id) => ctx.admin.ok('GET', `/products/${id}`);
export const cost = (ctx, id, q = '') => ctx.admin.ok('GET', `/products/${id}/cost${q}`);
export const order = (ctx, id) => ctx.admin.ok('GET', `/orders/${id}`);
export const job = (ctx, id) => ctx.admin.ok('GET', `/jobs/${id}`);
export const plan = (ctx, orderId) => ctx.admin.ok('GET', `/jobs/plan/${orderId}`);
export const spoolWeight = async (ctx, id) => (await ctx.admin.ok('GET', `/spools/${id}`)).currentWeight;

export function componentOf(detail, description) {
  const all = [...(detail.components ?? []), ...(detail.sizes ?? []).flatMap((s) => s.components ?? [])];
  const c = all.find((x) => x.description === description);
  check(c, `component "${description}" not found on ${detail.name}`);
  return c;
}

/** A product with the pricing printer and one manual "Box" (9.4 g, 34 min, test PLA Black). */
export async function productWithBox(ctx, name, box = { description: 'Box', gramsUsed: 9.4, printMinutes: 34 }) {
  const p = await ctx.admin.ok('POST', '/products', { name: `${ctx.ts} ${name}`, defaultPrinterId: ctx.ids.printer });
  const c = await ctx.admin.ok('POST', `/products/${p.id}/components`, { materialId: ctx.ids.black, quantity: 1, ...box });
  return { id: p.id, name: p.name, boxId: c.id };
}

/** ×12 (243 min / 112.8 g) and ×8 (170 min / 75.2 g) manual layouts (step 3). */
export async function addBoxLayouts(ctx, productId, componentId) {
  const add = async (unitsPerPlate, plateMinutes, plateGrams) =>
    (await ctx.admin.ok('POST', `/products/${productId}/components/${componentId}/plate-layouts`, { unitsPerPlate, plateMinutes, plateGrams })).layout;
  return { x12: await add(12, 243, 112.8), x8: await add(8, 170, 75.2) };
}

export async function staffOrder(ctx, items, extra = {}) {
  return ctx.admin.ok('POST', '/orders', { customerId: ctx.ids.customer, items, ...extra });
}

/** J4 then J5 for an order with one row per line; `row` merges into every row. */
export async function planAndCreate(ctx, orderId, row = {}) {
  const p = await plan(ctx, orderId);
  const rows = p.rows.map((r) => ({ rowKey: r.rowKey, printerId: ctx.ids.printer, ...row }));
  const body = { planVersion: p.planVersion, rows };
  const created = await ctx.admin.ok('POST', `/jobs/plan/${orderId}`, body);
  return { plan: p, body, created };
}

/** Sorted "units×count" list, e.g. ["12x2","8x1"]. */
export const platesOf = (plates) => plates.map((x) => `${x.unitsPerPlate}x${x.plateCount}`).sort((a, b) => Number(b.split('x')[0]) - Number(a.split('x')[0]));

export const sumGrams = (materials) => Math.round(materials.reduce((s, m) => s + m.gramsUsed, 0) * 1000) / 1000;

/** Every key anywhere in a JSON value (for "the response has no X" checks). */
export function deepKeys(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); deepKeys(x, out); }
  return out;
}
