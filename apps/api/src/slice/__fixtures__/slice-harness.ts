/**
 * Wires SliceService and SliceProcessor over the products in-memory database
 * (the sardine tin) with a stubbed sidecar and profile store, a temp
 * UPLOAD_DIR, and a part's source model seeded on disk. Used by the slice specs.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { M, sardineRow } from '../../catalog-core/__fixtures__/sardine-tin';
import { GcodeParserService } from '../../file-parser/gcode-parser.service';
import { StlEstimatorService } from '../../file-parser/stl-estimator.service';
import { productsHarness } from '../../products/__fixtures__/products-harness';
import { PlateFilesService } from '../../products/plate-files.service';
import { PlateLayoutsService } from '../../products/plate-layouts.service';
import type { SourceMeta } from '../../products/product-sources';
import { writeUploadFile } from '../../products/slicer-files';
import type { SidecarSliceResult } from '../sidecar-slice.client';
import { SliceProcessor } from '../slice.processor';
import { SliceService } from '../slice.service';

export const P = 'p-sardine';
export const K1 = 'pr-1';
export const HI = 'pr-hi';
export { M };

/** A binary STL of two triangles spanning 20 × 20 × 5 mm. */
export function stl(x = 20, y = 20, z = 5): Buffer {
  const tris: number[][][] = [
    [[0, 0, 0], [x, 0, 0], [x, y, 0]],
    [[0, 0, 0], [x, y, 0], [0, y, z]],
  ];
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write('PrintForge test solid', 0, 'ascii');
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const t of tris) {
    for (let i = 0; i < 3; i++) { buf.writeFloatLE(0, o); o += 4; }
    for (const v of t) for (const c of v) { buf.writeFloatLE(c, o); o += 4; }
    buf.writeUInt16LE(0, o); o += 2;
  }
  return buf;
}

export const MACHINE = { name: 'Creality K1 0.4 nozzle', printable_area: ['0x0', '220x0', '220x220', '0x220'] };
export const PROCESS = { name: '0.20mm Standard' };
export const FIL_PLA = { name: 'Generic PLA' };
export const FIL_PETG = { name: 'Generic PETG' };

export function profilesStub() {
  const machines = new Map<string, any>();
  const processes = new Map<string, any>();
  const filaments = new Map<string, any>();
  return {
    machines, processes, filaments,
    machineFor: jest.fn(async (id: string) => machines.get(id) ?? null),
    defaultProcessFor: jest.fn(async (id: string) => processes.get(id) ?? null),
    filamentFor: jest.fn(async (id: string) => filaments.get(id) ?? null),
  };
}

export function sliceHarness() {
  const h = productsHarness([sardineRow()]);
  const k1 = h.db.t('printer').find((p: any) => p.id === K1);
  Object.assign(k1, { model: 'Creality K1', isActive: true });
  h.db.insert('printer', { id: HI, name: 'Hi', model: 'Creality Hi', isActive: true });
  const profiles = profilesStub();
  profiles.machines.set(K1, MACHINE);
  profiles.processes.set(K1, PROCESS);
  profiles.machines.set(HI, { ...MACHINE, name: 'Creality Hi 0.4 nozzle' });
  profiles.processes.set(HI, PROCESS);
  for (const id of Object.values(M)) profiles.filaments.set(id, FIL_PLA);
  const sidecar = { slice: jest.fn<Promise<SidecarSliceResult>, [any]>(async () => ({ ok: false, code: 'SLICER_UNAVAILABLE', message: 'no stub', exitCode: null, logTail: '' })) };
  const parser = new GcodeParserService();
  const layouts = new PlateLayoutsService(h.db as any, parser, {} as any, h.pricing);
  const plateFiles = new PlateFilesService(h.db as any, parser, {} as any, h.pricing);
  const gateway = { server: { emit: jest.fn() } };
  const service = new SliceService(h.db as any, profiles as any, new StlEstimatorService());
  const processor = new SliceProcessor(h.db as any, sidecar as any, parser, profiles as any, layouts, plateFiles, h.components, gateway as any);
  // The claim query over the in-memory table: oldest QUEUED → RUNNING, one at a time.
  h.db.$queryRaw.mockImplementation(async () => {
    const next = h.db.t('sliceRun').filter((r: any) => r.status === 'QUEUED').sort((a: any, b: any) => +new Date(a.createdAt) - +new Date(b.createdAt))[0];
    if (!next) return [];
    next.status = 'RUNNING';
    next.startedAt = new Date();
    return [{ id: next.id }];
  });

  /** Puts a source model on a part: the file on disk, its Attachment, the component columns. */
  async function seedSource(componentId: string, kind: 'STL' | 'THREEMF', buffer: Buffer = stl(), meta: SourceMeta = { printerModel: null, printerId: null, slots: [] }) {
    const stored = await writeUploadFile(buffer, kind === 'STL' ? 'stl' : '3mf');
    const att = h.db.insert('attachment', {
      entityType: 'product', entityId: P, filename: stored.filename, originalName: kind === 'STL' ? 'box.stl' : 'box.3mf',
      mimeType: kind === 'STL' ? 'model/stl' : 'model/3mf', sizeBytes: stored.sizeBytes, storagePath: stored.storagePath, parsedMetadata: meta,
    });
    const c = h.db.t('productComponent').find((x: any) => x.id === componentId);
    c.sourceAttachmentId = att.id;
    c.sourceKind = kind;
    return att;
  }

  const run = (id: string) => h.db.t('sliceRun').find((r: any) => r.id === id);
  return { h, db: h.db, profiles, sidecar, gateway, service, processor, seedSource, run };
}

export type SliceHarness = ReturnType<typeof sliceHarness>;

let dir: string;
const prevDir = process.env.UPLOAD_DIR;
/** Call once per spec file: a temp UPLOAD_DIR per test. */
export function useTempUploadDir() {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-slice-'));
    process.env.UPLOAD_DIR = dir;
  });
  afterEach(() => {
    process.env.UPLOAD_DIR = prevDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return () => dir;
}

export const statusOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e: any) {
    return typeof e?.getStatus === 'function' ? e.getStatus() : 500;
  }
};
