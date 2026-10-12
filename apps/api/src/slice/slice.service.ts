import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { fillPlateEstimate, printableAreaSize, SliceErrorCode, type SliceFilamentMap, type SliceRunDto, type SlotKey } from '@printforge/types';
import * as fs from 'fs/promises';
import { PrismaService } from '../common/prisma/prisma.service';
import { readPlateFootprint } from '../file-parser/plate-footprint';
import { matchPrinter } from '../file-parser/printer-match';
import { StlEstimatorService } from '../file-parser/stl-estimator.service';
import { containedUploadPath } from '../products/product-images.service';
import { sourceMetaOf, type SourceMeta } from '../products/product-sources';
import { SlicerProfilesService } from '../slicer-profiles/slicer-profiles.service';
import { PROJECT_FILL_UNITS, pastFillUnits, projectFillUnits } from './fill-units';
import { parseSliceRequest } from './slice-request';

/**
 * Slice runs (slicer plan WP5): a staff member asks for N units of a part on a
 * printer with a filament per slot; the request is checked against the
 * part's source, the printer's machine (and, for an STL, default process)
 * profile and every slot's filament profile, then queued for the processor.
 * Error messages start with their SliceErrorCode so the UI can map them.
 *
 * A project (3MF) part is locked to the printer the project names and slices
 * with the project's own process (plan D14-A); an STL part takes the printer
 * asked for, else the product's pricing printer. "Fill the plate" is the
 * bounding-box estimate for an STL; for a project it is what an earlier run on
 * the printer showed fits plus 2, else an estimate from the footprint of the
 * part's sliced x1 file, else 100 (D12, fill-units.ts).
 */

export { PROJECT_FILL_UNITS };
export const RUN_LIST_LIMIT = 20;

export function filamentMapOf(json: unknown): SliceFilamentMap {
  const out: SliceFilamentMap = {};
  if (!json || typeof json !== 'object' || Array.isArray(json)) return out;
  for (const [k, v] of Object.entries(json as Record<string, any>)) {
    if (!/^[0-3]$/.test(k) || !v || typeof v !== 'object') continue;
    out[k as SlotKey] = { materialId: String(v.materialId ?? ''), name: String(v.name ?? ''), type: String(v.type ?? 'PLA') };
  }
  return out;
}

export function toRunDto(row: any): SliceRunDto {
  const iso = (d: unknown) => (d ? new Date(d as any).toISOString() : null);
  return {
    id: row.id,
    componentId: row.componentId,
    printerId: row.printerId ?? null,
    printerName: row.printer?.name ?? null,
    unitsRequested: row.unitsRequested,
    unitsSliced: row.unitsSliced ?? null,
    filamentMap: filamentMapOf(row.filamentMap),
    status: row.status,
    error: row.error ?? null,
    errorDetail: row.errorDetail ?? null,
    resultLayoutId: row.resultLayoutId ?? null,
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
  };
}

const sameMap = (a: SliceFilamentMap, b: SliceFilamentMap) => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k as SlotKey]?.materialId === b[k as SlotKey]?.materialId);
};

const RUN_INCLUDE = { printer: { select: { id: true, name: true } } };

