/**
 * A small in-memory Prisma for the planner and open-line-impact specs: products
 * (via resolverPrisma), orders with lines, quotes with lines, jobs with plates and
 * lines, ledger movements, spools. Only the query shapes those services use.
 */
import { resolverPrisma, type FixtureRow } from './sardine-tin';

export interface FakeOrder {
  id: string;
  orderNumber: string;
  status: string;
  items: Array<{ id: string; productId: string | null; variantId?: string | null; sizeOptionId?: string | null; colourOptionId?: string | null; quantity: number; description: string }>;
}
export interface FakeQuote {
  id: string;
  quoteNumber: string;
  status: string;
  items: Array<{ id: string; productId: string | null; sizeOptionId?: string | null; colourOptionId?: string | null; quantity: number; description: string }>;
}
export interface FakeJob {
  id: string;
  status: string;
  orderId?: string | null;
  orderItemId?: string | null;
  productId?: string | null;
  componentId?: string | null;
  quantityToProduce?: number;
  reprintOfId?: string | null;
  plates?: Array<{ componentId: string | null; unitsRequired: number }>;
  materials?: Array<{ materialId: string; gramsUsed: number; spoolId?: string | null }>;
}
export interface FakeSpool {
  id: string;
  materialId: string;
  currentWeight: number;
  isActive?: boolean;
  printforgeId?: string | null;
  material?: any;
  location?: { id: string; name: string } | null;
}

export function plannerPrisma(state: {
  rows: FixtureRow[];
  orders?: FakeOrder[];
  quotes?: FakeQuote[];
  jobs?: FakeJob[];
  movements?: Array<{ orderItemId: string; componentId: string; colourKey: string; delta: number; reason: string }>;
  spools?: FakeSpool[];
  materials?: any[];
}) {
  const orders = state.orders ?? [];
  const quotes = state.quotes ?? [];
  const jobs = (state.jobs ?? []).map((j) => ({ orderId: null, orderItemId: null, productId: null, componentId: null, quantityToProduce: 1, reprintOfId: null, plates: [], materials: [], ...j }));
  const movements = state.movements ?? [];
  const spools = (state.spools ?? []).map((s) => ({ isActive: true, printforgeId: null, location: null, ...s }));
  const allItems = orders.flatMap((o) => o.items.map((i) => ({ ...i, orderId: o.id, order: { orderNumber: o.orderNumber, status: o.status } })));

  const inList = (cond: any, v: any) => (cond?.in ? cond.in.includes(v) : true);
  const jobMatches = (j: any, where: any): boolean => {
    if (where.orderItemId?.in && !where.orderItemId.in.includes(j.orderItemId)) return false;
    if (where.status && !inList(where.status, j.status)) return false;
    if (where.OR && !where.OR.some((w: any) => ('orderId' in w ? (w.orderId === null ? j.orderId === null : j.orderId !== null && j.orderId !== w.orderId.not) : true))) return false;
    return true;
  };

  const prisma: any = resolverPrisma(state.rows, {
    orderItem: {
      findMany: jest.fn(async ({ where }: any) => {
        if (where.id?.in) return allItems.filter((i) => where.id.in.includes(i.id));
        return allItems.filter((i) => i.productId === where.productId && inList(where.order?.status, i.order.status));
      }),
    },
    quoteItem: {
      findMany: jest.fn(async ({ where }: any) =>
        quotes.filter((q) => inList(where.quote?.status, q.status)).flatMap((q) => q.items.filter((i) => i.productId === where.productId).map((i) => ({ ...i, quote: { quoteNumber: q.quoteNumber } })))),
    },
    order: {
      findMany: jest.fn(async ({ where }: any) =>
        orders.filter((o) => inList(where.status, o.status) && (!where.id?.not || o.id !== where.id.not))),
    },
    productionJob: { findMany: jest.fn(async ({ where }: any) => jobs.filter((j) => jobMatches(j, where))) },
    componentStockMovement: {
      findMany: jest.fn(async ({ where }: any) => movements.filter((m) => where.orderItemId.in.includes(m.orderItemId) && inList(where.reason, m.reason))),
    },
    spool: {
      groupBy: jest.fn(async ({ where }: any) => {
        const sums = new Map<string, number>();
        for (const s of spools) if (s.isActive && where.materialId.in.includes(s.materialId)) sums.set(s.materialId, (sums.get(s.materialId) ?? 0) + s.currentWeight);
        return [...sums].map(([materialId, w]) => ({ materialId, _sum: { currentWeight: w } }));
      }),
      findMany: jest.fn(async ({ where }: any) =>
        spools.filter((s) => s.isActive && s.currentWeight > 0 && where.material.type.in.includes(s.material?.type)).sort((a, b) => a.currentWeight - b.currentWeight)),
    },
    jobMaterial: {
      groupBy: jest.fn(async () => {
        const sums = new Map<string, number>();
        for (const j of jobs) if (['QUEUED', 'IN_PROGRESS', 'PAUSED'].includes(j.status)) for (const m of j.materials ?? []) if (m.spoolId) sums.set(m.spoolId, (sums.get(m.spoolId) ?? 0) + m.gramsUsed);
        return [...sums].map(([spoolId, g]) => ({ spoolId, _sum: { gramsUsed: g } }));
      }),
    },
    material: { findMany: jest.fn(async ({ where }: any) => (state.materials ?? []).filter((m) => where.id.in.includes(m.id))) },
  });
  return prisma;
}
