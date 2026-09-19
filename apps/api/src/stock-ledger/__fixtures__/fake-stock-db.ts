/**
 * In-memory stand-in for the transaction the stock ledger writes through.
 * Drives the `stock:<name>` statements of stock-sql.ts by name, with the same
 * atomic semantics (guarded decrements, upserts, RETURNING the new balance).
 */
export interface FakeComponent {
  id: string;
  description: string;
  materialId: string | null;
  isMultiColor: boolean;
  materials: Array<{ colorIndex: number; materialId: string }>;
  stockOnHand: number;
  stockConfirmedAt: Date | null;
}

export function fakeStockDb() {
  const comps = new Map<string, FakeComponent>();
  const rows = new Map<string, number>();
  const movements: any[] = [];
  const variants = new Map<string, { kind: string }>();
  const orderItems: Array<{ id: string; orderId: string }> = [];
  const rk = (c: string, k: string) => `${c}|${k}`;
  const ret = (n: number | null | undefined) => (n === null || n === undefined ? [] : [{ stockOnHand: n }]);

  const exec = async (sql: { sql: string; values: any[] }) => {
    const name = /stock:(\w+)/.exec(sql.sql)![1];
    const v = sql.values;
    await Promise.resolve(); // yield, so concurrent callers interleave
    switch (name) {
      case 'addColumn': {
        const c = comps.get(v[1]);
        if (!c) return [];
        c.stockOnHand += v[0];
        return ret(c.stockOnHand);
      }
      case 'takeColumn': {
        const c = comps.get(v[1]);
        if (!c || c.stockOnHand < v[2]) return [];
        c.stockOnHand -= v[0];
        return ret(c.stockOnHand);
      }
      case 'addRow': {
        const k = rk(v[1], v[2]);
        rows.set(k, (rows.get(k) ?? 0) + v[3]);
        return ret(rows.get(k));
      }
      case 'takeRow': {
        const k = rk(v[1], v[2]);
        if (!rows.has(k) || rows.get(k)! < v[3]) return [];
        rows.set(k, rows.get(k)! - v[0]);
        return ret(rows.get(k));
      }
      case 'lockColumn':
      case 'readColumn':
        return ret(comps.get(v[0])?.stockOnHand);
      case 'lockRow':
      case 'readRow':
        return ret(rows.get(rk(v[0], v[1])));
      case 'setColumnIf': {
        const c = comps.get(v[1]);
        if (!c || c.stockOnHand !== v[2]) return [];
        c.stockOnHand = v[0];
        c.stockConfirmedAt = new Date();
        return ret(c.stockOnHand);
      }
      case 'ensureRow': {
        const k = rk(v[1], v[2]);
        if (!rows.has(k)) rows.set(k, 0);
        return [];
      }
      case 'setRowIf': {
        const k = rk(v[1], v[2]);
        if (!rows.has(k) || rows.get(k) !== v[3]) return [];
        rows.set(k, v[0]);
        return ret(v[0]);
      }
    }
    throw new Error(`unknown statement ${name}`);
  };

  const tx: any = {
    $queryRaw: jest.fn(exec),
    productComponent: {
      findUnique: jest.fn(async ({ where }: any) => {
        const c = comps.get(where.id);
        return c ? { ...c, materials: c.materials.map((m) => ({ ...m })) } : null;
      }),
    },
    productVariant: { findUnique: jest.fn(async ({ where }: any) => variants.get(where.id) ?? null) },
    orderItem: { findMany: jest.fn(async ({ where }: any) => orderItems.filter((o) => o.orderId === where.orderId).map((o) => ({ id: o.id }))) },
    componentStockMovement: {
      create: jest.fn(async ({ data }: any) => { movements.push({ ...data }); return data; }),
      findMany: jest.fn(async ({ where }: any) =>
        movements.filter((m) => m.orderItemId === where.orderItemId && (!where.reason || where.reason.in.includes(m.reason)))),
    },
  };

  const addComponent = (c: Partial<FakeComponent> & { id: string }) => {
    comps.set(c.id, { description: c.id, materialId: null, isMultiColor: false, materials: [], stockOnHand: 0, stockConfirmedAt: new Date(0), ...c });
  };
  return {
    tx, comps, rows, movements, variants, orderItems, addComponent,
    row: (c: string, k: string) => rows.get(rk(c, k)) ?? 0,
    column: (c: string) => comps.get(c)!.stockOnHand,
  };
}
