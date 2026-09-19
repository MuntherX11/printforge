/**
 * In-memory Prisma stand-in for the products API specs (WP4).
 *
 * Supports what the products, variants, colour-slot, materials and parts
 * services use: findUnique/findFirst/findMany/count/create/createMany/update/
 * updateMany/upsert/delete/deleteMany with nested include/select, relation
 * filters (`some`, to-one), compound unique keys, `$transaction` with rollback
 * (a failing transaction leaves the tables as they were), the `lock:` row locks
 * of product-locks.ts and the `stock:` statements of stock-sql.ts.
 */

type Row = Record<string, any>;
interface Rel { model: string; many: boolean; fk: string; local?: string }

const many = (model: string, fk: string): Rel => ({ model, many: true, fk });
const one = (model: string, local: string): Rel => ({ model, many: false, fk: 'id', local });

const RELATIONS: Record<string, Record<string, Rel>> = {
  product: {
    variants: many('productVariant', 'productId'),
    components: many('productComponent', 'productId'),
    colourSlots: many('productColourSlot', 'productId'),
    parts: many('productPart', 'productId'),
    priceTiers: many('priceTier', 'productId'),
    images: many('productImage', 'productId'),
    defaultPrinter: one('printer', 'defaultPrinterId'),
  },
  productVariant: {
    colourAssignments: many('colourOptionSlot', 'variantId'),
    sizeExclusions: many('colourSizeExclusion', 'variantId'),
    priceTiers: many('variantPriceTier', 'variantId'),
    components: many('productComponent', 'variantId'),
    product: one('product', 'productId'),
  },
  productComponent: {
    material: one('material', 'materialId'),
    materials: many('componentMaterial', 'componentId'),
    plateLayouts: many('plateLayout', 'componentId'),
    colourStock: many('componentColourStock', 'componentId'),
    stockMovements: many('componentStockMovement', 'componentId'),
    product: one('product', 'productId'),
    variant: one('productVariant', 'variantId'),
  },
  componentMaterial: { material: one('material', 'materialId'), component: one('productComponent', 'componentId') },
  productColourSlot: { assignments: many('colourOptionSlot', 'colourSlotId') },
  colourOptionSlot: { material: one('material', 'materialId'), variant: one('productVariant', 'variantId'), colourSlot: one('productColourSlot', 'colourSlotId') },
  plateLayout: { slots: many('plateLayoutSlot', 'layoutId') },
  productPart: { part: one('part', 'partId'), product: one('product', 'productId') },
  orderItem: { order: one('order', 'orderId') },
  quoteItem: { quote: one('quote', 'quoteId') },
  productionJob: { plates: many('jobPlate', 'jobId'), materials: many('jobMaterial', 'jobId') },
  jobMaterial: { job: one('productionJob', 'jobId') },
  material: { spools: many('spool', 'materialId') },
};

/** Children deleted with their parent (onDelete: Cascade in schema.prisma). */
const CASCADE: Record<string, Array<[string, string]>> = {
  product: [['productVariant', 'productId'], ['productComponent', 'productId'], ['productColourSlot', 'productId'], ['productPart', 'productId'], ['priceTier', 'productId'], ['productImage', 'productId']],
  productVariant: [['colourOptionSlot', 'variantId'], ['colourSizeExclusion', 'variantId'], ['variantPriceTier', 'variantId'], ['productComponent', 'variantId']],
  productComponent: [['componentMaterial', 'componentId'], ['plateLayout', 'componentId'], ['componentColourStock', 'componentId'], ['componentStockMovement', 'componentId']],
  plateLayout: [['plateLayoutSlot', 'layoutId']],
  productColourSlot: [['colourOptionSlot', 'colourSlotId']],
};
/** onDelete: SetNull children. */
const SET_NULL: Record<string, Array<[string, string]>> = {
  productColourSlot: [['productComponent', 'colourSlotId'], ['componentMaterial', 'colourSlotId']],
  productComponent: [['jobPlate', 'componentId']],
  plateLayout: [['jobPlate', 'layoutId']],
};

const MODELS = [
  'product', 'productVariant', 'productComponent', 'componentMaterial', 'productColourSlot', 'colourOptionSlot',
  'colourSizeExclusion', 'priceTier', 'variantPriceTier', 'componentColourStock', 'componentStockMovement',
  'plateLayout', 'plateLayoutSlot', 'jobPlate', 'productPart', 'part', 'attachment', 'material', 'spool',
  'jobMaterial', 'orderItem', 'order', 'quoteItem', 'quote', 'productionJob', 'printer', 'productImage',
];

