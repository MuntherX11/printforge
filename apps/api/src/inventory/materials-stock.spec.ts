import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { PrismaService } from '../common/prisma/prisma.service';
import { MaterialsController } from './materials.controller';
import { MaterialsService } from './materials.service';
import { stockStatus } from './stock-status';

/** A material row as `material.findMany({ select })` returns it in stockOverview. */
interface MaterialRow {
  id: string;
  name: string;
  type: string;
  color: string | null;
  colorHex: string | null;
  brand: string | null;
  costPerGram: number;
  spoolPrice: number | null;
  spoolWeightGrams: number | null;
  reorderPoint: number;
  createdAt: Date;
}

/** A spool row as `spool.findMany({ select })` returns it in stockOverview. */
interface SpoolRow {
  id: string;
  materialId: string;
  printforgeId: string | null;
  currentWeight: number;
  isActive: boolean;
  createdAt: Date;
  location: { name: string } | null;
}

const material = (id: string, extra: Partial<MaterialRow> = {}): MaterialRow => ({
  id,
  name: `PLA ${id}`,
  type: 'PLA',
  color: 'Red',
  colorHex: '91202B',
  brand: 'eSUN',
  costPerGram: 0.009,
  spoolPrice: 9,
  spoolWeightGrams: 1000,
  reorderPoint: 500,
  createdAt: new Date('2026-09-01T10:00:00.000Z'),
  ...extra,
});

let spoolSeq = 0;
const spool = (materialId: string, currentWeight: number, extra: Partial<SpoolRow> = {}): SpoolRow => {
  spoolSeq++;
  return {
    id: `s${spoolSeq}`,
    materialId,
    printforgeId: `PF-${String(spoolSeq).padStart(4, '0')}`,
    currentWeight,
    isActive: true,
    createdAt: new Date(Date.UTC(2026, 8, 28 - spoolSeq)),
    location: null,
    ...extra,
  };
};

/** jest.fn Prisma double: only the delegates stockOverview touches. */
function prismaMock(materials: MaterialRow[], spools: SpoolRow[] = [], total = materials.length) {
  const prisma = {
    material: {
      findMany: jest.fn(async (_args: unknown) => materials),
      count: jest.fn(async () => total),
    },
    spool: {
      findMany: jest.fn(async (_args: unknown) => spools),
    },
  };
  return { prisma, svc: new MaterialsService(prisma as unknown as PrismaService) };
}

const ROW_KEYS = [
  'activeSpools', 'brand', 'color', 'colorHex', 'costPerGram', 'createdAt', 'id', 'name', 'reorderPoint',
  'spoolPrice', 'spoolWeightGrams', 'spools', 'stockStatus', 'totalStock', 'type',
];
const SPOOL_KEYS = ['currentWeight', 'id', 'isActive', 'locationName', 'printforgeId'];

describe('stockStatus', () => {
  it.each([
    [0, 500, 'out'],
    [-5, 500, 'out'],
    [100, 500, 'low'],
    [499.9, 500, 'low'],
    [500, 500, 'ok'],
    [900, 500, 'ok'],
    [0, 0, 'ok'],
  ])('%p g against a %p g reorder point → %p', (grams, reorderPoint, expected) => {
    expect(stockStatus(grams, reorderPoint)).toBe(expected);
  });

  it('is not ok exactly when grams < reorder point (the dashboard KPI and low-stock worker rule)', () => {
    for (const g of [-1, 0, 1, 250, 499, 500, 501, 5000]) {
      for (const rp of [0, 1, 500, 1000]) {
        expect(stockStatus(g, rp) !== 'ok').toBe(g < rp);
      }
    }
  });
});

