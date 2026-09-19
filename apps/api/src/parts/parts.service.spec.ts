import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { StaffGuard } from '../auth/guards/staff.guard';
import { boxRow, BOX_ID } from '../catalog-core/__fixtures__/box-product';
import { productsHarness, statusOf } from '../products/__fixtures__/products-harness';
import { PartsController } from './parts.controller';

/** §7.1 item 37 (P21) and the parts guards (A4, C21). */
describe('PartsService product BOM lines (P21)', () => {
  const setup = () => {
    const h = productsHarness([boxRow()]);
    h.db.insert('part', { id: 'nfc', name: 'NFC tag', unitCost: 0.1, stockQty: 50, isActive: true });
    h.db.insert('part', { id: 'old', name: 'Old magnet', unitCost: 0.05, stockQty: 5, isActive: false });
    return h;
  };

  it('quantity 0, 1001 and 2.5 → 400; 1 and 1000 accepted', async () => {
    const h = setup();
    for (const quantity of [0, 1001, 2.5, -1, 'abc', null]) {
      await expect(h.parts.setProductPart(BOX_ID, { partId: 'nfc', quantity })).rejects.toThrow('Quantity must be a whole number from 1 to 1000');
    }
    expect((await h.parts.setProductPart(BOX_ID, { partId: 'nfc', quantity: 1 })).quantity).toBe(1);
    expect((await h.parts.setProductPart(BOX_ID, { partId: 'nfc', quantity: 1000 })).quantity).toBe(1000);
  });

  it('an upsert with 1000 then 3 changes the line to 3 and reprices', async () => {
    const h = setup();
    const spy = jest.spyOn(h.pricing, 'recalcPricing');
    await h.products.setPart(BOX_ID, { partId: 'nfc', quantity: 1000 });
    await h.products.setPart(BOX_ID, { partId: 'nfc', quantity: 3 });
    expect(h.db.t('productPart')).toHaveLength(1);
    expect(h.db.t('productPart')[0].quantity).toBe(3);
    expect(spy).toHaveBeenCalledTimes(2);
    await h.products.removePart(BOX_ID, 'nfc');
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('an inactive part → 400; unknown part or product → 404; unknown keys ignored', async () => {
    const h = setup();
    await expect(h.parts.setProductPart(BOX_ID, { partId: 'old', quantity: 1 })).rejects.toThrow('"Old magnet" is inactive');
    expect(await statusOf(h.parts.setProductPart(BOX_ID, { partId: 'nope', quantity: 1 }))).toBe(404);
    expect(await statusOf(h.parts.setProductPart('nope', { partId: 'nfc', quantity: 1 }))).toBe(404);
    const line: any = await h.parts.setProductPart(BOX_ID, { partId: 'nfc', quantity: 2, productId: 'x', sortOrder: 9 });
    expect(line).toMatchObject({ productId: BOX_ID, quantity: 2 });
    expect(line.sortOrder).not.toBe(9);
  });

  it('A4: the parts catalog is staff-only (GET / and GET /:id)', () => {
    const reflector = new Reflector();
    for (const handler of [PartsController.prototype.findAll, PartsController.prototype.findOne]) {
      expect(reflector.get(GUARDS_METADATA, handler)).toContain(StaffGuard);
    }
  });
});
