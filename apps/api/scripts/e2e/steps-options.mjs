/** Steps 18–22: classification, colours-only shop, legacy option after deploy, line colour change, filament delete guard (spec §7.2). */
import { check, eq } from './client.mjs';
import { order, plan, planAndCreate, product, productWithBox, staffOrder } from './setup.mjs';

async function step18(ctx) {
  const { admin, ids } = ctx;
  const pid = ids.product;
  const green = await admin.ok('POST', `/products/${pid}/variants`, { name: 'Green', kind: 'SIZE' });
  ids.green = green.id;
  await admin.ok('PUT', `/products/${pid}/option-kinds`, { changes: [{ variantId: green.id, kind: 'COLOUR' }] });
  const o = await staffOrder(ctx, [{ productId: pid, colourOptionId: green.id, quantity: 1 }]);
  ids.greenOrder = o.id;
  const back = await admin.put(`/products/${pid}/option-kinds`, { changes: [{ variantId: green.id, kind: 'SIZE' }] }, { expect: 409 });
  check(String(back.body?.error ?? '').includes('"Green"'), `409 names Green (${back.body?.error})`);

  await admin.ok('PATCH', `/products/${pid}/variants/${green.id}`, { isActive: false });
  const refused = await admin.post('/orders', { customerId: ids.customer, items: [{ productId: pid, colourOptionId: green.id, quantity: 1 }] }, { expect: 400 });
  check(String(refused.body?.error ?? '').includes('Line 1: colour "Green" is no longer available'), `inactive colour message (${refused.body?.error})`);
  const p = await plan(ctx, o.id);
  check(p.rows.length >= 1, 'planning the existing Green order still works');
  // Step 21 splits a line into Red and Green, so Green is sold again from here.
  await admin.ok('PATCH', `/products/${pid}/variants/${green.id}`, { isActive: true });
}

async function step19(ctx) {
  const { admin, customer, ids } = ctx;
  const p = await productWithBox(ctx, 'Keyring');
  const slot = await admin.ok('POST', `/products/${p.id}/colour-slots`, { name: 'Body' });
  await admin.ok('PUT', `/products/${p.id}/colour-links`, { links: [{ componentId: p.boxId, colorIndex: 0, colourSlotId: slot.id }] });
  const red = await admin.ok('POST', `/products/${p.id}/variants`, { name: 'Red', kind: 'COLOUR', keepStandard: { label: 'Black', sellInShop: false } });
  const blue = await admin.ok('POST', `/products/${p.id}/variants`, { name: 'Blue', kind: 'COLOUR' });
  const shop = () => customer.ok('GET', `/products/customer/${p.id}`);

  let d = await shop();
  eq([d.hasSizes, d.sizes.map((s) => s.sizeOptionId), d.colours.length], [false, [null], 0], 'P4 before filaments');
  await admin.ok('PUT', `/products/${p.id}/variants/${red.id}/colour-slots`, { slots: [{ colourSlotId: slot.id, materialId: ids.red }] });
  await admin.ok('PUT', `/products/${p.id}/variants/${blue.id}/colour-slots`, { slots: [{ colourSlotId: slot.id, materialId: ids.blue }] });
  d = await shop();
  eq(d.colours.map((c) => c.colourOptionId).sort(), [red.id, blue.id].sort(), 'P4 colours after filaments (no standard colour)');
  await admin.ok('PATCH', `/products/${p.id}`, { standardColourSellable: true });
  d = await shop();
  eq([d.colours.length, d.colours[0]?.colourOptionId], [3, null], 'P4: standard colour first');
  await admin.ok('PATCH', `/products/${p.id}/variants/${red.id}`, { isActive: false });
  await admin.ok('PATCH', `/products/${p.id}/variants/${blue.id}`, { isActive: false });
  eq((await shop()).colours, [], 'P4 colours with both colours inactive');
}

