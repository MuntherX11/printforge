/** Steps 1–6: price basis, layouts, colours and sizes, bulk tiers, a priced order (spec §7.2). */
import { check, eq, near } from './client.mjs';
import { addBoxLayouts, componentOf, cost, product, productWithBox, staffOrder } from './setup.mjs';

async function step1(ctx) {
  const p = await productWithBox(ctx, 'Box');
  Object.assign(ctx.ids, { product: p.id, box: p.boxId });
  ctx.productName = p.name;
  const c = await cost(ctx, p.id);
  const std = c.sizes.find((s) => s.sizeOptionId === null);
  near(std?.perUnit?.total, 0.372, 'standard perUnit.total');
  near(std.computedPrice, 0.93, 'standard computedPrice');
  near((await product(ctx, p.id)).basePrice, 0.93, 'basePrice');
}

async function step2(ctx) {
  await ctx.admin.ok('PATCH', `/products/${ctx.ids.product}`, { basePrice: 9 });
  near((await product(ctx, ctx.ids.product)).basePrice, 0.93, 'basePrice after PATCH basePrice: 9');
}

async function step3(ctx) {
  const { product: pid, box } = ctx.ids;
  const l = await addBoxLayouts(ctx, pid, box);
  Object.assign(ctx.ids, { x12: l.x12.id, x8: l.x8.id });
  const c = await cost(ctx, pid);
  const std = c.sizes.find((s) => s.sizeOptionId === null);
  near((await product(ctx, pid)).basePrice, 0.93, 'basePrice after layouts');
  near(std.computedPrice, 0.93, 'computedPrice after layouts');
  eq(std.priceUpToDate, true, 'priceUpToDate after layouts');
  await ctx.admin.ok('PATCH', `/products/${pid}/components/${box}/plate-layouts/${l.x8.id}`, { isActive: false });
  const floor = await ctx.admin.ok('GET', `/products/${pid}/bulk-floor?minQtys=25,50`);
  near(floor.bands?.[0]?.worstUnitCost, 0.27, 'band 1 worstUnitCost (×12 only)');
  eq(floor.bands[0].worstAtQty, 25, 'band 1 worstAtQty');
  await ctx.admin.ok('PATCH', `/products/${pid}/components/${box}/plate-layouts/${l.x8.id}`, { isActive: true });
}

async function step4(ctx) {
  const { admin, ids } = ctx;
  const pid = ids.product;
  const slot = await admin.ok('POST', `/products/${pid}/colour-slots`, { name: 'Body' });
  ids.body = slot.id;
  await admin.ok('PUT', `/products/${pid}/colour-links`, { links: [{ componentId: ids.box, colorIndex: 0, colourSlotId: slot.id }] });
  // keepStandard: the first colour's "keep selling the as-sliced colour" step (§3.1 rule 7), ticked
  // as the dialog defaults, so step 17's customer order of (Large, standard colour) is allowed.
  const red = await admin.ok('POST', `/products/${pid}/variants`, { name: 'Red', kind: 'COLOUR', keepStandard: { label: 'Black', sellInShop: true } });
  ids.redOption = red.id;
  await admin.ok('PUT', `/products/${pid}/variants/${red.id}/colour-slots`, { slots: [{ colourSlotId: slot.id, materialId: ids.red }] });
  near((await product(ctx, pid)).basePrice, 0.93, 'basePrice after colour Red');

  const c = await cost(ctx, pid);
  const cell = c.cells.find((x) => x.sizeOptionId === null && x.colourOptionId === red.id);
  check(cell, 'no (Standard, Red) cell');
  near(cell.costPerUnit, 0.394, '(Standard, Red) cost');
  near(cell.marginPct, 57.6, '(Standard, Red) margin', 0.05);
  near(cell.price, 0.93, '(Standard, Red) price is the size price');
  const pair = await cost(ctx, pid, `?sizeOptionId=standard&colourOptionId=${red.id}`);
  eq(pair.pair.computedPrice, null, '(Standard, Red) computedPrice');
  check(!JSON.stringify(pair).includes('0.985') && !JSON.stringify(cell).includes('0.985'), 'no colour price 0.985 anywhere');

  const large = await admin.ok('POST', `/products/${pid}/variants`, { name: 'Large', kind: 'SIZE' });
  ids.large = large.id;
  const lb = await admin.ok('POST', `/products/${pid}/components`, {
    description: 'Large Box', materialId: ids.black, gramsUsed: 21, printMinutes: 70, quantity: 1, sizeOptionId: large.id, colourSlotId: slot.id,
  });
  ids.largeBox = lb.id;
  const c2 = await cost(ctx, pid);
  const ls = c2.sizes.find((s) => s.sizeOptionId === large.id);
  check(ls && ls.computedPrice > 0, 'Large has an automatic price');
  near(ls.storedPrice, ls.computedPrice, 'Large stored price = computed price');
  const ready = await admin.ok('GET', `/products/${pid}/readiness?sizeOptionId=${large.id}&colourOptionId=${red.id}&qty=1`);
  const comp = ready.components.find((x) => x.componentId === lb.id);
  check(comp, '(Large, Red) resolves Large Box');
  eq(ready.filament.map((f) => f.materialId), [ids.red], '(Large, Red) filament');
}