const LOCK_TABLES: Record<string, string> = { Product: 'product', ProductVariant: 'productVariant', Material: 'material' };

function prismaError(code: string, message: string) {
  const e: any = new Error(message);
  e.code = code;
  return e;
}

const isPlainObject = (v: unknown): v is Row => !!v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);
const eq = (a: any, b: any) => (a instanceof Date || b instanceof Date ? new Date(a).getTime() === new Date(b).getTime() : a === b);

export function fakeCatalogDb() {
  let tables: Record<string, Row[]> = Object.fromEntries(MODELS.map((m) => [m, []]));
  let seq = 0;
  const locks: Array<{ table: string; mode: string; ids: string[] }> = [];
  const calls: string[] = [];

  const rel = (model: string, key: string): Rel | undefined => RELATIONS[model]?.[key];

  function related(model: string, row: Row, key: string): Row[] | Row | null {
    const r = rel(model, key)!;
    if (r.many) return tables[r.model].filter((c) => c[r.fk] === row.id);
    const v = row[r.local!];
    return v == null ? null : tables[r.model].find((c) => c.id === v) ?? null;
  }

  function matchValue(v: any, cond: any): boolean {
    if (cond === undefined) return true;
    if (cond === null) return v === null || v === undefined;
    if (!isPlainObject(cond)) return eq(v ?? null, cond);
    const insensitive = cond.mode === 'insensitive';
    const norm = (x: any) => (insensitive && typeof x === 'string' ? x.toLowerCase() : x);
    for (const [op, arg] of Object.entries(cond)) {
      switch (op) {
        case 'mode': break;
        case 'equals': if (!eq(norm(v), norm(arg))) return false; break;
        case 'in': if (!(arg as any[]).some((a) => eq(v, a))) return false; break;
        case 'notIn': if ((arg as any[]).some((a) => eq(v, a))) return false; break;
        case 'not': if (isPlainObject(arg) ? matchValue(v, arg) : arg === null ? v === null || v === undefined : eq(v, arg)) return false; break;
        case 'gt': if (!(v != null && v > arg)) return false; break;
        case 'gte': if (!(v != null && v >= arg)) return false; break;
        case 'lt': if (!(v != null && v < arg)) return false; break;
        case 'lte': if (!(v != null && v <= arg)) return false; break;
        case 'contains': if (typeof v !== 'string' || !norm(v).includes(norm(arg))) return false; break;
        case 'startsWith': if (typeof v !== 'string' || !norm(v).startsWith(norm(arg))) return false; break;
        default: throw new Error(`fake db: unsupported operator ${op}`);
      }
    }
    return true;
  }

  function matches(model: string, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (key === 'AND') { if (!(Array.isArray(cond) ? cond : [cond]).every((w) => matches(model, row, w))) return false; continue; }
      if (key === 'OR') { if (!(cond as Row[]).some((w) => matches(model, row, w))) return false; continue; }
      if (key === 'NOT') { if ((Array.isArray(cond) ? cond : [cond]).some((w) => matches(model, row, w))) return false; continue; }
      const r = rel(model, key);
      if (r) {
        const target = related(model, row, key);
        if (r.many) {
          const list = target as Row[];
          if (cond.some && !list.some((c) => matches(r.model, c, cond.some))) return false;
          if (cond.none && list.some((c) => matches(r.model, c, cond.none))) return false;
          if (cond.every && !list.every((c) => matches(r.model, c, cond.every))) return false;
        } else if (cond === null) {
          if (target) return false;
        } else {
          const w = cond.is ?? cond;
          if (!target || !matches(r.model, target as Row, w)) return false;
        }
        continue;
      }
      if (!(key in row) && isPlainObject(cond) && key.includes('_')) {
        if (!matches(model, row, cond)) return false;
        continue;
      }
      if (!matchValue(row[key], cond)) return false;
    }
    return true;
  }

  function sortRows(rows: Row[], orderBy: any): Row[] {
    if (!orderBy) return rows;
    const list = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...rows].sort((a, b) => {
      for (const o of list) {
        const [k, dir] = Object.entries(o)[0] as [string, any];
        if (typeof dir !== 'string') continue;
        const av = a[k] instanceof Date ? a[k].getTime() : a[k];
        const bv = b[k] instanceof Date ? b[k].getTime() : b[k];
        if (av === bv) continue;
        const c = av == null ? -1 : bv == null ? 1 : av < bv ? -1 : 1;
        return dir === 'desc' ? -c : c;
      }
      return 0;
    });
  }

  function project(model: string, row: Row, args: Row = {}): Row {
    const nested = (key: string, spec: any) => {
      const r = rel(model, key)!;
      const sub = spec === true ? {} : spec;
      const target = related(model, row, key);
      if (r.many) {
        let list = (target as Row[]).filter((c) => matches(r.model, c, sub.where));
        list = sortRows(list, sub.orderBy);
        if (sub.skip) list = list.slice(sub.skip);
        if (sub.take !== undefined) list = list.slice(0, sub.take);
        return list.map((c) => project(r.model, c, sub));
      }
      return target ? project(r.model, target as Row, sub) : null;
    };
    const counts = (spec: any) => {
      const out: Row = {};
      for (const k of Object.keys(spec.select ?? {})) {
        const r = rel(model, k)!;
        const s = spec.select[k];
        out[k] = (related(model, row, k) as Row[]).filter((c) => matches(r.model, c, s === true ? undefined : s.where)).length;
      }
      return out;
    };
    if (args.select) {
      const out: Row = {};
      for (const [k, v] of Object.entries(args.select)) {
        if (!v) continue;
        if (k === '_count') out[k] = counts(v);
        else if (rel(model, k)) out[k] = nested(k, v);
        else out[k] = row[k] instanceof Date ? new Date(row[k]) : structuredClone(row[k]);
      }
      return out;
    }
    const out: Row = structuredClone(row);
    for (const [k, v] of Object.entries(args.include ?? {})) {
      if (!v) continue;
      if (k === '_count') out[k] = counts(v);
      else out[k] = nested(k, v);
    }
    return out;
  }

  function applyData(row: Row, data: Row) {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (isPlainObject(v) && ('increment' in v || 'decrement' in v || 'set' in v)) {
        if ('increment' in v) row[k] = (row[k] ?? 0) + v.increment;
        if ('decrement' in v) row[k] = (row[k] ?? 0) - v.decrement;
        if ('set' in v) row[k] = v.set;
      } else if (isPlainObject(v) && ('connect' in v || 'create' in v)) {
        throw new Error(`fake db: nested writes are not supported (${k})`);
      } else row[k] = v;
    }
    if ('updatedAt' in row) row.updatedAt = new Date();
  }

  function removeRow(model: string, row: Row) {
    tables[model] = tables[model].filter((r) => r !== row);
    for (const [child, fk] of CASCADE[model] ?? []) for (const c of tables[child].filter((x) => x[fk] === row.id)) removeRow(child, c);
    for (const [child, fk] of SET_NULL[model] ?? []) for (const c of tables[child]) if (c[fk] === row.id) c[fk] = null;
  }

  function uniqueGuard(model: string, row: Row, except?: Row) {
    const keys: Record<string, string[][]> = {
      product: [['sku']], productVariant: [['sku']], productColourSlot: [['productId', 'name']],
      colourOptionSlot: [['variantId', 'colourSlotId']], colourSizeExclusion: [['variantId', 'sizeKey']],
      priceTier: [['productId', 'minQty']], variantPriceTier: [['variantId', 'minQty']],
      componentMaterial: [['componentId', 'colorIndex']], componentColourStock: [['componentId', 'colourKey']],
      productPart: [['productId', 'partId']],
    };
    for (const cols of keys[model] ?? []) {
      if (cols.some((c) => row[c] == null)) continue;
      if (tables[model].some((r) => r !== except && r !== row && cols.every((c) => eq(r[c], row[c])))) {
        throw prismaError('P2002', `Unique constraint failed on ${cols.join(',')}`);
      }
    }
  }

  function delegate(model: string) {
    const all = (where?: Row) => tables[model].filter((r) => matches(model, r, where));
    const find = (where: Row) => all(where)[0];
    const d = {
      findUnique: async (a: Row) => { calls.push(`${model}.findUnique`); const r = find(a.where); return r ? project(model, r, a) : null; },
      findFirst: async (a: Row = {}) => { const r = sortRows(all(a.where), a.orderBy)[0]; return r ? project(model, r, a) : null; },
      findMany: async (a: Row = {}) => {
        let list = sortRows(all(a.where), a.orderBy);
        if (a.skip) list = list.slice(a.skip);
        if (a.take !== undefined) list = list.slice(0, a.take);
        return list.map((r) => project(model, r, a));
      },
      count: async (a: Row = {}) => all(a.where).length,
      create: async (a: Row) => {
        const now = new Date();
        const row: Row = { id: `${model}-${++seq}`, createdAt: now, updatedAt: now, ...structuredClone(a.data) };
        uniqueGuard(model, row);
        tables[model].push(row);
        return project(model, row, a);
      },
      createMany: async (a: Row) => {
        for (const data of a.data) await d.create({ data });
        return { count: a.data.length };
      },
      update: async (a: Row) => {
        calls.push(`${model}.update`);
        const r = find(a.where);
        if (!r) throw prismaError('P2025', `${model} not found`);
        const next = { ...r };
        applyData(next, a.data);
        uniqueGuard(model, next, r);
        Object.assign(r, next);
        return project(model, r, a);
      },
      updateMany: async (a: Row) => {
        const list = all(a.where);
        for (const r of list) applyData(r, a.data);
        return { count: list.length };
      },
      upsert: async (a: Row) => {
        const r = find(a.where);
        if (r) return d.update({ where: { id: r.id }, data: a.update, include: a.include, select: a.select });
        return d.create({ data: a.create, include: a.include, select: a.select });
      },
      delete: async (a: Row) => {
        calls.push(`${model}.delete`);
        const r = find(a.where);
        if (!r) throw prismaError('P2025', `${model} not found`);
        const out = project(model, r, {});
        removeRow(model, r);
        return out;
      },
      deleteMany: async (a: Row = {}) => {
        calls.push(`${model}.deleteMany`);
        const list = all(a.where);
        for (const r of list) removeRow(model, r);
        return { count: list.length };
      },
    };
    return d;
  }

  const rk = (c: string, k: string) => tables.componentColourStock.find((r) => r.componentId === c && r.colourKey === k);
  const ret = (n: number | null | undefined) => (n === null || n === undefined ? [] : [{ stockOnHand: n }]);
  const comp = (id: string) => tables.productComponent.find((c) => c.id === id);

  async function queryRaw(sql: { sql: string; values: any[] }) {
    const text = sql.sql ?? String(sql);
    const v = sql.values ?? [];
    const lock = /lock:(\w+):(\w+)/.exec(text);
    if (lock) {
      const model = LOCK_TABLES[lock[1]];
      const ids: string[] = v[0];
      locks.push({ table: lock[1], mode: lock[2], ids });
      return tables[model].filter((r) => ids.includes(r.id)).map((r) => structuredClone(r));
    }
    const name = /stock:(\w+)/.exec(text)?.[1];
    switch (name) {
      case 'addColumn': { const c = comp(v[1]); if (!c) return []; c.stockOnHand += v[0]; return ret(c.stockOnHand); }
      case 'takeColumn': { const c = comp(v[1]); if (!c || c.stockOnHand < v[2]) return []; c.stockOnHand -= v[0]; return ret(c.stockOnHand); }
      case 'addRow': {
        let r = rk(v[1], v[2]);
        if (!r) { r = { id: `ccs-${++seq}`, componentId: v[1], colourKey: v[2], stockOnHand: 0, updatedAt: new Date() }; tables.componentColourStock.push(r); }
        r.stockOnHand += v[3];
        return ret(r.stockOnHand);
      }
      case 'takeRow': { const r = rk(v[1], v[2]); if (!r || r.stockOnHand < v[3]) return []; r.stockOnHand -= v[0]; return ret(r.stockOnHand); }
      case 'lockColumn': case 'readColumn': return ret(comp(v[0])?.stockOnHand);
      case 'lockRow': case 'readRow': return ret(rk(v[0], v[1])?.stockOnHand);
      case 'setColumnIf': { const c = comp(v[1]); if (!c || c.stockOnHand !== v[2]) return []; c.stockOnHand = v[0]; c.stockConfirmedAt = new Date(); return ret(c.stockOnHand); }
      case 'ensureRow': { if (!rk(v[1], v[2])) tables.componentColourStock.push({ id: `ccs-${++seq}`, componentId: v[1], colourKey: v[2], stockOnHand: 0, updatedAt: new Date() }); return []; }
      case 'setRowIf': { const r = rk(v[1], v[2]); if (!r || r.stockOnHand !== v[3]) return []; r.stockOnHand = v[0]; return ret(v[0]); }
    }
    throw new Error(`fake db: unsupported raw query ${text.slice(0, 60)}`);
  }

  const db: Row = {
    locks,
    calls,
    tables: () => tables,
    t: (model: string) => tables[model],
    insert(model: string, row: Row) {
      const now = new Date();
      const full = { createdAt: now, updatedAt: now, ...row, id: row.id ?? `${model}-${++seq}` };
      tables[model].push(full);
      return full;
    },
    $queryRaw: jest.fn(queryRaw),
    $executeRaw: jest.fn(async () => 0),
    $transaction: jest.fn(async (arg: any) => {
      if (Array.isArray(arg)) {
        const out = [];
        for (const p of arg) out.push(await p);
        return out;
      }
      const snapshot = structuredClone(tables);
      try {
        return await arg(db);
      } catch (e) {
        tables = snapshot;
        throw e;
      }
    }),
  };
  for (const m of MODELS) db[m] = delegate(m);
  return db;
}

