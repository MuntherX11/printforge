import { Injectable, Optional } from '@nestjs/common';
import { fillPlateEstimate, PLANNABLE_ORDER_STATUSES } from '@printforge/types';
import * as fs from 'fs/promises';
import { projectPrinterOf } from '../catalog-core/project-printer';
import { PrismaService } from '../common/prisma/prisma.service';
import { readPlateFootprint, readPlateOutlines, type PlateOutline } from '../file-parser/plate-footprint';
import { StlEstimatorService } from '../file-parser/stl-estimator.service';
import { JobPlanningService, type ComputedPlan, type RowPlan } from '../production/job-planning.service';
import { containedUploadPath } from '../products/product-images.service';
import { sourceMetaOf, type SourceMeta } from '../products/product-sources';
import { pastCapacity, projectFillUnits } from '../slice/fill-units';
import { SidecarClient } from '../slicer-profiles/sidecar.client';
import { SlicerProfilesService } from '../slicer-profiles/slicer-profiles.service';
import { needModeOf } from './order-need-mode';
import { liveJobUnits, type NeedFilament, type PlanNeed, type PlanPrinter, type PlateJob, type PlateRow } from './order-plate-model';
import { bedOf } from './order-plate-preview';
import { plannedUnits, toPlateRow } from './order-plate-view';

/**
 * What an order still has to print, and how each part can be printed (v2.19.0).
 *
 * The needs are the rows of the order's production plan (J4,
 * JobPlanningService.computePlan): one per order line and part. Each gets a
 * mode (order-need-mode.ts) from its model, its filaments on this order line
 * and the printers' slicer profiles. A row whose units are on jobs made from
 * this order's plates still shows them: `toProduce` is the plan's own number
 * plus those units, and `planned` what the plates hold.
 */

/** Everything the print plan of one order is built from. */
export interface PlanState {
  order: { id: string; orderNumber: string; status: string };
  plannable: boolean;
  plan: ComputedPlan;
  rows: Map<string, RowPlan>;
  needs: PlanNeed[];
  needsByKey: Map<string, PlanNeed>;
  printers: PlanPrinter[];
  printersById: Map<string, PlanPrinter>;
  /** Raw machine presets by printer (the bed of a sliced file that does not name one). */
  machines: Map<string, Record<string, unknown>>;
  plates: PlateRow[];
  jobs: PlateJob[];
  files: PlanFiles;
}

/** A sliced file's objects and bed, as its drawing needs them. */
export interface FileOutlines {
  outlines: PlateOutline[];
  printableArea: string[] | null;
}

/**
 * What was read from the parts' files on disk: a unit's footprint per model or
 * x1 file, and the outlines of every plate file. Read BEFORE a write takes the
 * order's plan lock (`prepare`), so no file is opened or parsed while the
 * transaction is open; inside it a file that is not in here counts as unknown.
 */
export interface PlanFiles {
  footprints: Map<string, Box | null>;
  outlines: Map<string, FileOutlines | null>;
}

type Box = { x: number; y: number };
const FOOTPRINT_CACHE_MAX = 500;
const OUTLINE_CACHE_MAX = 100;
const HEALTH_TTL_MS = 20_000;
const JOB_SELECT = { id: true, status: true, orderPlateId: true, orderItemId: true, componentId: true, quantityToProduce: true };
export const PLATE_INCLUDE = { printer: { select: { id: true, name: true } } };

