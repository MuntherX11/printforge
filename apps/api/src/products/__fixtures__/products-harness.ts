/**
 * Wires the real WP4 services (and WP2's catalog-core) over the in-memory
 * database, the way ProductsModule does, for the products API specs.
 */
import { BomResolverService } from '../../catalog-core/bom-resolver.service';
import { SETTINGS } from '../../catalog-core/__fixtures__/box-product';
import { OpenLinesImpactService } from '../../catalog-core/open-lines-impact.service';
import { PricingService } from '../../catalog-core/pricing.service';
import { ProductionPlannerService } from '../../catalog-core/production-planner.service';
import { PartsService } from '../../parts/parts.service';
import { ProductStockService } from '../../stock-ledger/product-stock.service';
import { ColourSlotsService } from '../colour-slots.service';
import { ProductComponentsService } from '../product-components.service';
import { ProductImagesService } from '../product-images.service';
import { ProductsService } from '../products.service';
import { VariantsService } from '../variants.service';
import { fakeCatalogDb, seedProduct, type FakeCatalogDb } from './fake-catalog-db';

export function productsHarness(rows: any[] = []) {
  const db: FakeCatalogDb = fakeCatalogDb();
  for (const r of rows) seedProduct(db, r);
  const costing = { loadSettings: jest.fn(async () => ({ ...SETTINGS })) } as any;
  const prisma = db as any;
  const resolver = new BomResolverService(prisma);
  const pricing = new PricingService(prisma, resolver, costing);
  const planner = new ProductionPlannerService(prisma, resolver);
  const impact = new OpenLinesImpactService(prisma, resolver, planner);
  const stock = new ProductStockService(prisma);
  const parts = new PartsService(prisma);
  const images = new ProductImagesService(prisma);
  const products = new ProductsService(prisma, resolver, pricing, planner, {} as any, parts);
  const components = new ProductComponentsService(prisma, products, impact, stock);
  const variants = new VariantsService(prisma, products, pricing, resolver, impact);
  const slots = new ColourSlotsService(prisma, products, resolver, impact);
  return { db, resolver, pricing, planner, impact, stock, parts, images, products, components, variants, slots };
}

export type ProductsHarness = ReturnType<typeof productsHarness>;

let orderSeq = 0;

/** An open (CONFIRMED) order with one line; returns the line. */
export function addOrderLine(db: FakeCatalogDb, line: Record<string, any>, status = 'CONFIRMED') {
  const order = db.insert('order', { orderNumber: `ORD-${String(++orderSeq).padStart(4, '0')}`, status });
  return db.insert('orderItem', {
    orderId: order.id, productId: null, variantId: null, sizeOptionId: null, colourOptionId: null,
    description: 'line', quantity: 1, unitPrice: 1, totalPrice: 1, ...line,
  });
}

/** A DRAFT quote with one line. */
export function addQuoteLine(db: FakeCatalogDb, line: Record<string, any>, status = 'DRAFT') {
  const quote = db.insert('quote', { quoteNumber: `Q-${String(++orderSeq).padStart(4, '0')}`, status });
  return db.insert('quoteItem', {
    quoteId: quote.id, productId: null, sizeOptionId: null, colourOptionId: null,
    description: 'line', quantity: 1, unitPrice: 1, totalPrice: 1, ...line,
  });
}

export function addJob(db: FakeCatalogDb, job: Record<string, any>) {
  return db.insert('productionJob', {
    status: 'QUEUED', orderId: null, orderItemId: null, productId: null, variantId: null, componentId: null,
    sizeOptionId: null, colourOptionId: null, quantityToProduce: 1, reprintOfId: null, ...job,
  });
}

export const statusOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e: any) {
    return typeof e?.getStatus === 'function' ? e.getStatus() : 500;
  }
};
