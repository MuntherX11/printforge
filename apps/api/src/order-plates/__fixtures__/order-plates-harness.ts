/**
 * Wires the order-plates services over the production specs' in-memory
 * database, with a stubbed slicer container and profile store, a temp
 * UPLOAD_DIR and one product, "Doll", that has a part of every kind:
 *
 *   dress  STL, PLA Black, 60 x 40 mm          → MIX
 *   hat    STL, PLA Black, 30 x 30 mm          → MIX
 *   shoe   STL, PLA White, 20 x 20 mm          → MIX (another filament)
 *   badge  one-slot project, PLA Black         → MIX, can print alone with its own settings
 *   face   two-colour project for the Hi       → PROJECT, locked to the Hi
 *   stand  no model, a ×10 plate with a file   → LAYOUT
 *
 * Printers: K1 (pr-1) and Hi (pr-hi) can slice models; "Old" has no profile.
 */
import { fixtureComponent, M, type FixtureRow } from '../../catalog-core/__fixtures__/sardine-tin';
import { GcodeParserService } from '../../file-parser/gcode-parser.service';
import { StlEstimatorService } from '../../file-parser/stl-estimator.service';
import { addOrder, addSpool, productionHarness } from '../../production/__fixtures__/production-harness';
import { JobSiblingsService } from '../../production/job-siblings';
import { gcode } from '../../products/__fixtures__/slicer-files';
import { writeUploadFile } from '../../products/slicer-files';
import { FIL_PLA, MACHINE, PROCESS, profilesStub, stl } from '../../slice/__fixtures__/slice-harness';
import type { SidecarSliceResult } from '../../slice/sidecar-slice.client';
import { SliceProcessor } from '../../slice/slice.processor';
import { OrderNeedsService } from '../order-needs.service';
import { OrderPlateJobsService } from '../order-plate-jobs.service';
import { OrderPlateSlicer } from '../order-plate-slicer';
import { OrderPlatesService } from '../order-plates.service';

export const DOLL = 'p-doll';
export const K1 = 'pr-1';
export const HI = 'pr-hi';
export const OLD = 'pr-old';
export { M };

export function dollRow(): FixtureRow {
  const part = (id: string, sortOrder: number, minutes: number, slots: any[], layouts: any[] = [], extra: Record<string, unknown> = {}) => {
    const c = fixtureComponent(id, null, id, 1, sortOrder, minutes, slots, layouts, extra);
    c.productId = DOLL;
    return c;
  };
  return {
    id: DOLL, name: 'Doll', isActive: true, basePrice: 5, colorChanges: 0, baseOptionLabel: null, baseOptionSellable: null,
    standardColourLabel: null, standardColourSellable: null, surplusPolicy: 'KEEP_FOR_STOCK', defaultPrinterId: K1,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    defaultPrinter: { id: K1, name: 'K1', hourlyRate: 0.4, wattage: 200, markupMultiplier: 2.5 },
    colourSlots: [], variants: [], parts: [],
    components: [
      part('dress', 0, 30, [[0, M.black, 6, 'fixed']]),
      part('hat', 1, 10, [[0, M.black, 2, 'fixed']]),
      part('shoe', 2, 5, [[0, M.white, 1, 'fixed']]),
      part('badge', 3, 8, [[0, M.black, 1.5, 'fixed']]),
      part('face', 4, 20, [[0, M.white, 3, 'fixed'], [1, M.orange, 1, 'fixed']]),
      part('stand', 5, 12, [[0, M.black, 4, 'fixed']], [{ id: 'stand10', units: 10, minutes: 100, grams: 38 }]),
    ],
  };
}

/** A sliced plate as the slicer container answers it: labels named after its inputs, with real outlines. */
export function mixedGcode(units: number[], o: { minutes?: number; grams?: number; toolGrams?: number[]; name?: (k: number, n: number) => string } = {}): Buffer {
  const names: string[] = [];
  units.forEach((u, k) => {
    for (let n = 1; n <= u; n++) names.push(o.name ? o.name(k, n) : `_scratch_in${k}_0.stl${u > 1 ? `_${n}` : ''}`);
  });
  const text = gcode({ labels: names, minutes: o.minutes ?? 120, totalGrams: o.grams ?? 60, toolGrams: o.toolGrams ?? [o.grams ?? 60], types: ['PLA'] }).toString('utf-8');
  // The fixture's defines carry a two-point polygon; give each object a square of its own.
  let i = 0;
  const squared = text.replace(/POLYGON=\[\[0,0\],\[1,1\]\]/g, () => {
    const x = 10 + (i++) * 12;
    return `POLYGON=[[${x},10],[${x + 10},10],[${x + 10},20],[${x},20]]`;
  });
  return Buffer.from(`${squared}; printable_area = 0x0,220x0,220x220,0x220\n`);
}

