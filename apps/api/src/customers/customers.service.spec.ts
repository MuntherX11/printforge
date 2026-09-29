import { NotFoundException } from '@nestjs/common';
import { allKeys } from '../orders/__fixtures__/orders-harness';
import { STAFF_CUSTOMER_SELECT } from '../orders/orders.service';
import { fakeCatalogDb } from '../products/__fixtures__/fake-catalog-db';
import { CustomersService } from './customers.service';

const CUSTOMER_ID = 'cust-1';
const COLUMNS = Object.keys(STAFF_CUSTOMER_SELECT).sort();
const secrets = (v: unknown) => ['passwordHash', 'refreshToken'].filter((k) => allKeys(v).has(k));

function harness() {
  const db = fakeCatalogDb();
  db.insert('customer', {
    id: CUSTOMER_ID, name: 'Ali', email: 'ali@example.com', phone: '+968 9000 0000', address: 'Muscat', notes: 'VIP',
    portalAccess: true, isApproved: true, isActive: true, lastLoginAt: null, passwordHash: 'secret-hash', refreshToken: 'secret-refresh',
  });
  db.insert('order', { orderNumber: 'ORD-0001', status: 'PENDING', customerId: CUSTOMER_ID, total: 5 });
  db.insert('quote', { quoteNumber: 'QT-0001', status: 'DRAFT', customerId: CUSTOMER_ID, total: 5 });
  return { db, customers: new CustomersService(db as any) };
}

describe('Staff customer responses never carry the customer login secrets', () => {
  it('GET /customers lists every column but passwordHash and refreshToken, with the order count', async () => {
    const h = harness();
    const res: any = await h.customers.findAll({ page: 1, limit: 20 } as any);
    expect(Object.keys(res.data[0]).sort()).toEqual([...COLUMNS, '_count'].sort());
    expect(res.data[0]._count).toEqual({ orders: 1 });
    expect(secrets(res)).toEqual([]);
  });

  it('GET /customers/:id keeps the detail page fields (orders, quotes, counts) without the secrets', async () => {
    const h = harness();
    const c: any = await h.customers.findOne(CUSTOMER_ID);
    expect(c).toMatchObject({ id: CUSTOMER_ID, name: 'Ali', email: 'ali@example.com', phone: '+968 9000 0000', address: 'Muscat', notes: 'VIP' });
    expect(c.orders.map((o: any) => o.orderNumber)).toEqual(['ORD-0001']);
    expect(c.quotes.map((q: any) => q.quoteNumber)).toEqual(['QT-0001']);
    expect(c._count).toEqual({ orders: 1, quotes: 1 });
    expect(secrets(c)).toEqual([]);
    await expect(h.customers.findOne('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('POST, PATCH and DELETE /customers return the row without the secrets', async () => {
    const h = harness();
    // The DTO is an interface, so nothing strips extra keys before the service.
    const created: any = await h.customers.create({ name: 'Sara', email: 'sara@example.com', passwordHash: 'x', refreshToken: 'y' } as any);
    expect(created).toMatchObject({ name: 'Sara', email: 'sara@example.com' });
    expect(Object.keys(created).sort()).toEqual(COLUMNS);

    const updated: any = await h.customers.update(CUSTOMER_ID, { phone: '+968 9111 1111' });
    expect(updated.phone).toBe('+968 9111 1111');
    expect(Object.keys(updated).sort()).toEqual(COLUMNS);

    const removed: any = await h.customers.remove(created.id);
    expect(removed).toMatchObject({ id: created.id, name: 'Sara' });
    expect(Object.keys(removed).sort()).toEqual(COLUMNS);
    expect(h.db.t('customer').some((c: any) => c.id === created.id)).toBe(false);

    expect(secrets([created, updated, removed])).toEqual([]);
  });
});