@Injectable()
export class SliceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: SlicerProfilesService,
    private readonly stl: StlEstimatorService,
  ) {}

  private async owned(productId: string, componentId: string) {
    const c = await this.prisma.productComponent.findUnique({
      where: { id: componentId },
      include: { materials: { select: { colorIndex: true, materialId: true } }, product: { select: { id: true, defaultPrinterId: true } } },
    });
    if (!c || c.productId !== productId) throw new NotFoundException('Component not found');
    return c;
  }

  /**
   * Queue a run. `isValidation`: the 1-unit slice queued right after a source
   * upload, which falls back to the part's own filament per slot.
   */
  async create(productId: string, componentId: string, body: unknown, isValidation = false): Promise<SliceRunDto> {
    const input = parseSliceRequest(body);
    const comp = await this.owned(productId, componentId);
    if (!comp.sourceAttachmentId) throw new BadRequestException(`${SliceErrorCode.NO_SOURCE}: Upload the part's STL or project first`);
    const source = await this.prisma.attachment.findUnique({ where: { id: comp.sourceAttachmentId }, select: { id: true, storagePath: true, parsedMetadata: true, createdAt: true } });
    if (!source) throw new BadRequestException(`${SliceErrorCode.NO_SOURCE}: The part's source file is gone — upload it again`);
    const isProject = comp.sourceKind === 'THREEMF';
    const meta = sourceMetaOf(source.parsedMetadata);

    // A filament per slot: the one asked for, else the part's own (validation).
    const ownMaterial = (key: SlotKey): string | null => {
      if (isProject) return meta.slots.find((s) => String(s.colorIndex) === key)?.materialId ?? null;
      return comp.materialId ?? comp.materials.find((m: any) => m.colorIndex === 0)?.materialId ?? comp.materials[0]?.materialId ?? null;
    };
    const { printer, machine, filamentMap } = await this.preconditions({
      isProject, meta, printerId: input.printerId, defaultPrinterId: comp.product?.defaultPrinterId ?? null,
      materialFor: (key) => input.materials[key] ?? ownMaterial(key),
    });

    const units = input.fill ? await this.fillUnits(isProject, source, machine, componentId, printer.id, comp.attachmentId ?? null) : input.units!;

    const pending = await this.prisma.sliceRun.findMany({
      where: { componentId, printerId: printer.id, unitsRequested: units, status: { in: ['QUEUED', 'RUNNING'] } },
      select: { filamentMap: true },
    });
    if (pending.some((p) => sameMap(filamentMapOf(p.filamentMap), filamentMap))) {
      throw new ConflictException(`${SliceErrorCode.IDENTICAL_PENDING}: The same slice is already queued`);
    }

    const row = await this.prisma.sliceRun.create({
      data: { componentId, printerId: printer.id, unitsRequested: units, filamentMap: filamentMap as any, status: 'QUEUED' },
      include: RUN_INCLUDE,
    });
    return toRunDto(row);
  }

  /**
   * Everything a run needs besides the part row, in the order `create` reports
   * it: the printer (locked to the project's, else asked for, else the
   * product's) and that it is active, its machine profile, its default process
   * for an STL, and per slot a filament that exists and has a slicer preset (its
   * own, or the main preset of its type). Throws 400 with the SliceErrorCode.
   */
  private async preconditions(q: {
    isProject: boolean; meta: SourceMeta; printerId: string | null; defaultPrinterId: string | null; materialFor: (key: SlotKey) => string | null | undefined;
  }): Promise<{ printer: { id: string; name: string }; machine: Record<string, unknown>; filamentMap: SliceFilamentMap }> {
    const { isProject, meta } = q;
    const printers = await this.prisma.printer.findMany({ where: { isActive: true }, select: { id: true, name: true, model: true, isActive: true } });
    let printerId: string | null;
    if (isProject) {
      printerId = matchPrinter(meta.printerModel, printers)?.id ?? meta.printerId;
      if (!printerId) {
        throw new BadRequestException(`${SliceErrorCode.NO_MACHINE_PROFILE}: ${meta.printerModel ? `The project is set up for "${meta.printerModel}", which matches none of your printers` : 'The project does not name a printer'}`);
      }
    } else {
      printerId = q.printerId ?? q.defaultPrinterId ?? null;
      if (!printerId) throw new BadRequestException(`${SliceErrorCode.NO_MACHINE_PROFILE}: Choose a printer — the product has no pricing printer`);
    }
    const printer = printers.find((p) => p.id === printerId);
    if (!printer) throw new BadRequestException(`${SliceErrorCode.NO_MACHINE_PROFILE}: That printer is not active`);
    const machine = await this.profiles.machineFor(printer.id);
    if (!machine) throw new BadRequestException(`${SliceErrorCode.NO_MACHINE_PROFILE}: ${printer.name} has no machine profile — import one in Settings › Slicer`);
    if (!isProject && !(await this.profiles.defaultProcessFor(printer.id))) {
      throw new BadRequestException(`${SliceErrorCode.NO_PROCESS_PROFILE}: ${printer.name} has no default process profile — set one in Settings › Slicer`);
    }

    const slotKeys: SlotKey[] = isProject && meta.slots.length ? meta.slots.map((s) => String(s.colorIndex) as SlotKey) : ['0'];
    const wanted = slotKeys.map((key) => ({ key, materialId: q.materialFor(key) ?? null }));
    const missing = wanted.find((w) => !w.materialId);
    if (missing) throw new BadRequestException(`${SliceErrorCode.SLOT_UNMAPPED}: Slot ${Number(missing.key) + 1} has no filament`);
    const materials = await this.prisma.material.findMany({ where: { id: { in: wanted.map((w) => w.materialId!) } }, select: { id: true, name: true, type: true } });
    const filamentMap: SliceFilamentMap = {};
    for (const w of wanted) {
      const m = materials.find((x) => x.id === w.materialId);
      if (!m) throw new BadRequestException(`${SliceErrorCode.SLOT_UNMAPPED}: Slot ${Number(w.key) + 1} names a filament that no longer exists`);
      if (!(await this.profiles.filamentFor(m.id))) {
        throw new BadRequestException(`${SliceErrorCode.NO_FILAMENT_PROFILE}: "${m.name}" has no slicer preset, and there is no main preset for ${m.type}. Set one in Settings › Slicer`);
      }
      filamentMap[w.key] = { materialId: m.id, name: m.name, type: m.type };
    }
    return { printer: { id: printer.id, name: printer.name }, machine, filamentMap };
  }

  /**
   * The checks `create` makes for a 1-unit run, for a model that is not a part
   * yet (a part made from its model): nothing is read from a component row and
   * nothing is written. Throws the same 400s as `create`.
   */
  async assertSliceable(q: {
    kind: 'STL' | 'THREEMF'; meta: SourceMeta; printerId: string | null; defaultPrinterId: string | null; materials: Partial<Record<SlotKey, string>>;
  }): Promise<void> {
    await this.preconditions({
      isProject: q.kind === 'THREEMF', meta: q.meta, printerId: q.printerId, defaultPrinterId: q.defaultPrinterId, materialFor: (key) => q.materials[key] ?? null,
    });
  }

  /**
   * D12: copies from the STL's footprint and the machine's bed. A project asks
   * for what an earlier run of this source on the printer showed fits, else for
   * the estimate from its sliced x1 file, else for 100.
   */
  private async fillUnits(
    isProject: boolean, source: { storagePath: string; createdAt?: Date | null }, machine: Record<string, unknown>, componentId: string, printerId: string,
    ownFileAttachmentId: string | null,
  ): Promise<number> {
    if (isProject) {
      const done = await this.prisma.sliceRun.findMany({
        // Runs older than the source were cut from another geometry.
        where: { componentId, printerId, status: 'DONE', ...(source.createdAt ? { createdAt: { gte: source.createdAt } } : {}) },
        orderBy: { createdAt: 'desc' },
        take: RUN_LIST_LIMIT,
        select: { unitsRequested: true, unitsSliced: true },
      });
      if (pastFillUnits(done) !== null) return projectFillUnits(done);
      return projectFillUnits(done, await this.footprintEstimate(ownFileAttachmentId, machine));
    }
    const abs = containedUploadPath(source.storagePath);
    if (!abs) return 1;
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(abs);
    } catch {
      throw new BadRequestException(`${SliceErrorCode.NO_SOURCE}: The part's source file is missing on disk — upload it again`);
    }
    const bbox = this.stl.analyze(buffer).boundingBox;
    const area = machine.printable_area;
    return fillPlateEstimate({ x: bbox.x, y: bbox.y }, Array.isArray(area) ? (area as string[]) : []);
  }

  /**
   * Copies of one unit that fit the bed, from the object polygons of the part's
   * sliced x1 file (and the bed that file names, else the machine profile's).
   * Null when the part has no x1 file or it cannot be read that way.
   */
  private async footprintEstimate(attachmentId: string | null, machine: Record<string, unknown>): Promise<number | null> {
    if (!attachmentId) return null;
    try {
      const file = await this.prisma.attachment.findUnique({ where: { id: attachmentId }, select: { storagePath: true } });
      const abs = file ? containedUploadPath(file.storagePath) : null;
      const footprint = abs ? await readPlateFootprint(abs) : null;
      if (!footprint?.bbox) return null;
      const machineArea = Array.isArray(machine.printable_area) ? (machine.printable_area as string[]) : [];
      const area = [footprint.printableArea, machineArea].find((a) => a && printableAreaSize(a));
      return area ? fillPlateEstimate(footprint.bbox, area, { cap: PROJECT_FILL_UNITS }) : null;
    } catch {
      return null;
    }
  }

  /** The part's last 20 runs, newest first. */
  async list(productId: string, componentId: string): Promise<SliceRunDto[]> {
    await this.owned(productId, componentId);
    const rows = await this.prisma.sliceRun.findMany({ where: { componentId }, orderBy: { createdAt: 'desc' }, take: RUN_LIST_LIMIT, include: RUN_INCLUDE });
    return rows.map(toRunDto);
  }

  /**
   * A QUEUED run is cancelled and a FAILED run dismissed: both are dropped.
   * RUNNING (the processor owns it) and DONE (its plate exists) are 409.
   */
  async cancel(id: string): Promise<{ deleted: true }> {
    const run = await this.prisma.sliceRun.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!run) throw new NotFoundException('Slice run not found');
    if (run.status !== 'QUEUED' && run.status !== 'FAILED') throw new ConflictException(`A ${run.status.toLowerCase()} run can't be removed`);
    await this.prisma.sliceRun.delete({ where: { id } });
    return { deleted: true };
  }
}