describe('MaterialsService.stockOverview', () => {
  it('totals and counts active spools only; spools[] also lists the inactive one', async () => {
    const a = material('A');
    const { svc } = prismaMock([a], [
      spool('A', 400),
      spool('A', 300),
      spool('A', 900, { isActive: false }),
    ]);
    const [row] = await svc.stockOverview();
    expect(row.totalStock).toBe(700);
    expect(row.activeSpools).toBe(2);
    expect(row.stockStatus).toBe('ok');
    expect(row.spools).toHaveLength(3);
    expect(row.spools.filter((s) => !s.isActive)).toEqual([
      expect.objectContaining({ currentWeight: 900, isActive: false }),
    ]);
  });

  it('a filament with no spools is out below a 500 g reorder point, and ok at reorder point 0', async () => {
    const { svc } = prismaMock([material('A', { reorderPoint: 500 }), material('B', { reorderPoint: 0 })]);
    const [a, b] = await svc.stockOverview();
    expect(a).toEqual(expect.objectContaining({ totalStock: 0, activeSpools: 0, stockStatus: 'out', spools: [] }));
    expect(b).toEqual(expect.objectContaining({ totalStock: 0, activeSpools: 0, stockStatus: 'ok', spools: [] }));
  });

  it('only inactive grams → out: a retired spool never keeps a filament in stock', async () => {
    const { svc } = prismaMock([material('A')], [spool('A', 900, { isActive: false })]);
    const [row] = await svc.stockOverview();
    expect(row).toEqual(expect.objectContaining({ totalStock: 0, activeSpools: 0, stockStatus: 'out' }));
    expect(row.spools).toHaveLength(1);
  });

  it('locationName is null without a location and the name otherwise; spools carry only the five fields', async () => {
    const { svc } = prismaMock([material('A')], [
      spool('A', 640, { printforgeId: 'PF-A7X2', location: { name: 'Shelf B' } }),
      spool('A', 120, { printforgeId: 'PF-B8Y3', location: null }),
    ]);
    const [row] = await svc.stockOverview();
    expect(row.spools.map((s) => [s.printforgeId, s.locationName])).toEqual([
      ['PF-A7X2', 'Shelf B'],
      ['PF-B8Y3', null],
    ]);
    for (const s of row.spools) expect(Object.keys(s).sort()).toEqual(SPOOL_KEYS);
  });

  it('rows carry exactly the FilamentStockRow fields; colorHex stays bare and createdAt is ISO', async () => {
    const { svc } = prismaMock(
      [material('A', { colorHex: '91202B', color: null, brand: null, spoolPrice: null, spoolWeightGrams: null })],
      [spool('A', 250)],
    );
    const [row] = await svc.stockOverview();
    expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
    expect(row).toEqual({
      id: 'A',
      name: 'PLA A',
      type: 'PLA',
      color: null,
      colorHex: '91202B',
      brand: null,
      costPerGram: 0.009,
      spoolPrice: null,
      spoolWeightGrams: null,
      reorderPoint: 500,
      createdAt: '2026-09-01T10:00:00.000Z',
      totalStock: 250,
      activeSpools: 1,
      stockStatus: 'low',
      spools: [expect.objectContaining({ currentWeight: 250, isActive: true, locationName: null })],
    });
  });

  it('keeps grams unrounded and each filament gets only its own spools, in query order', async () => {
    const { svc } = prismaMock([material('A'), material('B')], [
      spool('B', 0.4, { id: 'b1' }),
      spool('A', 333.3, { id: 'a1' }),
      spool('A', 166.65, { id: 'a2' }),
      spool('B', 10, { id: 'b2', isActive: false }),
    ]);
    const [a, b] = await svc.stockOverview();
    expect(a.spools.map((s) => s.id)).toEqual(['a1', 'a2']);
    expect(a.totalStock).toBeCloseTo(499.95, 10);
    expect(a.stockStatus).toBe('low');
    expect(b.spools.map((s) => s.id)).toEqual(['b1', 'b2']);
    expect(b.totalStock).toBe(0.4);
  });

  it('runs exactly one material.findMany and one spool.findMany, however many filaments (no N+1)', async () => {
    const materials = Array.from({ length: 50 }, (_, i) => material(`M${i}`));
    const spools = materials.flatMap((m) => [spool(m.id, 100), spool(m.id, 200, { isActive: false })]);
    const { prisma, svc } = prismaMock(materials, spools);
    const rows = await svc.stockOverview();
    expect(rows).toHaveLength(50);
    expect(prisma.material.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.spool.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.material.count).not.toHaveBeenCalled();
  });

  it('queries name A–Z with no row cap, and spools active first then newest first', async () => {
    const { prisma, svc } = prismaMock([]);
    await svc.stockOverview();
    expect(prisma.material.findMany).toHaveBeenCalledWith({
      select: {
        id: true, name: true, type: true, color: true, colorHex: true, brand: true, costPerGram: true,
        spoolPrice: true, spoolWeightGrams: true, reorderPoint: true, createdAt: true,
      },
      orderBy: { name: 'asc' },
    });
    expect(prisma.spool.findMany).toHaveBeenCalledWith({
      select: {
        id: true, materialId: true, printforgeId: true, currentWeight: true, isActive: true, createdAt: true,
        location: { select: { name: true } },
      },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    });
  });

  it('the count of rows not ok equals the dashboard KPI formula over the same data', async () => {
    const materials = [
      material('A', { reorderPoint: 500 }),
      material('B', { reorderPoint: 500 }),
      material('C', { reorderPoint: 0 }),
      material('D', { reorderPoint: 1000 }),
      material('E', { reorderPoint: 200 }),
    ];
    const spools = [
      spool('A', 499),
      spool('B', 300), spool('B', 200),
      spool('D', 2000, { isActive: false }), spool('D', 999),
      spool('E', 0),
    ];
    const { svc } = prismaMock(materials, spools);
    const rows = await svc.stockOverview();
    // reports.service.ts: active-spool grams grouped per material, then `grams < reorderPoint`.
    const stockMap = new Map<string, number>();
    for (const s of spools.filter((x) => x.isActive)) stockMap.set(s.materialId, (stockMap.get(s.materialId) ?? 0) + s.currentWeight);
    const kpi = materials.filter((m) => (stockMap.get(m.id) ?? 0) < m.reorderPoint).length;
    expect(rows.filter((r) => r.stockStatus !== 'ok').length).toBe(kpi);
    expect(kpi).toBe(3);
  });
});

describe('MaterialsController', () => {
  const serviceMock = () => ({
    stockOverview: jest.fn(async () => []),
  });
  const controllerWith = (svc: ReturnType<typeof serviceMock>) =>
    new MaterialsController(svc as unknown as MaterialsService);

  it('GET stock is staff-only on top of the class JwtAuthGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, MaterialsController.prototype.stock)).toContain(StaffGuard);
    expect(Reflect.getMetadata(GUARDS_METADATA, MaterialsController)).toContain(JwtAuthGuard);
  });

  it("GET stock is a GET on 'stock', declared before ':id' so it never reaches findOne", () => {
    const proto = MaterialsController.prototype;
    expect(Reflect.getMetadata(PATH_METADATA, proto.stock)).toBe('stock');
    expect(Reflect.getMetadata(METHOD_METADATA, proto.stock)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, proto.findOne)).toBe(':id');
    const names = Object.getOwnPropertyNames(proto);
    expect(names.indexOf('stock')).toBeGreaterThan(-1);
    expect(names.indexOf('stock')).toBeLessThan(names.indexOf('findOne'));
  });

  it('stock() returns the service overview', async () => {
    const svc = serviceMock();
    await controllerWith(svc).stock();
    expect(svc.stockOverview).toHaveBeenCalledTimes(1);
  });
});

