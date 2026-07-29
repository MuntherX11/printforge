/**
 * Pipeline-level tests: storage-key opacity, order-commit behaviour, download
 * authorization/IDOR, and retention. Uses a temp UPLOAD_DIR and a hand-rolled
 * Prisma double so no database is required.
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

const TMP_ROOT = path.join(os.tmpdir(), `pf-artifacts-${Date.now()}`);
process.env.UPLOAD_DIR = TMP_ROOT;

// Import AFTER setting UPLOAD_DIR so the module picks it up.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { ConfiguratorService } from './configurator.service';

const ARTIFACT_DIR = path.join(TMP_ROOT, 'artifacts');

interface Row { [k: string]: any }

/** Minimal in-memory Prisma double covering the calls the service makes. */
function makePrisma() {
  const db = {
    order: [] as Row[],
    configOrder: [] as Row[],
    configArtifact: [] as Row[],
    documentCounter: [] as Row[],
  };
  let seq = 0;
  const id = (p: string) => `${p}_${++seq}`;

  const prisma: any = {
    _db: db,
    order: {
      create: async ({ data }: any) => {
        const row = { id: id('order'), ...data, items: undefined };
        db.order.push(row);
        return row;
      },
      findUnique: async ({ where }: any) => db.order.find((o) => o.id === where.id) ?? null,
    },
    configOrder: {
      create: async ({ data }: any) => {
        const row = { id: id('co'), orderId: data.orderId, generatorKey: data.generatorKey, params: data.params, status: data.status, createdAt: new Date() };
        db.configOrder.push(row);
        for (const a of data.artifacts?.create ?? []) {
          db.configArtifact.push({ id: id('art'), configOrderId: row.id, createdAt: new Date(), ...a });
        }
        return row;
      },
      // Honour `select` like real Prisma, so a leak can't hide behind the double.
      findMany: async ({ where, select }: any) =>
        db.configOrder
          .filter((c) => c.orderId === where.orderId)
          .map((c) => {
            const artifacts = db.configArtifact.filter((a) => a.configOrderId === c.id);
            const artSelect = select?.artifacts?.select;
            const pick = (row: Row, sel: any) =>
              sel ? Object.fromEntries(Object.keys(sel).filter((k) => sel[k]).map((k) => [k, row[k]])) : row;
            const base = select
              ? pick(c, Object.fromEntries(Object.entries(select).filter(([k]) => k !== 'artifacts')))
              : { ...c };
            return { ...base, artifacts: artifacts.map((a) => pick(a, artSelect)) };
          }),
    },
    configArtifact: {
      findUnique: async ({ where }: any) => {
        const a = db.configArtifact.find((x) => x.id === where.id);
        if (!a) return null;
        const co = db.configOrder.find((c) => c.id === a.configOrderId);
        return { ...a, configOrder: co ? { orderId: co.orderId } : null };
      },
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
    },
    $transaction: async (fn: any) => fn(prisma),
    // used by generateNumber()
    $queryRaw: async () => [{ nextval: ++seq }],
  };
  return prisma;
}

// generateNumber hits the DB; stub it so tests stay hermetic.
jest.mock('../common/utils/number-generator', () => ({
  generateNumber: jest.fn(async () => `ORD-TEST-${Math.floor(Math.random() * 1e6)}`),
}));

const validParams = { width: 40, height: 20, thickness: 3, holeDiameter: 4, label: 'Munther' };