export function orderPlatesHarness(mutate?: (row: FixtureRow) => void) {
  const row = dollRow();
  mutate?.(row);
  const h = productionHarness([row]);
  const db = h.db;
  Object.assign(db.t('printer').find((p: any) => p.id === K1), { model: 'Creality K1', isActive: true });
  db.insert('printer', { id: HI, name: 'Hi', model: 'Creality Hi', isActive: true });
  db.insert('printer', { id: OLD, name: 'Old', model: 'Prusa MK2', isActive: true });
  for (const m of [M.black, M.white, M.orange]) addSpool(db, m, 5000, { id: `sp-${m}` });

  const profiles = profilesStub();
  profiles.machines.set(K1, MACHINE);
  profiles.processes.set(K1, PROCESS);
  profiles.machines.set(HI, { ...MACHINE, name: 'Creality Hi 0.4 nozzle', printable_area: ['0x0', '260x0', '260x260', '0x260'] });
  profiles.processes.set(HI, PROCESS);
  for (const id of Object.values(M)) profiles.filaments.set(id, FIL_PLA);

  const sidecar = { slice: jest.fn<Promise<SidecarSliceResult>, [any]>(async () => ({ ok: false, code: 'SLICER_UNAVAILABLE', message: 'The slicer container is unreachable', exitCode: null, logTail: '' })) };
  const health = { health: jest.fn(async () => ({ reachable: true, orcaVersion: '2.4.2' })) };
  const gateway = { server: { emit: jest.fn() }, broadcastNotification: jest.fn() };
  const parser = new GcodeParserService();
  const stlReader = new StlEstimatorService();
  const needs = new OrderNeedsService(db as any, h.planning, profiles as any, stlReader, health as any);
  const plates = new OrderPlatesService(db as any, needs, gateway as any);
  const processor = new SliceProcessor(db as any, sidecar as any, parser, profiles as any, {} as any, {} as any, gateway as any);
  const slicer = new OrderPlateSlicer(db as any, needs, sidecar as any, parser, profiles as any, processor, gateway as any);
  const jobs = new OrderPlateJobsService(db as any, needs, h.resolver, h.planner, h.stock);
  const siblings = new JobSiblingsService(db as any, h.jobs);

  // The two claim statements of the shared tick, over the in-memory tables.
  const inner = db.$queryRaw;
  db.$queryRaw = jest.fn(async (sql: any) => {
    const text: string = sql?.sql ?? sql?.strings?.join('') ?? '';
    const table = /UPDATE "OrderPlate"/.test(text) ? 'orderPlate' : /UPDATE "SliceRun"/.test(text) ? 'sliceRun' : null;
    if (!table) return inner(sql);
    // A run waits since it was created, a plate since it was queued.
    const since = (r: any) => +new Date((table === 'orderPlate' ? r.queuedAt : null) ?? r.createdAt);
    const next = db.t(table).filter((r: any) => r.status === 'QUEUED').sort((a: any, b: any) => since(a) - since(b))[0];
    if (!next) return [];
    Object.assign(next, { status: 'RUNNING', startedAt: new Date() });
    return [{ id: next.id }];
  });

  /** A file on disk with its Attachment row. */
  async function addFile(buffer: Buffer, ext: 'stl' | '3mf' | 'gcode', extra: Record<string, unknown> = {}) {
    const stored = await writeUploadFile(buffer, ext);
    return db.insert('attachment', {
      entityType: 'product', entityId: DOLL, filename: stored.filename, originalName: `model.${ext}`, mimeType: 'application/octet-stream',
      sizeBytes: stored.sizeBytes, storagePath: stored.storagePath, parsedMetadata: null, ...extra,
    });
  }
  const comp = (id: string) => db.t('productComponent').find((c: any) => c.id === id);

  /** The models and files the parts print from (call once per test, after the temp dir exists). */
  async function seedFiles() {
    const source = async (id: string, kind: 'STL' | 'THREEMF', buffer: Buffer, meta: unknown = null) => {
      const att = await addFile(buffer, kind === 'STL' ? 'stl' : '3mf', { parsedMetadata: meta });
      Object.assign(comp(id), { sourceAttachmentId: att.id, sourceKind: kind });
      return att;
    };
    await source('dress', 'STL', stl(60, 40, 5));
    await source('hat', 'STL', stl(30, 30, 5));
    await source('shoe', 'STL', stl(20, 20, 5));
    await source('badge', 'THREEMF', stl(), { printerModel: 'Creality Hi', printerId: HI, slots: [{ colorIndex: 0, profile: null, colorHex: null, materialId: M.black }] });
    await source('face', 'THREEMF', stl(), {
      printerModel: 'Creality Hi', printerId: HI,
      slots: [{ colorIndex: 0, profile: null, colorHex: null, materialId: M.white }, { colorIndex: 1, profile: null, colorHex: null, materialId: M.orange }],
    });
    // The face's own sliced x1 file: one 50 x 50 mm object.
    const x1 = Buffer.from('EXCLUDE_OBJECT_DEFINE NAME=face CENTER=50,50 POLYGON=[[25,25],[75,25],[75,75],[25,75]]\nG28\n; printable_area = 0x0,260x0,260x260,0x260\n');
    comp('face').attachmentId = (await addFile(x1, 'gcode')).id;
    const standFile = await addFile(mixedGcode([10], { name: (_k, n) => `stand_id_${n}_copy_0` }), 'gcode');
    Object.assign(db.t('plateLayout').find((l: any) => l.id === 'stand10'), { attachmentId: standFile.id, gcodeFilename: 'stand x10.gcode' });
  }

  /** An order of `quantity` dolls. */
  function order(quantity = 6, status = 'CONFIRMED') {
    const o = addOrder(db, [{ productId: DOLL, quantity, description: 'Doll' }], status);
    return { id: o.order.id as string, itemId: o.items[0].id as string, number: o.order.orderNumber as string, key: (part: string) => `${o.items[0].id}:${part}` };
  }

  const plate = (id: string) => db.t('orderPlate').find((p: any) => p.id === id);
  const platesOf = (orderId: string) => db.t('orderPlate').filter((p: any) => p.orderId === orderId).sort((a: any, b: any) => a.sortOrder - b.sortOrder);
  const ok = (buffer: Buffer, inputUnits?: number[] | null) => sidecar.slice.mockResolvedValue({ ok: true, gcode: buffer, plateFiles: 1, inputUnits });

  return { h, db, profiles, sidecar, health, gateway, stlReader, needs, plates, processor, slicer, jobs, siblings, seedFiles, addFile, comp, order, plate, platesOf, ok };
}

export type OrderPlatesHarness = ReturnType<typeof orderPlatesHarness>;
