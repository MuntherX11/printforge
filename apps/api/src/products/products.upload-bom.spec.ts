import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import * as ExcelJS from 'exceljs';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { productsHarness } from './__fixtures__/products-harness';
import { ProductsController } from './products.controller';

/**
 * POST /products/upload-bom creates and reprices products by SKU. It is now an
 * ADMIN/OPERATOR write like every other product write, and each row's numbers
 * are bounded, so a negative or Infinity basePrice is a row error, not a price.
 */

async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('BOM');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const HEADER = ['name', 'sku', 'description', 'basePrice', 'estimatedMinutes', 'estimatedGrams'];

describe('POST /products/upload-bom', () => {
  it('is ADMIN or OPERATOR only (VIEWER and ACCOUNTING are refused)', () => {
    const reflector = new Reflector();
    const handler = ProductsController.prototype.uploadBom;
    expect(reflector.get(GUARDS_METADATA, handler)).toEqual([RolesGuard]);
    expect(reflector.get(ROLES_KEY, handler)).toEqual(['ADMIN', 'OPERATOR']);
    const guard = new RolesGuard(reflector);
    const ctx = (role: string) => ({
      getHandler: () => handler, getClass: () => ProductsController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role, userType: 'staff' } }) }),
    }) as any;
    expect(guard.canActivate(ctx('VIEWER'))).toBe(false);
    expect(guard.canActivate(ctx('ACCOUNTING'))).toBe(false);
    expect(guard.canActivate(ctx('OPERATOR'))).toBe(true);
    expect(guard.canActivate(ctx('ADMIN'))).toBe(true);
  });

  it('still creates new rows and updates existing ones by SKU', async () => {
    const h = productsHarness();
    h.db.insert('product', { id: 'p-1', name: 'Old Tin', sku: 'TIN-1', basePrice: 1, estimatedMinutes: 10, estimatedGrams: 5, isActive: true });
    const res = await h.products.uploadBom(await xlsx([
      HEADER,
      ['Sardine Tin', 'TIN-1', 'Updated', 4.5, 90, 120],
      ['Keychain', 'KEY-1', null, 1.25, 20, 8],
    ]));
    expect(res).toEqual({ created: 1, updated: 1, errors: [] });
    expect(h.db.t('product').find((p: any) => p.id === 'p-1')).toMatchObject({ name: 'Sardine Tin', description: 'Updated', basePrice: 4.5, estimatedMinutes: 90, estimatedGrams: 120 });
    expect(h.db.t('product').find((p: any) => p.sku === 'KEY-1')).toMatchObject({ name: 'Keychain', basePrice: 1.25, estimatedMinutes: 20, estimatedGrams: 8 });
  });

  it.each<[string, unknown[], string]>([
    ['a negative price', ['Tin', 'TIN-1', null, -5, null, null], '"basePrice" must be between 0 and 1000000'],
    ['an Infinity price', ['Tin', 'TIN-1', null, 'Infinity', null, null], '"basePrice" must be a number'],
    ['an absurd price', ['Tin', 'TIN-1', null, 1e12, null, null], '"basePrice" must be between 0 and 1000000'],
    ['negative minutes', ['Tin', 'TIN-1', null, null, -1, null], '"estimatedMinutes" must be between 0 and 100000'],
    ['absurd grams', ['Tin', 'TIN-1', null, null, null, 1e7], '"estimatedGrams" must be between 0 and 100000'],
    ['a 65-character SKU', ['Tin', 'S'.repeat(65), null, 1, null, null], '"sku" must be at most 64 characters'],
  ])('%s is a row error and leaves the product as it was', async (_label, row, message) => {
    const h = productsHarness();
    h.db.insert('product', { id: 'p-1', name: 'Tin', sku: 'TIN-1', basePrice: 3, estimatedMinutes: 10, estimatedGrams: 5, isActive: true });
    const before = JSON.stringify(h.db.t('product'));
    const res = await h.products.uploadBom(await xlsx([HEADER, row]));
    expect(res).toEqual({ created: 0, updated: 0, errors: [`Row 2 ("Tin"): ${message}`] });
    expect(JSON.stringify(h.db.t('product'))).toBe(before);
  });

  it('a bad row does not stop the good rows around it', async () => {
    const h = productsHarness();
    const res = await h.products.uploadBom(await xlsx([
      HEADER,
      ['Good A', 'A-1', null, 2, null, null],
      ['Bad', 'B-1', null, -1, null, null],
      ['Good C', 'C-1', null, null, null, null],
    ]));
    expect(res.created).toBe(2);
    expect(res.errors).toEqual(['Row 3 ("Bad"): "basePrice" must be between 0 and 1000000']);
    expect(h.db.t('product').map((p: any) => p.sku).sort()).toEqual(['A-1', 'C-1']);
    expect(h.db.t('product').find((p: any) => p.sku === 'C-1')).toMatchObject({ basePrice: 0 });
  });
});