async function step20(ctx) {
  const { admin, customer, ids } = ctx;
  const p = await productWithBox(ctx, 'Tag', { description: 'Tag', gramsUsed: 5, printMinutes: 10 });
  const teal = await admin.ok('POST', `/products/${p.id}/variants`, { name: 'Teal', kind: 'SIZE' });
  // A pre-release option: a priced size with no components of its own. The API can only
  // price a size from its components, so give it one and remove it (the price stays, §3.10).
  const tc = await admin.ok('POST', `/products/${p.id}/components`, { description: 'Teal Tag', materialId: ids.black, gramsUsed: 6, printMinutes: 12, quantity: 1, sizeOptionId: teal.id });
  await admin.ok('DELETE', `/products/${p.id}/components/${tc.id}`);
  const size = (await product(ctx, p.id)).sizes.find((s) => s.id === teal.id);
  check(size && size.basePrice > 0 && size.components.length === 0, `Teal is a priced size without components (${JSON.stringify(size && { basePrice: size.basePrice, components: size.components.length })})`);

  const created = await customer.ok('POST', '/orders/customer', { items: [{ variantId: teal.id, quantity: 1 }] });
  eq((await order(ctx, created.id)).items[0].sizeOptionId, teal.id, 'stored sizeOptionId');
  const r = await admin.ok('PUT', `/products/${p.id}/option-kinds`, {
    changes: [{ variantId: teal.id, kind: 'COLOUR' }],
    keepStandard: { colour: { label: 'Standard', sellInShop: true } },
  });
  eq(r.rewritten?.orderLines, 1, 'rewritten.orderLines');
  const it = (await order(ctx, created.id)).items[0];
  eq([it.colour?.id ?? null, it.size], [teal.id, null], 'order line now reads colour Teal, no size');
  const shop = await customer.ok('GET', `/products/customer/${p.id}`);
  check(!shop.colours.some((c) => c.colourOptionId === teal.id), 'P4 no longer offers Teal until its filaments are set');
}

async function step21(ctx) {
  const { admin, ids } = ctx;
  const pid = ids.product;
  const q = await admin.ok('POST', '/quotes', { customerId: ids.customer, items: [{ productId: pid, quantity: 25 }] });
  eq([q.items[0].unitPrice, q.items[0].priceSource], [0.8, 'TIER'], 'quote line at TIER 25');
  const split = await admin.ok('PUT', `/quotes/${q.id}/items/${q.items[0].id}/colour`, { colours: [{ colourOptionId: ids.redOption, quantity: 15 }, { colourOptionId: ids.green, quantity: 10 }] });
  eq(split.items.map((i) => [i.quantity, i.unitPrice]).sort((a, b) => b[0] - a[0]), [[15, 0.8], [10, 0.8]], 'split quote lines');
  eq(split.total, q.total, 'quote total unchanged');

  const o = await staffOrder(ctx, [{ productId: pid, quantity: 30 }]);
  const { created } = await planAndCreate(ctx, o.id, { spools: [{ materialId: ids.black, spoolId: ids.blackSpool }] });
  check(created.jobsCreated >= 1, 'the order line has jobs');
  const item = o.items[0];
  const colours = [{ colourOptionId: ids.redOption, quantity: 15 }, { colourOptionId: ids.green, quantity: 15 }];
  const path = `/orders/${o.id}/items/${item.id}/colour`;
  const dry = await admin.ok('PUT', `${path}?dryRun=1`, { colours });
  check((dry.cancelledJobs ?? dry.jobs ?? []).length >= 1, `dry run lists the jobs (${JSON.stringify(dry).slice(0, 200)})`);
  await admin.put(path, { colours }, { expect: 400 });
  const done = await admin.ok('PUT', path, { colours, confirm: true });
  eq(done.cancelledJobs.length, created.jobsCreated, 'jobs cancelled');
  const released = (done.stockReleased ?? []).reduce((s, r) => s + r.units, 0);
  const allocated = created.allocations.reduce((s, a) => s + a.fromStock, 0);
  eq(released, allocated, 'allocation released');
  const after = await order(ctx, o.id);
  eq(after.items.map((i) => [i.colourOptionId, i.quantity]).sort(), [[ids.green, 15], [ids.redOption, 15]].sort(), 'lines split');
  for (const j of done.cancelledJobs) eq((await admin.ok('GET', `/jobs/${j.id}`)).status, 'CANCELLED', `job ${j.name}`);
}

async function step22(ctx) {
  const { admin, ids } = ctx;
  await admin.del(`/materials/${ids.red}`, { expect: 409 });
  const p = await product(ctx, ids.product);
  check(p.components.some((c) => c.id === ids.box), 'components intact');
  const red = p.colours.find((c) => c.id === ids.redOption);
  eq(red?.assignments?.map((a) => a.materialId), [ids.red], 'Red assignment intact');
  await admin.get(`/spools/${ids.redSpool}`, { expect: 200 });
}

export const stepsOptions = [
  [18, 'classify Green as a colour, 409 back to size, inactive colour refused, old order still plans', step18],
  [19, 'colours-only shop: hidden until filaments, standard colour first when sold, empty when inactive', step19],
  [20, 'legacy option used before classification moves to the colour axis', step20],
  [21, 'line colour change on a quote and on a planned order', step21],
  [22, 'a filament in use can’t be deleted', step22],
];
