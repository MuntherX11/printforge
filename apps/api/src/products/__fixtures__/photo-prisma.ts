/**
 * In-memory Prisma stand-in for the photo specs (product images, BF-2,
 * attachments). Supports just the query shapes those services use.
 */
type Row = Record<string, any>;

function matchValue(v: any, cond: any): boolean {
  if (cond === null) return v === null || v === undefined;
  if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
  if (typeof cond === 'object' && !Array.isArray(cond)) {
    if ('not' in cond) {
      if (cond.not === null ? v === null || v === undefined : v === cond.not) return false;
    }
    const cmp = (x: any) => (x instanceof Date ? x.getTime() : x);
    if ('lt' in cond && !(cmp(v) < cmp(cond.lt))) return false;
    if ('lte' in cond && !(cmp(v) <= cmp(cond.lte))) return false;
    if ('gt' in cond && !(cmp(v) > cmp(cond.gt))) return false;
    if ('gte' in cond && !(cmp(v) >= cmp(cond.gte))) return false;
    if ('in' in cond && !cond.in.includes(v)) return false;
    return true;
  }
  return v === cond;
}

export function matches(row: Row, where: any = {}): boolean {
  for (const [k, cond] of Object.entries(where ?? {})) {
    if (k === 'OR') {
      if (!(cond as any[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (k === 'AND') {
      if (!(cond as any[]).every((w) => matches(row, w))) return false;
      continue;
    }
    if (!matchValue(row[k], cond)) return false;
  }
  return true;
}

function pick(row: Row, select?: Record<string, any>) {
  if (!select) return { ...row };
  const out: Row = {};
  for (const k of Object.keys(select)) out[k] = row[k];
  return out;
}

function sortRows(rows: Row[], orderBy: any) {
  if (!orderBy) return rows;
  const keys: Array<[string, 'asc' | 'desc']> = (Array.isArray(orderBy) ? orderBy : [orderBy]).map(
    (o: any) => Object.entries(o)[0] as [string, 'asc' | 'desc'],
  );
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const x = a[k] instanceof Date ? a[k].getTime() : a[k];
      const y = b[k] instanceof Date ? b[k].getTime() : b[k];
      if (x < y) return dir === 'asc' ? -1 : 1;
      if (x > y) return dir === 'asc' ? 1 : -1;
    }
    return 0;
  });
}

let seq = 0;
export const nextId = (p: string) => `${p}${(++seq).toString().padStart(6, '0')}`;

export class FakeTable {
  rows: Row[] = [];
  /** Optional hook to make create() fail (e.g. simulate P2003). */
  failCreate: ((data: Row) => Error | null) | null = null;

  constructor(private prefix: string, private defaults: () => Row = () => ({})) {}

  async findMany(args: any = {}) {
    let rows = this.rows.filter((r) => matches(r, args.where));
    rows = sortRows(rows, args.orderBy);
    if (args.distinct) {
      const seen = new Set<string>();
      rows = rows.filter((r) => {
        const k = args.distinct.map((d: string) => r[d]).join('|');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    if (args.take) rows = rows.slice(0, args.take);
    return rows.map((r) => this.project(r, args.select));
  }

  async findFirst(args: any = {}) {
    return (await this.findMany({ ...args, take: 1 }))[0] ?? null;
  }

  async findUnique(args: any) {
    const r = this.rows.find((x) => matches(x, args.where));
    return r ? this.project(r, args.select) : null;
  }

  async count(args: any = {}) {
    return this.rows.filter((r) => matches(r, args.where)).length;
  }

  async aggregate(args: any) {
    const rows = this.rows.filter((r) => matches(r, args.where));
    const out: any = { _max: {} };
    for (const k of Object.keys(args._max ?? {})) {
      out._max[k] = rows.length ? Math.max(...rows.map((r) => r[k])) : null;
    }
    return out;
  }

  async create(args: any) {
    const err = this.failCreate?.(args.data);
    if (err) throw err;
    for (const [k, v] of Object.entries(args.data)) {
      if ((k === 'key' || k === 'storageKey' || k === 'legacyAttachmentId') && v != null && this.rows.some((r) => r[k] === v)) {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
    }
    const row = { id: nextId(this.prefix), createdAt: new Date(), ...this.defaults(), ...args.data };
    this.rows.push(row);
    return { ...row };
  }

  async update(args: any) {
    const r = this.rows.find((x) => matches(x, args.where));
    if (!r) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
    Object.assign(r, args.data);
    return { ...r };
  }

  async updateMany(args: any) {
    const rows = this.rows.filter((x) => matches(x, args.where));
    for (const r of rows) Object.assign(r, args.data);
    return { count: rows.length };
  }

  async delete(args: any) {
    const i = this.rows.findIndex((x) => matches(x, args.where));
    if (i < 0) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
    return this.rows.splice(i, 1)[0];
  }

  async deleteMany(args: any) {
    const before = this.rows.length;
    this.rows = this.rows.filter((x) => !matches(x, args.where));
    return { count: before - this.rows.length };
  }

  private project(r: Row, select?: any) {
    if (!select) return { ...r };
    const out = pick(r, select);
    for (const [k, v] of Object.entries(select)) {
      if (v && typeof v === 'object' && (v as any).select && this.relations[k]) {
        out[k] = this.relations[k](r, (v as any).select);
      }
    }
    return out;
  }

  relations: Record<string, (row: Row, select: any) => any> = {};
}

export function photoPrisma() {
  const db = {
    product: new FakeTable('prod'),
    productImage: new FakeTable('img', () => ({ sortOrder: 0, legacyAttachmentId: null, uploadedById: null })),
    attachment: new FakeTable('att', () => ({ photoMigratedAt: null, uploadedById: null })),
    productComponent: new FakeTable('comp', () => ({ attachmentId: null, thumbnailAttachmentId: null, variantId: null })),
    plateLayout: new FakeTable('lay', () => ({ attachmentId: null })),
    jobPlate: new FakeTable('jp', () => ({ attachmentId: null })),
    systemSetting: new FakeTable('set'),
    /** Rolls back every table when the callback throws. */
    $transaction: async (fn: (tx: any) => Promise<any>) => {
      const tables = ['product', 'productImage', 'attachment', 'productComponent', 'plateLayout', 'jobPlate', 'systemSetting'];
      const snap = tables.map((t) => (db as any)[t].rows.map((r: Row) => ({ ...r })));
      try {
        return await fn(db);
      } catch (e) {
        tables.forEach((t, i) => ((db as any)[t].rows = snap[i]));
        throw e;
      }
    },
    $queryRaw: async (..._a: any[]) => [{ value: 'lease' }],
    $executeRaw: async (..._a: any[]) => 1,
  };
  db.productImage.relations.product = (row, select) => {
    const p = db.product.rows.find((x) => x.id === row.productId);
    return p ? pick(p, select) : null;
  };
  return db;
}

export type PhotoPrisma = ReturnType<typeof photoPrisma>;
