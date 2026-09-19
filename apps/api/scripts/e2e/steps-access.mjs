/** Steps 13–17: photos and their access matrix, delete vs deactivate, attachments, customer responses, legacy request shapes (spec §7.2). */
import fs from 'node:fs';
import path from 'node:path';
import { check, eq } from './client.mjs';
import { GPS_SECRET, SVG_AS_PNG, makeGcode, makeGpsJpeg, makePng } from './fixtures.mjs';
import { deepKeys, order, product, productWithBox } from './setup.mjs';

function photoForm(buf, filename, type) {
  const form = new FormData();
  form.append('files', new Blob([buf], { type }), filename);
  return form;
}

async function uploadPhoto(ctx, productId, buf, filename, type, expect = [200, 201]) {
  const r = await ctx.admin.req('POST', `/products/${productId}/images`, { form: photoForm(buf, filename, type), expect });
  const list = Array.isArray(r.data) ? r.data : r.data?.images ?? [];
  return { res: r, image: list[0] };
}

const G5_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'private, no-cache',
};

function listDir(dir) {
  try { return new Set(fs.readdirSync(dir)); } catch { return new Set(); }
}

async function step13(ctx) {
  const { admin, viewer, customer, anon, ids } = ctx;
  const pid = ids.product;
  const other = await productWithBox(ctx, 'Photo-free');
  ids.freshProduct = other.id;

  const imagesDir = ctx.args.uploadsDir ? path.join(ctx.args.uploadsDir, 'product-images') : null;
  const { image } = await uploadPhoto(ctx, pid, makePng(), 'photo.png', 'image/png');
  check(image?.id, 'upload returned the image');
  ids.image = image.id;
  const url = `/products/${pid}/images/${image.id}`;

  const a = await admin.get(url, { raw: true, expect: 200 });
  eq(a.headers.get('content-type'), 'image/png', 'G5 content-type');
  for (const [h, v] of Object.entries(G5_HEADERS)) eq(a.headers.get(h), v, `G5 header ${h}`);
  check(/^inline; filename="photo\.png"$/.test(a.headers.get('content-disposition') ?? ''), 'G5 content-disposition');
  await viewer.get(url, { raw: true, expect: 200 });
  await customer.get(url, { raw: true, expect: 200 });

  await admin.ok('PATCH', `/products/${pid}`, { isActive: false });
  await customer.get(url, { raw: true, expect: 404 });
  await admin.get(url, { raw: true, expect: 200 });
  await admin.ok('PATCH', `/products/${pid}`, { isActive: true });

  await admin.ok('PATCH', `/customers/${ids.customer}`, { isApproved: false });
  try {
    await customer.get(url, { raw: true, expect: 404 });
  } finally {
    await admin.ok('PATCH', `/customers/${ids.customer}`, { isApproved: true });
  }
  await customer.get(url, { raw: true, expect: 200 });

  await admin.get(`/products/${other.id}/images/${image.id}`, { raw: true, expect: 404 });
  await anon.get(url, { raw: true, expect: 401 });
  await uploadPhoto(ctx, pid, SVG_AS_PNG, 'evil.png', 'image/png', 400);

  const { image: gps } = await uploadPhoto(ctx, pid, makeGpsJpeg(), 'gps.jpg', 'image/jpeg');
  const bytes = (await admin.get(`/products/${pid}/images/${gps.id}`, { raw: true, expect: 200 })).buf;
  check(!bytes.includes(Buffer.from(GPS_SECRET, 'latin1')), 'served JPEG still carries the GPS IFD');
  check(!bytes.includes(Buffer.from('Exif\0\0', 'latin1')), 'served JPEG still carries an Exif block');

  const burst = await Promise.all(Array.from({ length: 30 }, () => admin.get(url, { raw: true, burst: true })));
  const statuses = burst.map((r) => r.status);
  check(statuses.every((s) => s === 200), `30 parallel G5 → ${[...new Set(statuses)].join(', ')} (expected all 200, no 429)`);

  // Step 14's fresh product gets a photo now, so its file can be checked after the delete.
  const beforeFiles = imagesDir ? listDir(imagesDir) : null;
  const { image: freshImage } = await uploadPhoto(ctx, other.id, makePng(), 'fresh.png', 'image/png');
  ids.freshImage = freshImage.id;
  if (imagesDir) {
    const added = [...listDir(imagesDir)].filter((f) => !beforeFiles.has(f));
    check(added.length === 1, `expected one new file in ${imagesDir}, found ${added.length} (is --uploads-dir the API's UPLOAD_DIR?)`);
    ctx.freshImageFile = path.join(imagesDir, added[0]);
  }
}