export type FakeCatalogDb = ReturnType<typeof fakeCatalogDb>;

/**
 * Flatten a nested fixture row (catalog-core/__fixtures__/sardine-tin.ts shape)
 * into the fake's tables, so services read it back through ordinary queries.
 */
export function seedProduct(db: FakeCatalogDb, row: Row) {
  const T0 = new Date('2026-01-01T00:00:00Z');
  const mat = (m: any) => { if (m && !db.t('material').some((x: Row) => x.id === m.id)) db.insert('material', { ...m }); };
  const { variants = [], components = [], colourSlots = [], parts = [], defaultPrinter, images = [], priceTiers = [], ...product } = row;
  if (defaultPrinter && !db.t('printer').some((p: Row) => p.id === defaultPrinter.id)) db.insert('printer', { ...defaultPrinter });
  db.insert('product', { description: null, sku: null, estimatedGrams: 0, estimatedMinutes: 0, imageUrl: null, createdAt: T0, ...product });
  for (const s of colourSlots) db.insert('productColourSlot', { createdAt: T0, ...s, productId: row.id });
  for (const v of variants) {
    const { colourAssignments = [], sizeExclusions = [], priceTiers: vt = [], ...rest } = v;
    db.insert('productVariant', { sku: null, updatedAt: T0, ...rest, productId: row.id });
    for (const a of colourAssignments) { mat(a.material); db.insert('colourOptionSlot', { variantId: v.id, colourSlotId: a.colourSlotId, materialId: a.materialId }); }
    for (const e of sizeExclusions) db.insert('colourSizeExclusion', { variantId: v.id, sizeKey: e.sizeKey });
    for (const t of vt) db.insert('variantPriceTier', { ...t, variantId: v.id });
  }
  for (const c of components) {
    const { material, materials = [], plateLayouts = [], colourStock = [], ...rest } = c;
    mat(material);
    db.insert('productComponent', { thumbnailAttachmentId: null, ...rest, productId: row.id });
    materials.forEach((m: Row, i: number) => {
      mat(m.material);
      const { material: _m, ...cm } = m;
      db.insert('componentMaterial', { sortOrder: i, ...cm, componentId: c.id });
    });
    for (const l of plateLayouts) {
      const { slots = [], ...lr } = l;
      db.insert('plateLayout', { source: 'GCODE', objectCount: null, ...lr, componentId: c.id });
      for (const s of slots) db.insert('plateLayoutSlot', { ...s, layoutId: l.id });
    }
    for (const s of colourStock) db.insert('componentColourStock', { ...s, componentId: c.id });
  }
  for (const p of parts) {
    if (p.part && !db.t('part').some((x: Row) => x.id === p.part.id)) db.insert('part', { ...p.part });
    db.insert('productPart', { productId: row.id, partId: p.partId, quantity: p.quantity ?? 1, sortOrder: 0 });
  }
  for (const t of priceTiers) db.insert('priceTier', { ...t, productId: row.id });
  for (const i of images) db.insert('productImage', { ...i, productId: row.id });
}