@Injectable()
export class OrderNeedsService {
  /** A stored file never changes, so its footprint is read once per attachment. */
  private readonly footprints = new Map<string, Box | null>();
  private readonly outlines = new Map<string, FileOutlines>();
  private health: { at: number; reachable: boolean } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly planning: JobPlanningService,
    private readonly profiles: SlicerProfilesService,
    private readonly stl: StlEstimatorService,
    @Optional() private readonly sidecar?: SidecarClient,
  ) {}

  /** Whether the slicer container answers; asked at most every 20 s. */
  async slicerReachable(): Promise<boolean> {
    if (this.health && Date.now() - this.health.at < HEALTH_TTL_MS) return this.health.reachable;
    const reachable = this.sidecar ? (await this.sidecar.health().catch(() => ({ reachable: false }))).reachable : false;
    this.health = { at: Date.now(), reachable };
    return reachable;
  }

  /** Active printers with their bed and what can be sliced for them. */
  async printers(): Promise<{ printers: PlanPrinter[]; machines: Map<string, Record<string, unknown>> }> {
    const rows = await this.prisma.printer.findMany({ where: { isActive: true }, select: { id: true, name: true, model: true }, orderBy: { name: 'asc' } });
    const machines = new Map<string, Record<string, unknown>>();
    const printers: PlanPrinter[] = [];
    for (const p of rows) {
      const machine = await this.profiles.machineFor(p.id);
      const process = machine ? await this.profiles.defaultProcessFor(p.id) : null;
      if (machine) machines.set(p.id, machine as Record<string, unknown>);
      const bed = machine ? bedOf((machine as Record<string, unknown>).printable_area) : null;
      printers.push({ id: p.id, name: p.name, model: p.model ?? null, bed: bed ? { x: bed.x, y: bed.y } : null, hasMachine: !!machine, canSliceModels: !!machine && !!process });
    }
    return { printers, machines };
  }

  /** The parts' files of an order, read from disk. Call before taking the plan lock and pass the result to `load`. */
  async prepare(orderId: string): Promise<PlanFiles> {
    const plan = await this.planning.computePlan(orderId, { anyStatus: true });
    return this.readFiles(plan.rows, await this.fileRows(plan.rows), true);
  }

  private async fileRows(rows: ReadonlyArray<RowPlan>) {
    const ids = [...new Set(rows.flatMap((r) => [r.component.sourceAttachmentId, r.component.attachmentId, ...r.component.layouts.map((l) => l.attachmentId)]).filter((x): x is string => !!x))];
    const files: Array<{ id: string; storagePath: string; parsedMetadata: unknown; createdAt: Date }> = ids.length
      ? await this.prisma.attachment.findMany({ where: { id: { in: ids } }, select: { id: true, storagePath: true, parsedMetadata: true, createdAt: true } })
      : [];
    return new Map(files.map((f) => [f.id, f]));
  }

  /** Each file once per call: one that cannot be read is unknown for the whole request, never tried again inside it. */
  private async readFiles(rows: ReadonlyArray<RowPlan>, fileOf: ReadonlyMap<string, { id: string; storagePath: string }>, withOutlines = false): Promise<PlanFiles> {
    const out: PlanFiles = { footprints: new Map(), outlines: new Map() };
    for (const { component: c } of rows) {
      const source = c.sourceAttachmentId ? fileOf.get(c.sourceAttachmentId) : undefined;
      if (source && c.sourceKind !== 'THREEMF') {
        if (!out.footprints.has(source.id)) out.footprints.set(source.id, await this.stlFootprint(source));
      } else {
        const own = c.attachmentId ? fileOf.get(c.attachmentId) : undefined;
        if (own && !out.footprints.has(own.id)) out.footprints.set(own.id, await this.slicedFootprint(own));
      }
      // Only a write draws a plate file (a new LAYOUT plate); a read shows what was stored then.
      for (const l of withOutlines ? c.layouts : []) {
        const file = l.attachmentId ? fileOf.get(l.attachmentId) : undefined;
        if (file && !out.outlines.has(file.id)) out.outlines.set(file.id, await this.fileOutlines(file));
      }
    }
    return out;
  }

  /**
   * `db`: the transaction of a write (the plates and their jobs are read in
   * it; the plan itself reads committed state, as J5 does under its lock).
   * `files`: what `prepare` read before the lock; without it the files are read here.
   * `capacity`: also work out how many units a project's plate holds (suggest).
   */
  async load(orderId: string, opts: { db?: any; capacity?: boolean; files?: PlanFiles } = {}): Promise<PlanState> {
    const db = opts.db ?? this.prisma;
    const plan = await this.planning.computePlan(orderId, { anyStatus: true });
    const plannable = (PLANNABLE_ORDER_STATUSES as ReadonlyArray<string>).includes(plan.order.status);
    const plates: PlateRow[] = (await db.orderPlate.findMany({ where: { orderId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], include: PLATE_INCLUDE })).map(toPlateRow);
    const jobs: PlateJob[] = plates.length ? await db.productionJob.findMany({ where: { orderPlateId: { in: plates.map((p) => p.id) } }, select: JOB_SELECT }) : [];
    const { printers, machines } = await this.printers();
    const printersById = new Map(printers.map((p) => [p.id, p]));

    const live = liveJobUnits(jobs);
    const planned = plannedUnits(plates, jobs, live);
    const rows = new Map(plan.rows.map((r) => [r.row.rowKey, r]));
    const shown = plan.rows.filter((r) => r.row.toProduce + (live.get(r.row.rowKey) ?? 0) > 0 || (planned.get(r.row.rowKey) ?? 0) > 0);

    // One read each for the parts' files, the products' pricing printers and the filaments' presets.
    const fileOf = await this.fileRows(shown);
    const files = opts.files ?? await this.readFiles(shown, fileOf);
    const productIds = [...new Set(shown.map((r) => r.row.productId))];
    const products: Array<{ id: string; defaultPrinterId: string | null }> = productIds.length
      ? await this.prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, defaultPrinterId: true } })
      : [];
    const pricingOf = new Map(products.map((p) => [p.id, p.defaultPrinterId]));
    const presets = new Map<string, boolean>();
    const hasPreset = async (materialId: string) => {
      if (!presets.has(materialId)) presets.set(materialId, !!(await this.profiles.filamentFor(materialId)));
      return presets.get(materialId)!;
    };

    const needs: PlanNeed[] = [];
    for (const rp of shown) {
      const { row, component: c } = rp;
      const sourceFile = c.sourceAttachmentId ? fileOf.get(c.sourceAttachmentId) ?? null : null;
      const kind = sourceFile ? (c.sourceKind === 'THREEMF' ? 'THREEMF' : 'STL') : null;
      const meta: SourceMeta | null = kind === 'THREEMF' ? sourceMetaOf(sourceFile!.parsedMetadata) : null;
      const project = meta ? projectPrinterOf(meta, printers) : null;
      const multi = !!meta && (meta.slots.length >= 2 || c.isMultiColor);
      // The order line's filament per slot: the project's slots for a multi-colour project, else the part's own.
      const slotIndexes = multi && meta!.slots.length ? meta!.slots.map((s) => s.colorIndex) : c.slots.map((s) => s.colorIndex);
      const facts: Array<{ slot: number; materialId: string | null; name: string; type: string; colorHex: string | null; hasPreset: boolean }> = [];
      for (const [i, index] of slotIndexes.entries()) {
        // One colour on both sides is that colour, whatever index each side gives it.
        const s = c.slots.find((x) => x.colorIndex === index) ?? (slotIndexes.length === 1 && c.slots.length === 1 ? c.slots[0] : undefined);
        facts.push({
          slot: multi ? index : i, materialId: s?.materialId ?? null, name: s?.material.name ?? '', type: String(s?.material.type ?? 'PLA'),
          colorHex: s?.material.colorHex ?? null, hasPreset: s ? await hasPreset(s.materialId) : false,
        });
      }
      const mode = needModeOf({
        description: c.description, pendingFirstSlice: c.pendingFirstSlice, isMultiColor: c.isMultiColor,
        source: kind ? { kind, projectSlots: meta?.slots.length ?? 0, printerModel: meta?.printerModel ?? null } : null,
        projectPrinter: project ? { id: project.id, name: project.name, hasMachine: project.hasMachine } : null,
        filaments: facts, layoutCount: c.layouts.length,
      });
      const filaments: NeedFilament[] = facts.filter((f) => f.materialId).map((f) => ({ slot: f.slot, materialId: f.materialId!, name: f.name, type: f.type, colorHex: f.colorHex }));
      const footprint = files.footprints.get((kind === 'STL' ? sourceFile!.id : c.attachmentId) ?? '') ?? null;
      const liveUnits = live.get(row.rowKey) ?? 0;
      const need: PlanNeed = {
        rowKey: row.rowKey, orderItemId: row.orderItemId, componentId: row.componentId, productId: row.productId,
        productName: row.productName, componentDescription: row.componentDescription, colourLabel: row.colourLabel,
        // '' for the standard pair (the plan row's own label says "Standard").
        optionLabel: row.sizeOptionId || row.colourOptionId ? row.optionLabel : '',
        toProduce: row.toProduce + liveUnits, planned: planned.get(row.rowKey) ?? 0, open: row.toProduce,
        mode: mode.mode, blockedReason: mode.blockedReason, canOwnSettings: mode.canOwnSettings, lockedPrinterId: mode.lockedPrinterId,
        materialId: mode.mode === 'MIX' ? filaments[0]?.materialId ?? null : null,
        materialName: mode.mode === 'MIX' ? filaments[0]?.name ?? null : null,
        layouts: c.layouts.map((l) => ({
          layoutId: l.layoutId, label: l.label, unitsPerPlate: l.unitsPerPlate, printerId: l.printerId ?? null, printerName: l.printerName ?? null, hasFile: !!l.attachmentId,
        })),
        minutesPerUnit: c.minutesPerUnit, gramsPerUnit: c.gramsPerUnit, footprint,
        source: sourceFile && kind ? { attachmentId: sourceFile.id, storagePath: sourceFile.storagePath, kind } : null,
        filaments, projectPrinterId: project?.id ?? null, pricingPrinterId: pricingOf.get(row.productId) ?? null,
        plannerLayouts: c.layouts, capacity: null,
      };
      if (opts.capacity && need.mode === 'PROJECT' && need.lockedPrinterId) {
        need.capacity = await this.projectCapacity(need, sourceFile?.createdAt ?? null, machines.get(need.lockedPrinterId) ?? null, plates);
      }
      needs.push(need);
    }
    return {
      order: { id: plan.order.id, orderNumber: plan.order.orderNumber, status: plan.order.status },
      plannable, plan, rows, needs, needsByKey: new Map(needs.map((n) => [n.rowKey, n])), printers, printersById, machines, plates, jobs, files,
    };
  }

  /**
   * Units of a project one plate holds: what an earlier slice of the part on
   * that printer (a run of the product page, or a plate of this order) placed
   * when it was asked for more; else the estimate from its sliced x1 file;
   * else the first fill's 100 (fill-units.ts) — the slicer then says what fits.
   */
  private async projectCapacity(need: PlanNeed, sourceCreatedAt: Date | null, machine: Record<string, unknown> | null, plates: ReadonlyArray<PlateRow>): Promise<number> {
    const runs = await this.prisma.sliceRun.findMany({
      where: { componentId: need.componentId, printerId: need.lockedPrinterId, status: 'DONE', ...(sourceCreatedAt ? { createdAt: { gte: sourceCreatedAt } } : {}) },
      orderBy: { createdAt: 'desc' }, take: 20, select: { unitsRequested: true, unitsSliced: true },
    });
    const own = plates
      .filter((p) => p.kind === 'PROJECT' && p.status === 'DONE' && p.printerId === need.lockedPrinterId && p.items[0]?.rowKey === need.rowKey)
      .map((p) => ({ unitsRequested: p.items[0].units, unitsSliced: p.items[0].unitsSliced }));
    const past = pastCapacity([...own, ...runs]);
    if (past !== null) return past;
    const area = Array.isArray(machine?.printable_area) ? (machine!.printable_area as string[]) : [];
    // No margin: these units are meant to print, not to find out what fits.
    const estimate = need.footprint && area.length ? fillPlateEstimate(need.footprint, area, { marginPct: 0 }) : null;
    return projectFillUnits([], estimate);
  }

  private remember(id: string, box: Box | null): Box | null {
    if (this.footprints.size >= FOOTPRINT_CACHE_MAX) this.footprints.delete(this.footprints.keys().next().value as string);
    this.footprints.set(id, box);
    return box;
  }

  /** The bounding box of an STL, from the file. Null when it is missing or cannot be read. */
  private async stlFootprint(file: { id: string; storagePath: string }): Promise<Box | null> {
    if (this.footprints.has(file.id)) return this.footprints.get(file.id)!;
    try {
      const abs = containedUploadPath(file.storagePath);
      if (!abs) return null;
      const box = this.stl.analyze(await fs.readFile(abs)).boundingBox;
      return this.remember(file.id, Number.isFinite(box.x) && Number.isFinite(box.y) && box.x > 0 && box.y > 0 ? { x: box.x, y: box.y } : null);
    } catch {
      return null; // not remembered: the file may only be missing for now
    }
  }

  /** The outlines of a plate file (immutable once stored, so kept per attachment). */
  private async fileOutlines(file: { id: string; storagePath: string }): Promise<FileOutlines | null> {
    const hit = this.outlines.get(file.id);
    if (hit) return hit;
    const abs = containedUploadPath(file.storagePath);
    const read = abs ? await readPlateOutlines(abs) : null;
    if (!read) return null;
    if (this.outlines.size >= OUTLINE_CACHE_MAX) this.outlines.delete(this.outlines.keys().next().value as string);
    this.outlines.set(file.id, read);
    return read;
  }

  /** The footprint of a project's unit, from the objects of its sliced x1 file. */
  private async slicedFootprint(file: { id: string; storagePath: string } | null): Promise<Box | null> {
    if (!file) return null;
    if (this.footprints.has(file.id)) return this.footprints.get(file.id)!;
    const abs = containedUploadPath(file.storagePath);
    const read = abs ? await readPlateFootprint(abs) : null;
    return read ? this.remember(file.id, read.bbox) : null;
  }
}