async function step14(ctx) {
  const { admin, ids } = ctx;
  await admin.del(`/products/${ids.product}`, { expect: 409 });
  await admin.ok('PATCH', `/products/${ids.product}`, { isActive: false });
  await admin.ok('PATCH', `/products/${ids.product}`, { isActive: true }); // later steps sell it again

  const url = `/products/${ids.freshProduct}/images/${ids.freshImage}`;
  await admin.get(url, { raw: true, expect: 200 });
  const del = await admin.ok('DELETE', `/products/${ids.freshProduct}`);
  eq(del?.deleted, true, 'fresh product deleted');
  if (ctx.freshImageFile) {
    check(!fs.existsSync(ctx.freshImageFile), `image file still on disk: ${ctx.freshImageFile}`);
  } else {
    await admin.get(url, { raw: true, expect: 404 });
    console.log('       (no --uploads-dir: checked the photo URL is gone, not the file on disk)');
  }
}

async function step15(ctx) {
  const { admin, ids, ts } = ctx;
  const p = await admin.ok('POST', '/products', { name: `${ts} Files`, defaultPrinterId: ids.printer });
  ids.filesProduct = p.id;
  const form = new FormData();
  form.append('files', new Blob([makeGcode()], { type: 'application/octet-stream' }), 'e2e-part.gcode');
  const r = await admin.req('POST', `/products/${p.id}/onboard-gcode`, { form, expect: [200, 201] });
  const comp = (r.data.product?.components ?? []).find((c) => c.file?.attachmentId);
  check(comp, `the import stored the G-code as a component file (results ${JSON.stringify(r.data.results)}, skipped ${JSON.stringify(r.data.skipped)})`);
  const d = await admin.del(`/attachments/${comp.file.attachmentId}`);
  check(d.status === 400 || d.status === 409, `DELETE a component file → ${d.status} (expected 400/409)`);
  await admin.get(`/attachments/${comp.file.attachmentId}/download`, { raw: true, expect: 200 });
}

const FORBIDDEN_CUSTOMER_KEYS = ['passwordHash', 'refreshToken', 'estimatedCost', 'marginPercent', 'listUnitPrice', 'priceSource', 'tierMinQty', 'priceOverrideReason'];

async function step16(ctx) {
  const { admin, customer, ids } = ctx;
  const q = await admin.ok('POST', '/quotes', { customerId: ids.customer, items: [{ description: `${ctx.ts} custom`, quantity: 1, unitPrice: 1, estimatedCost: 0.4, marginPercent: 60 }] });
  await admin.ok('PATCH', `/quotes/${q.id}`, { status: 'SENT' });
  const accepted = await customer.ok('POST', `/quotes/customer/${q.id}/accept`);
  const keys = deepKeys(accepted);
  const leaked = FORBIDDEN_CUSTOMER_KEYS.filter((k) => keys.has(k));
  eq(leaked, [], 'customer accept response keys');
  eq(accepted.status, 'ACCEPTED', 'quote accepted');
}

async function step17(ctx) {
  const { admin, customer, ids } = ctx;
  const created = await customer.ok('POST', '/orders/customer', { items: [{ variantId: ids.large, quantity: 1 }] });
  const leaked = FORBIDDEN_CUSTOMER_KEYS.filter((k) => deepKeys(created).has(k));
  eq(leaked, [], 'customer order response keys');
  const o = await order(ctx, created.id);
  eq([o.items[0].sizeOptionId, o.items[0].colourOptionId, o.items[0].variantId], [ids.large, null, ids.large], 'stored pair and mirror');
  ids.customerOrder = created.id;

  const tiersBefore = (await product(ctx, ids.product)).priceTiers;
  await admin.put(`/products/${ids.product}/price-tiers`, { variantId: ids.large, tiers: [] }, { expect: 400 });
  eq((await product(ctx, ids.product)).priceTiers.map((t) => [t.minQty, t.unitPrice]), tiersBefore.map((t) => [t.minQty, t.unitPrice]), 'standard tiers unchanged');
}

export const stepsAccess = [
  [13, 'photos: G5 matrix, headers, SVG refused, GPS stripped, 30 parallel without 429', step13],
  [14, 'delete with history 409, deactivate 200, fresh product deleted with its photo', step14],
  [15, 'component files can’t be deleted as attachments', step15],
  [16, 'customer quote accept leaks no private or pricing fields', step16],
  [17, 'legacy shop body { variantId } and stale tier body', step17],
];