async function step5(ctx) {
  const { admin, ids } = ctx;
  const pid = ids.product;
  await admin.ok('PUT', `/products/${pid}/price-tiers`, { sizeOptionId: null, tiers: [{ minQty: 25, unitPrice: 0.8 }] });
  const lines = async (ls) => (await admin.ok('POST', '/pricing/lines', { lines: ls.map((l) => ({ productId: pid, ...l })) })).lines;

  const [a] = await lines([{ colourOptionId: ids.redOption, quantity: 30 }]);
  eq([a.priceSource, a.effectiveUnitPrice, a.error], ['TIER', 0.8, null], '(Standard, Red) ×30');
  check(!a.warningCodes.includes('BELOW_COST'), `(Standard, Red) ×30 at 0.800 has no BELOW_COST (${a.warningCodes})`);

  const [b] = await lines([{ colourOptionId: ids.redOption, quantity: 30, unitPrice: 0.1, priceOverride: true }]);
  check(b.warningCodes.includes('BELOW_COST'), `override 0.100 → BELOW_COST (${b.warningCodes})`);

  const both = await lines([{ colourOptionId: ids.redOption, quantity: 15 }, { quantity: 10 }]);
  for (const l of both) eq([l.priceSource, l.tierMinQty, l.tierLineCount], ['TIER', 25, 2], 'Red 15 + standard 10');

  const split = await lines([{ colourOptionId: ids.redOption, quantity: 15 }, { sizeOptionId: ids.large, colourOptionId: ids.redOption, quantity: 15 }]);
  for (const l of split) check(l.priceSource !== 'TIER' && l.error === null, `Standard·Red 15 + Large·Red 15 → no tier (${l.priceSource} ${l.error})`);

  await admin.put(`/products/${pid}/price-tiers`, { sizeOptionId: ids.redOption, tiers: [] }, { expect: 400 });
}

async function step6(ctx) {
  const o = await staffOrder(ctx, [{ productId: ctx.ids.product, quantity: 30 }]);
  ctx.ids.order1 = o.id;
  const it = o.items[0];
  eq([it.unitPrice, it.priceSource], [0.8, 'TIER'], 'order line price');
  near(o.total, 24, 'order total');
  check(it.description.startsWith(ctx.productName), `line description starts with the product (${it.description})`);
  check(componentOf(await product(ctx, ctx.ids.product), 'Box').stockOnHand === 0, 'Box stock starts at 0');
}

export const stepsCore = [
  [1, 'Box: cost 0.372, price 0.930', step1],
  [2, 'PATCH basePrice is ignored', step2],
  [3, 'layouts never touch the price; bulk floor band 1 = 0.270 at 25', step3],
  [4, 'colour Red: cost 0.394, margin 57.6 %, no colour price; size Large priced', step4],
  [5, 'size tiers, BELOW_COST, tiers across lines, colours share tiers', step5],
  [6, 'order ×30 at TIER 0.800, total 24.000', step6],
];