describe('ConfiguratorService pipeline', () => {
  let prisma: any;
  let service: ConfiguratorService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new ConfiguratorService(prisma, undefined, undefined);
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ---- §3a opaque storage keys ----
  describe('§3a storage keys are opaque and contain no customer input', () => {
    it('writes files under a random 32-hex key, not the label', async () => {
      const res = await service.createOrder('cust_1', {
        generatorKey: 'nameplate',
        params: { ...validParams, label: '../../etc/passwd' },
      });
      expect(res.orderId).toBeTruthy();

      const artifacts = prisma._db.configArtifact;
      expect(artifacts.length).toBe(2); // .3mf + .stl
      for (const a of artifacts) {
        expect(a.storageKey).toMatch(/^[a-f0-9]{32}$/);
        // No customer string anywhere in the on-disk key
        expect(a.storageKey).not.toContain('passwd');
        expect(a.storageKey).not.toContain('.');
        expect(a.storageKey).not.toContain('/');
      }

      // Files exist on disk under exactly those keys
      const onDisk = await fs.readdir(ARTIFACT_DIR);
      for (const a of artifacts) expect(onDisk).toContain(a.storageKey);
      // and nothing traversal-y was created
      expect(onDisk.every((f) => /^[a-f0-9]{32}$/.test(f))).toBe(true);
    });

    it('keeps the human filename separate from the storage key', async () => {
      await service.createOrder('cust_1', { generatorKey: 'nameplate', params: validParams });
      const a = prisma._db.configArtifact[0];
      expect(a.filename).toMatch(/^[a-zA-Z0-9._-]+$/);
      expect(a.filename).not.toBe(a.storageKey);
    });
  });

  // ---- §1 params are the source of truth ----
  describe('§1 parameters persisted; no client geometry accepted', () => {
    it('stores the validated param set on the config order', async () => {
      await service.createOrder('cust_1', { generatorKey: 'nameplate', params: validParams });
      const co = prisma._db.configOrder[0];
      expect(co.params).toMatchObject({ width: 40, height: 20, thickness: 3 });
      expect(co.generatorKey).toBe('nameplate');
    });

    it('ignores any client-supplied mesh/file fields entirely', async () => {
      await service.createOrder('cust_1', {
        generatorKey: 'nameplate',
        params: { ...validParams, stl: 'AAAA', mesh: [1, 2, 3], file: 'evil.3mf' } as any,
      });
      const co = prisma._db.configOrder[0];
      expect(co.params.stl).toBeUndefined();
      expect(co.params.mesh).toBeUndefined();
      expect(co.params.file).toBeUndefined();
    });

    it('rejects invalid params before any file is written', async () => {
      const before = (await fs.readdir(ARTIFACT_DIR).catch(() => [])).length;
      await expect(
        service.createOrder('cust_1', { generatorKey: 'nameplate', params: { ...validParams, width: -1 } }),
      ).rejects.toThrow();
      // Nothing persisted for this attempt, and no new file landed on disk
      expect(prisma._db.order.length).toBe(0);
      expect(prisma._db.configArtifact.length).toBe(0);
      const after = (await fs.readdir(ARTIFACT_DIR).catch(() => [])).length;
      expect(after).toBe(before);
    });
  });

  // ---- §2 generate at commit only ----
  describe('§2 artifacts are written only at order-commit', () => {
    it('preview endpoints write nothing to disk', async () => {
      const before = await fs.readdir(ARTIFACT_DIR).catch(() => []);
      // info/previewSvg are async (they run behind the preview limiter), so
      // these must be awaited or the assertion races the work it is checking.
      await service.info('nameplate', validParams);
      await service.previewSvg('nameplate', validParams);
      service.choices('nameplate');
      const after = await fs.readdir(ARTIFACT_DIR).catch(() => []);
      expect(after.length).toBe(before.length);
    });

    it('previews still return real content through the limiter', async () => {
      const info = await service.info('nameplate', validParams);
      expect(info.dimensions).toEqual({ width: 40, height: 20, depth: 3 });
      const svg = await service.previewSvg('nameplate', validParams);
      expect(svg).toContain('<svg');
    });

    it('preview limiter serialises concurrent calls without dropping any', async () => {
      const results = await Promise.all(
        Array.from({ length: 25 }, () => service.info('nameplate', validParams)),
      );
      expect(results).toHaveLength(25);
      expect(results.every((r) => r.dimensions.width === 40)).toBe(true);
    });

    it('rejects out-of-range quantity', async () => {
      await expect(
        service.createOrder('cust_1', { generatorKey: 'nameplate', params: validParams, quantity: 0 }),
      ).rejects.toThrow();
      await expect(
        service.createOrder('cust_1', { generatorKey: 'nameplate', params: validParams, quantity: 999 }),
      ).rejects.toThrow();
    });
  });

  // ---- §3b authorization / IDOR ----
  describe('§3b download authorization (IDOR)', () => {
    function mockRes() {
      const headers: Record<string, string> = {};
      return {
        headers,
        setHeader: (k: string, v: string) => { headers[k] = v; },
        // streamArtifact pipes into res; capture that it got that far
        on: () => {}, once: () => {}, emit: () => {}, write: () => true, end: () => {},
      } as any;
    }

    it('rejects an unknown artifact id', async () => {
      await expect(service.streamArtifact('does-not-exist', mockRes())).rejects.toThrow(/not found/i);
    });

    it('rejects an artifact whose storage key is not an opaque token', async () => {
      // Simulate a tampered/legacy row trying to point at an arbitrary path
      prisma._db.configOrder.push({ id: 'co_x', orderId: 'order_x' });
      prisma._db.configArtifact.push({
        id: 'art_evil', configOrderId: 'co_x', filename: 'x.stl',
        mime: 'model/stl', sizeBytes: 1, storageKey: '../../../etc/passwd',
      });
      await expect(service.streamArtifact('art_evil', mockRes())).rejects.toThrow(/not found/i);
    });

    it('rejects an artifact orphaned from any order', async () => {
      prisma._db.configArtifact.push({
        id: 'art_orphan', configOrderId: 'co_missing', filename: 'x.stl',
        mime: 'model/stl', sizeBytes: 1, storageKey: 'a'.repeat(32),
      });
      await expect(service.streamArtifact('art_orphan', mockRes())).rejects.toThrow(/not found/i);
    });

    it('does not leak one order\'s artifacts through another order\'s listing', async () => {
      const a = await service.createOrder('cust_A', { generatorKey: 'nameplate', params: validParams });
      const b = await service.createOrder('cust_B', { generatorKey: 'nameplate', params: { ...validParams, width: 60 } });

      const listA = await service.getForOrder(a.orderId);
      const listB = await service.getForOrder(b.orderId);

      const idsA = listA.flatMap((c: any) => c.artifacts.map((x: any) => x.id));
      const idsB = listB.flatMap((c: any) => c.artifacts.map((x: any) => x.id));
      expect(idsA.length).toBe(2);
      expect(idsB.length).toBe(2);
      // Disjoint — customer A's artifacts never appear under order B
      expect(idsA.some((id: string) => idsB.includes(id))).toBe(false);
    });

    it('never exposes raw file bytes or the storage key in the order listing', async () => {
      const r = await service.createOrder('cust_1', { generatorKey: 'nameplate', params: validParams });
      const list = await service.getForOrder(r.orderId);
      const serialized = JSON.stringify(list);
      expect(serialized).not.toMatch(/storageKey/);
      expect(serialized).not.toMatch(/body/);
      // Metadata is present
      expect(list[0].artifacts[0].filename).toBeTruthy();
      expect(list[0].artifacts[0].sizeBytes).toBeGreaterThan(0);
    });

    it('sets a safe Content-Disposition (no path, no injection) on download', async () => {
      const r = await service.createOrder('cust_1', {
        generatorKey: 'nameplate',
        params: { ...validParams, label: 'a"; rm -rf /' },
      });
      const list = await service.getForOrder(r.orderId);
      const artifactId = list[0].artifacts[0].id;
      const res = mockRes();
      await service.streamArtifact(artifactId, res);
      const cd = res.headers['Content-Disposition'];
      expect(cd).toMatch(/^attachment; filename="[a-zA-Z0-9._-]+"$/);
      expect(cd).not.toContain('/');
      expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    });
  });

  // ---- §8 retention ----
  describe('§8 artifact retention', () => {
    it('is a no-op when nothing is expired', async () => {
      const res = await service.cleanupExpiredArtifacts(90);
      expect(res.removed).toBe(0);
    });
  });
});
