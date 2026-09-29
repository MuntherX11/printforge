import PDFDocument from 'pdfkit';
import { allKeys } from '../orders/__fixtures__/orders-harness';
import { fakeCatalogDb } from '../products/__fixtures__/fake-catalog-db';
import { InvoicesService } from './invoices.service';
import { PdfService } from './pdf.service';

const CUSTOMER_ID = 'cust-1';
const secrets = (v: unknown) => ['passwordHash', 'refreshToken'].filter((k) => allKeys(v).has(k));

function harness() {
  const db = fakeCatalogDb();
  db.insert('customer', {
    id: CUSTOMER_ID, name: 'Ali', email: 'ali@example.com', phone: '+968 9000 0000', address: 'Muscat', notes: null,
    portalAccess: true, isApproved: true, isActive: true, lastLoginAt: null, passwordHash: 'secret-hash', refreshToken: 'secret-refresh',
  });
  const order = db.insert('order', {
    orderNumber: 'ORD-0001', status: 'CONFIRMED', customerId: CUSTOMER_ID, subtotal: 10, tax: 0.5, total: 10.5, paidAmount: 0,
  });
  db.insert('orderItem', { orderId: order.id, description: 'Box', quantity: 2, unitPrice: 5, totalPrice: 10 });
  const accounts = { defaultAccount: jest.fn(async () => ({ id: 'acc-1' })), post: jest.fn(async () => undefined) };
  const invoices = new InvoicesService(db as any, accounts as any);
  return { db, order, accounts, invoices };
}

describe('Staff invoice responses never carry the customer login secrets', () => {
  it('create, findAll, findOne and update (mark paid) return the customer without passwordHash or refreshToken', async () => {
    const h = harness();
    const created: any = await h.invoices.create({ orderId: h.order.id } as any);
    expect(created.order.customer).toMatchObject({
      id: CUSTOMER_ID, name: 'Ali', email: 'ali@example.com', phone: '+968 9000 0000', address: 'Muscat',
    });
    expect(created.order.items).toHaveLength(1);
    expect(secrets(created)).toEqual([]);

    const list: any = await h.invoices.findAll({ page: 1, limit: 20 } as any);
    expect(list.data[0].order.customer).toEqual({ id: CUSTOMER_ID, name: 'Ali' });
    expect(secrets(list)).toEqual([]);

    const view: any = await h.invoices.findOne(created.id);
    expect(view.order.customer.email).toBe('ali@example.com');
    expect(secrets(view)).toEqual([]);

    const paid: any = await h.invoices.update(created.id, { status: 'PAID' } as any);
    expect(paid.status).toBe('PAID');
    expect(secrets(paid)).toEqual([]);
    // The deposit still names the customer.
    expect(h.accounts.post).toHaveBeenCalledWith(expect.objectContaining({ description: `Invoice ${created.invoiceNumber} — Ali` }));
  });

  it('the invoice PDF still prints the customer name, email, phone and address', async () => {
    const h = harness();
    const created: any = await h.invoices.create({ orderId: h.order.id } as any);
    const invoice = await h.invoices.findOne(created.id);
    const texts: string[] = [];
    const spy = jest.spyOn(PDFDocument.prototype as any, 'text').mockImplementation(function (this: any, ...args: any[]) {
      texts.push(String(args[0]));
      return this;
    });
    try {
      const buf = await new PdfService(h.db as any).generateInvoicePdf(invoice);
      expect(buf.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
    expect(texts).toEqual(expect.arrayContaining(['Ali', 'ali@example.com', '+968 9000 0000', 'Muscat']));
    expect(texts.some((t) => t.includes('secret-'))).toBe(false);
  });
});
