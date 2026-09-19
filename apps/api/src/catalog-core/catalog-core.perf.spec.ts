/**
 * §7.1 item 43: pure / mocked-Prisma timings. Median of 5 runs after one warm-up;
 * each budget is 3× the expected time so CI noise can't flake.
 */
import { BomResolverService } from './bom-resolver.service';
import { CatalogRequestContext } from './catalog-context';
import { costEngine } from './cost-engine';
import { PricingService } from './pricing.service';
import { ProductionPlannerService } from './production-planner.service';
import { SETTINGS } from './__fixtures__/box-product';
import { plannerPrisma, type FakeOrder } from './__fixtures__/planner-prisma';
import { fixtureComponent, resolverPrisma, sardineRow, type FixtureRow } from './__fixtures__/sardine-tin';

const PID = 'p-big';

function material(i: number) {
  return { id: `m${i}`, name: `PLA ${i}`, type: 'PLA', color: null, colorHex: null, brand: null, costPerGram: 0.01 + i / 10000 };
}

/** 31 sizes (standard + 30) × 31 colours (standard + 30), 9 components per size with ×500 / ×7 / single. */
function bigRow(): FixtureRow {
  const row = sardineRow();
  row.id = PID;
  row.colourSlots = [{ id: 'body', productId: PID, name: 'Body', sortOrder: 0 }, { id: 'trim', productId: PID, name: 'Trim', sortOrder: 1 }];
  const sizes = Array.from({ length: 30 }, (_, i) => ({
    id: `s${i}`, productId: PID, name: `Size ${i}`, sku: null, kind: 'SIZE', isActive: true, sortOrder: i, basePrice: 3, estimatedGrams: null, estimatedMinutes: null, createdAt: new Date(0), colourAssignments: [], sizeExclusions: [],
  }));
  const colours = Array.from({ length: 30 }, (_, i) => ({
    id: `k${i}`, productId: PID, name: `Colour ${i}`, sku: null, kind: 'COLOUR', isActive: true, sortOrder: i, basePrice: null, estimatedGrams: null, estimatedMinutes: null, createdAt: new Date(0),
    colourAssignments: [
      { colourSlotId: 'body', materialId: `m${100 + i}`, material: material(100 + i) },
      { colourSlotId: 'trim', materialId: `m${200 + i}`, material: material(200 + i) },
    ],
    sizeExclusions: [],
  }));
  row.variants = [...sizes, ...colours];
  row.components = [];
  for (const size of [null, ...sizes.map((s) => s.id)]) {
    for (let c = 0; c < 9; c++) {
      const id = `${size ?? 'std'}-c${c}`;
      const comp = fixtureComponent(id, size, `Part ${c}`, 1 + (c % 3), c, 10 + c,
        c % 2 ? [[0, 'm1', 3, 'body']] : [[0, 'm1', 2, 'body'], [1, 'm2', 0.5, 'trim']],
        [{ id: `${id}-500`, units: 500, minutes: 3000, grams: 1250 }, { id: `${id}-7`, units: 7, minutes: 60, grams: 17.5 }]);
      comp.productId = PID;
      comp.material = comp.materialId ? material(1) : null;
      for (const m of comp.materials) m.material = material(Number(m.materialId.slice(1)));
      row.components.push(comp);
    }
  }
  return row;
}

async function median(fn: () => Promise<unknown> | unknown): Promise<number> {
  await fn();
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  return times.sort((a, b) => a - b)[2];
}

describe('catalog-core performance (§7.1 item 43)', () => {
  const pricing = () => {
    const prisma: any = resolverPrisma([bigRow()], { priceTier: { findMany: jest.fn(async () => []) }, variantPriceTier: { findMany: jest.fn(async () => []) } });
    const svc = new PricingService(prisma, new BomResolverService(prisma), { loadSettings: async () => ({ ...SETTINGS }) } as any);
    return { prisma, svc };
  };

  it('cellCosts over 31 sizes × 31 colours × 9 components: < 150 ms, one product load', async () => {
    const { prisma, svc } = pricing();
    let cells = 0;
    const ms = await median(async () => {
      prisma.product.findUnique.mockClear();
      const r = await svc.cellCosts(PID, new CatalogRequestContext());
      cells = r.cells.length;
      expect(prisma.product.findUnique).toHaveBeenCalledTimes(1);
    });
    expect(cells).toBe(961);
    expect(ms).toBeLessThan(150);
  });

  it('bulkFloor at the caps (20 bands × 600 points, 9 components, 31 colours): < 1 s; quantityBasis once per N; one planner table per layout set', async () => {
    const { svc } = pricing();
    const minQtys = Array.from({ length: 20 }, (_, i) => 1 + i * 1000);
    let basisCalls = 0;
    let tables = 0;
    const ms = await median(async () => {
      const spy = jest.spyOn(costEngine, 'quantityBasis');
      const ctx = new CatalogRequestContext();
      await svc.bulkFloor(PID, null, minQtys, ctx);
      basisCalls = spy.mock.calls.length;
      tables = ctx.planCache.tablesBuilt;
      spy.mockRestore();
    });
    expect(basisCalls).toBe(20 * 600);
    expect(tables).toBe(1); // every component has the same {500, 7, 1} layout set
    expect(ms).toBeLessThan(1000);
  });

  it('freeFilament over 50 open orders × 3 lines (20 distinct pairs): one resolution per pair, < 100 ms', async () => {
    const row = bigRow();
    const pairs: Array<[string | null, string | null]> = [];
    for (const s of [null, 's0']) for (let k = 0; k < 10; k++) pairs.push([s, k === 0 ? null : `k${k}`]);
    const orders: FakeOrder[] = Array.from({ length: 50 }, (_, o) => ({
      id: `o${o}`, orderNumber: `ORD-${o}`, status: 'CONFIRMED',
      items: [0, 1, 2].map((l) => {
        const [s, c] = pairs[(o * 3 + l) % pairs.length];
        return { id: `oi-${o}-${l}`, productId: PID, sizeOptionId: s, colourOptionId: c, quantity: 10 + l, description: 'x' };
      }),
    }));
    const prisma = plannerPrisma({ rows: [row], orders });
    const resolver = new BomResolverService(prisma);
    const planner = new ProductionPlannerService(prisma, resolver);
    let resolutions = 0;
    const ms = await median(async () => {
      const spy = jest.spyOn(resolver, 'resolveWithConfig');
      await planner.freeFilament(['m1', 'm2'], { ctx: new CatalogRequestContext() });
      resolutions = spy.mock.calls.length;
      spy.mockRestore();
    });
    expect(resolutions).toBe(20);
    expect(ms).toBeLessThan(100);
  });
});
