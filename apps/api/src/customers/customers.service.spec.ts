import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { allKeys } from '../orders/__fixtures__/orders-harness';
import { STAFF_CUSTOMER_SELECT } from '../orders/orders.service';
import { fakeCatalogDb } from '../products/__fixtures__/fake-catalog-db';
import { CustomersController } from './customers.controller';
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
    const created: any = await h.customers.create({ name: 'Sara', email: 'sara@example.com' });
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

describe('POST and PATCH /customers write only the contact card', () => {
  const FORBIDDEN: Array<[string, unknown]> = [
    ['passwordHash', '$2a$10$knownhashknownhashknownhashknownhashknownhashknownha'],
    ['refreshToken', 'stolen'],
    ['isApproved', true],
    ['portalAccess', true],
    ['isActive', false],
    ['lastLoginAt', '2026-01-01T00:00:00Z'],
    ['id', 'chosen-id'],
    ['createdAt', '2020-01-01T00:00:00Z'],
    ['orders', { connect: [{ id: 'someone-elses-order' }] }],
    ['quotes', { create: [{ quoteNumber: 'QT-9999', total: 0 }] }],
    ['designProjects', { connect: [{ id: 'dp-1' }] }],
  ];

  it.each(FORBIDDEN)('POST refuses %s with a 400 and creates nothing', async (key, value) => {
    const h = harness();
    const before = h.db.t('customer').length;
    const err = await h.customers.create({ name: 'Mallory', email: 'm@example.com', [key]: value }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe(`property ${key} should not exist`);
    expect(h.db.t('customer')).toHaveLength(before);
  });

  it.each(FORBIDDEN)('PATCH refuses %s with a 400 and leaves the customer unchanged', async (key, value) => {
    const h = harness();
    const before = { ...h.db.t('customer').find((c: any) => c.id === CUSTOMER_ID) };
    const err = await h.customers.update(CUSTOMER_ID, { phone: '+968 1', [key]: value }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe(`property ${key} should not exist`);
    expect(h.db.t('customer').find((c: any) => c.id === CUSTOMER_ID)).toEqual(before);
    expect(h.db.t('order')[0].customerId).toBe(CUSTOMER_ID);
  });

  it('PATCH names every extra key and refuses a nested order write', async () => {
    const h = harness();
    const orderId = h.db.t('order')[0].id;
    const err = await h.customers.update(CUSTOMER_ID, {
      passwordHash: 'x', isApproved: true,
      orders: { update: { where: { id: orderId }, data: { status: 'DELIVERED', paidAmount: 5 } } },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('property passwordHash should not exist, property isApproved should not exist, property orders should not exist');
    expect(h.db.t('order')[0]).toMatchObject({ status: 'PENDING' });
    expect(h.db.t('customer').find((c: any) => c.id === CUSTOMER_ID)).toMatchObject({ passwordHash: 'secret-hash', isApproved: true });
  });

  it('POST saves the New Customer form payload, trimmed, with blank optionals as null', async () => {
    const h = harness();
    // customers/new/page.tsx sends these five keys, blanks as undefined.
    const created: any = await h.customers.create({
      name: '  Sara  ', email: 'sara@example.com', phone: ' +968 9222 2222 ', address: undefined, notes: undefined,
    });
    const row = h.db.t('customer').find((c: any) => c.id === created.id);
    expect(row).toMatchObject({ name: 'Sara', email: 'sara@example.com', phone: '+968 9222 2222', address: null, notes: null });
    expect(row.passwordHash).toBeUndefined();
    expect(row.isApproved).toBeUndefined();

    const blank: any = await h.customers.create({ name: 'Omar', email: '', phone: '   ' });
    expect(h.db.t('customer').find((c: any) => c.id === blank.id)).toMatchObject({ name: 'Omar', email: null, phone: null });
  });

  it('POST needs a name, and refuses non-text fields and a non-object body', async () => {
    const h = harness();
    for (const body of [{}, { name: '   ' }, { name: 5 }, { email: 'x@example.com' }, undefined]) {
      await expect(h.customers.create(body)).rejects.toThrow('Name is required');
    }
    await expect(h.customers.create({ name: 'A', phone: 968 })).rejects.toThrow('"phone" must be text');
    await expect(h.customers.create([{ name: 'A' }])).rejects.toThrow('Request body must be a JSON object');
    await expect(h.customers.create('name=A')).rejects.toThrow('Request body must be a JSON object');
  });

  it('PATCH saves the Edit form payload and leaves absent keys alone', async () => {
    const h = harness();
    // customers/[id]/page.tsx sends name plus the four optionals, blanks as undefined.
    await h.customers.update(CUSTOMER_ID, { name: 'Ali Al-Balushi', email: 'ali@new.example', phone: undefined, address: 'Sohar', notes: undefined });
    expect(h.db.t('customer').find((c: any) => c.id === CUSTOMER_ID)).toMatchObject({
      name: 'Ali Al-Balushi', email: 'ali@new.example', phone: '+968 9000 0000', address: 'Sohar', notes: 'VIP',
      passwordHash: 'secret-hash', refreshToken: 'secret-refresh', isApproved: true, portalAccess: true, isActive: true,
    });
  });

  it('PATCH clears an optional field on null or blank, refuses a blank name, and 404s a missing customer', async () => {
    const h = harness();
    await h.customers.update(CUSTOMER_ID, { notes: null, address: '  ' });
    expect(h.db.t('customer').find((c: any) => c.id === CUSTOMER_ID)).toMatchObject({ notes: null, address: null, name: 'Ali' });
    await expect(h.customers.update(CUSTOMER_ID, { name: '' })).rejects.toThrow('Name is required');
    await expect(h.customers.update(CUSTOMER_ID, { name: null })).rejects.toThrow('Name is required');
    await expect(h.customers.update('missing', { name: 'X' })).rejects.toBeInstanceOf(NotFoundException);
    // A forbidden key is a 400 even for a customer that does not exist.
    await expect(h.customers.update('missing', { isApproved: true })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('caps long text instead of storing it whole', async () => {
    const h = harness();
    const created: any = await h.customers.create({ name: 'N'.repeat(500), notes: 'n'.repeat(20_000), phone: '9'.repeat(80) });
    const row = h.db.t('customer').find((c: any) => c.id === created.id);
    expect(row.name).toHaveLength(200);
    expect(row.notes).toHaveLength(10_000);
    expect(row.phone).toHaveLength(50);
  });
});

describe('Customer write routes are closed to VIEWER', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);
  const P = CustomersController.prototype;
  const ctx = (handler: unknown, role: string) => ({
    getHandler: () => handler,
    getClass: () => CustomersController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role, userType: 'staff' } }) }),
  }) as any;

  it('keeps JwtAuthGuard and StaffGuard on the whole controller', () => {
    expect(reflector.get(GUARDS_METADATA, CustomersController)).toEqual([JwtAuthGuard, StaffGuard]);
  });

  it('POST and PATCH need RolesGuard with ADMIN, OPERATOR or ACCOUNTING', () => {
    for (const h of [P.create, P.update]) {
      expect(reflector.get(GUARDS_METADATA, h)).toEqual([RolesGuard]);
      expect(reflector.get(ROLES_KEY, h)).toEqual(['ADMIN', 'OPERATOR', 'ACCOUNTING']);
      expect(guard.canActivate(ctx(h, 'VIEWER'))).toBe(false);
      for (const role of ['ADMIN', 'OPERATOR', 'ACCOUNTING']) expect(guard.canActivate(ctx(h, role))).toBe(true);
    }
  });

  it('DELETE stays ADMIN-only and the reads stay open to every staff role', () => {
    expect(reflector.get(ROLES_KEY, P.remove)).toEqual(['ADMIN']);
    for (const role of ['OPERATOR', 'ACCOUNTING', 'VIEWER']) expect(guard.canActivate(ctx(P.remove, role))).toBe(false);
    for (const h of [P.findAll, P.findOne]) {
      expect(reflector.get(ROLES_KEY, h)).toBeUndefined();
      expect(guard.canActivate(ctx(h, 'VIEWER'))).toBe(true);
    }
  });
});
