/**
 * Wires the real WP6 services (jobs, planning, completion) and WP2's
 * catalog-core over the products specs' in-memory database, the way
 * ProductionModule does. Adds what production needs on top of that fake:
 *
 * - interactive transactions run one at a time (a stand-in for row locks and the
 *   J5 advisory lock; a transaction that throws rolls back);
 * - the `plan:advisory` lock and the `completion:spool` / `completion:part`
 *   atomic statements;
 * - `groupBy` for spools and job lines (the planner's netting).
 */
import { BomResolverService } from '../../catalog-core/bom-resolver.service';
import { ProductionPlannerService } from '../../catalog-core/production-planner.service';
import { fakeCatalogDb, seedProduct, type FakeCatalogDb } from '../../products/__fixtures__/fake-catalog-db';
import { JobCompletionService } from '../../stock-ledger/job-completion.service';
import { ProductStockService } from '../../stock-ledger/product-stock.service';
import { JobPlanningService } from '../job-planning.service';
import { JobsService } from '../jobs.service';

export function productionHarness(rows: any[] = []) {
  const db: FakeCatalogDb = fakeCatalogDb();
  for (const r of rows) seedProduct(db, r);

  const originalTx = db.$transaction;
  let chain: Promise<unknown> = Promise.resolve();
  db.$transaction = jest.fn((arg: any, opts?: any) => {
    if (Array.isArray(arg)) return originalTx(arg);
    const run = chain.then(() => originalTx(arg, opts));
    chain = run.catch(() => undefined);
    return run;
  });

  const originalQuery = db.$queryRaw;
  db.$queryRaw = jest.fn(async (sql: any) => {
    if (/plan:advisory/.test(sql?.sql ?? '')) return [{ ok: 1 }];
    return originalQuery(sql);
  });
  db.$executeRaw = jest.fn(async (sql: any) => {
    const text: string = sql?.sql ?? '';
    const v: any[] = sql?.values ?? [];
    if (text.includes('completion:spool')) {
      const s = db.t('spool').find((x: any) => x.id === v[1]);
      if (!s) return 0;
      s.currentWeight = Math.max(0, s.currentWeight - v[0]);
      return 1;
    }
    if (text.includes('completion:part')) {
      const p = db.t('part').find((x: any) => x.id === v[1]);
      if (!p) return 0;
      p.stockQty = Math.max(0, p.stockQty - v[0]);
      return 1;
    }
    throw new Error(`fake db: unsupported raw statement ${text.slice(0, 60)}`);
  });
  db.spool.groupBy = jest.fn(async ({ where }: any) => {
    const sums = new Map<string, number>();
    for (const s of db.t('spool')) {
      if (s.isActive === false || !where.materialId.in.includes(s.materialId)) continue;
      sums.set(s.materialId, (sums.get(s.materialId) ?? 0) + s.currentWeight);
    }
    return [...sums].map(([materialId, w]) => ({ materialId, _sum: { currentWeight: w } }));
  });
  db.jobMaterial.groupBy = jest.fn(async () => {
    const active = new Set(db.t('productionJob').filter((j: any) => ['QUEUED', 'IN_PROGRESS', 'PAUSED'].includes(j.status)).map((j: any) => j.id));
    const sums = new Map<string, number>();
    for (const m of db.t('jobMaterial')) if (m.spoolId && active.has(m.jobId)) sums.set(m.spoolId, (sums.get(m.spoolId) ?? 0) + m.gramsUsed);
    return [...sums].map(([spoolId, g]) => ({ spoolId, _sum: { gramsUsed: g } }));
  });

  const prisma = db as any;
  const resolver = new BomResolverService(prisma);
  const planner = new ProductionPlannerService(prisma, resolver);
  const stock = new ProductStockService(prisma);
  const completion = new JobCompletionService(prisma, stock);
  const planning = new JobPlanningService(prisma, resolver, planner, stock);
  const costing = {
    calculateJobCost: jest.fn(async () => ({ materialCost: 0, machineCost: 0, electricityCost: 0, wasteCost: 0, overheadCost: 0, totalCost: 0 })),
  } as any;
  const gateway = { broadcastNotification: jest.fn() } as any;
  const scheduling = {} as any;
  const jobs = new JobsService(prisma, costing, gateway, planning, scheduling, completion, resolver, planner);
  return { db, resolver, planner, stock, completion, planning, jobs, costing, gateway };
}

export type ProductionHarness = ReturnType<typeof productionHarness>;

let seq = 0;

/** An order with lines; returns { order, items }. */
export function addOrder(db: FakeCatalogDb, lines: Array<Record<string, any>>, status = 'CONFIRMED') {
  const order = db.insert('order', { orderNumber: `ORD-${String(++seq).padStart(4, '0')}`, status, customerId: null });
  const items = lines.map((l) =>
    db.insert('orderItem', {
      orderId: order.id, productId: null, variantId: null, sizeOptionId: null, colourOptionId: null,
      description: 'line', quantity: 1, unitPrice: 1, totalPrice: 1, ...l,
    }),
  );
  return { order, items };
}

/** A spool of `materialId` (the material row must exist). */
export function addSpool(db: FakeCatalogDb, materialId: string, currentWeight: number, extra: Record<string, any> = {}) {
  return db.insert('spool', { materialId, currentWeight, isActive: true, printforgeId: null, locationId: null, ...extra });
}

export function addJobRow(db: FakeCatalogDb, job: Record<string, any>) {
  return db.insert('productionJob', {
    name: 'job', status: 'QUEUED', orderId: null, orderItemId: null, productId: null, variantId: null, componentId: null,
    sizeOptionId: null, colourOptionId: null, quantityToProduce: 1, reprintOfId: null, purpose: 'CUSTOMER', printerId: null,
    surplusPolicy: null, stockMode: null, gcodeFilename: null, printDuration: null, filamentUsedMm: null, colorChanges: 0,
    purgeWasteGrams: 0, assignedToId: null, ...job,
  });
}

/** Expect a Nest HTTP error with this status (and optionally a message part). */
export async function expectStatus(p: Promise<unknown>, status: number, message?: string | RegExp) {
  let err: any;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  expect(typeof err?.getStatus === 'function' ? err.getStatus() : 500).toBe(status);
  if (message) {
    if (typeof message === 'string') expect(err.message).toContain(message);
    else expect(err.message).toMatch(message);
  }
  return err;
}
