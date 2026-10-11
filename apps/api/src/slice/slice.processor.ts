import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { MAX_UNITS_PER_PLATE, SliceErrorCode, type SliceRunEvent } from '@printforge/types';
import * as fs from 'fs/promises';
import { PrismaService } from '../common/prisma/prisma.service';
import { GcodeParserService } from '../file-parser/gcode-parser.service';
import { PlateFilesService } from '../products/plate-files.service';
import { PlateLayoutsService, slotsFor } from '../products/plate-layouts.service';
import { ProductComponentsService } from '../products/product-components.service';
import { containedUploadPath } from '../products/product-images.service';
import { SlicerProfilesService } from '../slicer-profiles/slicer-profiles.service';
import { EventsGateway } from '../websocket/events.gateway';
import { SidecarSliceClient, type SidecarFilament, type SidecarSliceRequest } from './sidecar-slice.client';
import { filamentMapOf } from './slice.service';

/**
 * The slice queue (slicer plan WP5), in the API process. Every 2 s one tick:
 * reap RUNNING runs older than 10 min (TIMED_OUT), claim the oldest QUEUED
 * run with `FOR UPDATE SKIP LOCKED`, re-validate it (the part, its source on
 * disk, the printer, every filament — a material merged since queueing fails
 * the run with a reason), send the sidecar the raw presets, and turn the
 * G-code into a plate:
 *
 *  - N units → a PlateLayout SLICED named "x{units} · {printer}" with the
 *    filament and type per slot, replacing an active SLICED layout with the
 *    same part + printer + units + slot types;
 *  - 1 unit (the validation run) → the part's own file, and its grams and
 *    minutes through the component update path so the product reprices.
 *
 * Project parts may have several bodies per unit, so their unit count is the
 * label count divided by the validation run's (bodies-per-unit rule).
 *
 * On boot, RUNNING rows left by the previous process go back to QUEUED. Ticks
 * never overlap (re-entrancy flag). Every status change is broadcast as the
 * `slice-run` websocket event.
 */

export const TICK_MS = 2000;
export const RUN_TIMEOUT_MS = 10 * 60 * 1000;

type Run = {
  id: string;
  componentId: string;
  printerId: string | null;
  unitsRequested: number;
  filamentMap: unknown;
  component: {
    id: string; productId: string; description: string; isMultiColor: boolean; materialId: string | null;
    sourceAttachmentId: string | null; sourceKind: string | null; materials: Array<{ colorIndex: number; materialId: string }>;
  } | null;
};

class RunFailed extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

@Injectable()
export class SliceProcessor implements OnModuleInit {
  private readonly logger = new Logger(SliceProcessor.name);
  private readonly bootAt = new Date();
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sidecar: SidecarSliceClient,
    private readonly gcodeParser: GcodeParserService,
    private readonly profiles: SlicerProfilesService,
    private readonly layouts: PlateLayoutsService,
    private readonly plateFiles: PlateFilesService,
    private readonly components: ProductComponentsService,
    @Optional() private readonly gateway?: EventsGateway,
  ) {}

  /** Runs the previous process was in the middle of start over. */
  async onModuleInit(): Promise<void> {
    try {
      const stale = await this.prisma.sliceRun.updateMany({
        where: { status: 'RUNNING', startedAt: { lt: this.bootAt } },
        data: { status: 'QUEUED', startedAt: null },
      });
      if (stale.count) this.logger.log(`Re-queued ${stale.count} slice run(s) interrupted by a restart`);
    } catch (e) {
      this.logger.warn(`Boot re-queue of slice runs failed: ${(e as Error)?.message}`);
    }
  }

  @Interval(TICK_MS)
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.reap();
      const id = await this.claim();
      if (id) await this.run(id);
    } catch (e) {
      this.logger.error(`Slice tick failed: ${(e as Error)?.message}`, (e as Error)?.stack);
    } finally {
      this.busy = false;
    }
  }

  /** RUNNING for longer than the sidecar could possibly take → TIMED_OUT. */
  private async reap(): Promise<void> {
    const cutoff = new Date(Date.now() - RUN_TIMEOUT_MS);
    const stuck = await this.prisma.sliceRun.findMany({
      where: { status: 'RUNNING', startedAt: { lt: cutoff } },
      select: { id: true, componentId: true, component: { select: { productId: true } } },
    });
    for (const s of stuck) {
      await this.prisma.sliceRun.update({
        where: { id: s.id },
        data: { status: 'FAILED', error: `${SliceErrorCode.TIMED_OUT}: The slicer did not finish in 10 minutes`, finishedAt: new Date() },
      });
      this.broadcast({ id: s.id, componentId: s.componentId, productId: s.component?.productId ?? '', status: 'FAILED', resultLayoutId: null, error: SliceErrorCode.TIMED_OUT });
    }
  }

  /** One run per tick, oldest first; concurrent API processes never take the same one. */
  private async claim(): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE "SliceRun" SET status = 'RUNNING', "startedAt" = now()
      WHERE id = (SELECT id FROM "SliceRun" WHERE status = 'QUEUED' ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id`);
    return rows[0]?.id ?? null;
  }

  /** Process one claimed run to DONE or FAILED. Never throws. */
  async run(id: string): Promise<void> {
    const run = (await this.prisma.sliceRun.findUnique({
      where: { id },
      include: {
        component: {
          select: {
            id: true, productId: true, description: true, isMultiColor: true, materialId: true, sourceAttachmentId: true, sourceKind: true,
            materials: { select: { colorIndex: true, materialId: true } },
          },
        },
      },
    })) as Run | null;
    if (!run) return;
    const productId = run.component?.productId ?? '';
    try {
      const result = await this.slice(run);
      await this.prisma.sliceRun.update({
        where: { id }, data: { status: 'DONE', unitsSliced: result.unitsSliced, resultLayoutId: result.layoutId, error: null, finishedAt: new Date() },
      });
      this.logger.log(`Slice run ${id}: ${run.component?.description} x${result.unitsSliced} done`);
      this.broadcast({ id, componentId: run.componentId, productId, status: 'DONE', resultLayoutId: result.layoutId, error: null });
    } catch (e) {
      const failed = e instanceof RunFailed ? e : new RunFailed('SLICE_FAILED', (e as Error)?.message || 'Slicing failed');
      if (!(e instanceof RunFailed)) this.logger.error(`Slice run ${id} crashed: ${failed.message}`, (e as Error)?.stack);
      const error = `${failed.code}: ${failed.message}`.slice(0, 1000);
      await this.prisma.sliceRun.update({ where: { id }, data: { status: 'FAILED', error, finishedAt: new Date() } }).catch(() => undefined);
      this.broadcast({ id, componentId: run.componentId, productId, status: 'FAILED', resultLayoutId: null, error });
    }
  }

  private async slice(run: Run): Promise<{ unitsSliced: number; layoutId: string | null }> {
    const comp = run.component;
    if (!comp) throw new RunFailed(SliceErrorCode.NO_SOURCE, 'The part was deleted');
    if (!comp.sourceAttachmentId) throw new RunFailed(SliceErrorCode.NO_SOURCE, 'The part has no source model any more');
    const source = await this.prisma.attachment.findUnique({ where: { id: comp.sourceAttachmentId }, select: { storagePath: true } });
    const abs = source ? containedUploadPath(source.storagePath) : null;
    if (!source || !abs || !(await fs.access(abs).then(() => true, () => false))) {
      throw new RunFailed(SliceErrorCode.NO_SOURCE, 'The source file is missing on disk — upload it again');
    }
    const isProject = comp.sourceKind === 'THREEMF';

    const printer = run.printerId ? await this.prisma.printer.findUnique({ where: { id: run.printerId }, select: { id: true, name: true, isActive: true } }) : null;
    if (!printer || !printer.isActive) throw new RunFailed(SliceErrorCode.NO_MACHINE_PROFILE, 'The printer is gone or inactive');
    const machine = await this.profiles.machineFor(printer.id);
    if (!machine) throw new RunFailed(SliceErrorCode.NO_MACHINE_PROFILE, `${printer.name} has no machine profile`);
    const process = isProject ? null : await this.profiles.defaultProcessFor(printer.id);
    if (!isProject && !process) throw new RunFailed(SliceErrorCode.NO_PROCESS_PROFILE, `${printer.name} has no default process profile`);

    const map = filamentMapOf(run.filamentMap);
    const keys = Object.keys(map).sort((a, b) => Number(a) - Number(b));
    if (!keys.length) throw new RunFailed(SliceErrorCode.SLOT_UNMAPPED, 'The run names no filament');
    const materials = await this.prisma.material.findMany({
      where: { id: { in: keys.map((k) => map[k as keyof typeof map]!.materialId) } }, select: { id: true, name: true, type: true, density: true },
    });
    const filaments: SidecarFilament[] = [];
    for (const k of keys) {
      const choice = map[k as keyof typeof map]!;
      const m = materials.find((x) => x.id === choice.materialId);
      if (!m) throw new RunFailed(SliceErrorCode.SLOT_UNMAPPED, `Slot ${Number(k) + 1}: "${choice.name}" no longer exists (merged or deleted)`);
      const raw = await this.profiles.filamentFor(m.id);
      if (!raw) throw new RunFailed(SliceErrorCode.NO_FILAMENT_PROFILE, `"${m.name}" has no filament profile`);
      filaments.push({ raw, density: String(m.density ?? 1.24) });
    }
    const siblings = (await this.prisma.slicerProfile.findMany({ select: { json: true } })).map((p) => ({ raw: p.json as Record<string, unknown> }));

    const req: SidecarSliceRequest = {
      inputPath: source.storagePath, kind: isProject ? '3mf' : 'stl', copies: run.unitsRequested,
      machine: { raw: machine }, ...(process ? { process: { raw: process } } : {}), filaments, siblings,
    };
    const out = await this.sidecar.slice(req);
    if (!out.ok) throw new RunFailed(out.code, out.logTail ? `${out.message} — ${out.logTail.split('\n').slice(-3).join(' | ')}` : out.message);

    const a = this.gcodeParser.parseHeader(out.gcode);
    const labels = a.objectCount;
    if (!labels) throw new RunFailed(SliceErrorCode.NO_OBJECTS, 'The slicer labelled no objects on the plate');
    const minutes = Math.round((a.estimatedTimeSeconds ?? 0) / 60);
    if (!minutes) throw new RunFailed('NO_TIME', 'No print time found in the sliced file');
    const tools = (a.tools ?? []).map((t) => ({ index: t.index, grams: t.filamentGrams || 0 })).filter((t) => t.grams > 0);
    const grams = a.filamentUsedGrams || tools.reduce((s, t) => s + t.grams, 0);
    if (!grams) throw new RunFailed('NO_GRAMS', 'No filament weight found in the sliced file');
    const colorChanges = Math.max(0, a.totalFilamentChanges ?? 0);
    const slotType = (index: number) => map[String(index) as keyof typeof map] ?? null;
    const slots = slotsFor(tools, grams).map((s) => ({ ...s, materialId: slotType(s.colorIndex)?.materialId ?? null, materialType: slotType(s.colorIndex)?.type ?? null }));
    const types = [...new Set(keys.map((k) => map[k as keyof typeof map]!.type))];
    const filename = `${comp.description} x${run.unitsRequested} ${printer.name}.gcode`;

    // The validation run: the part's own ×1 file and per-unit numbers.
    if (run.unitsRequested === 1) {
      await this.plateFiles.attachBuffer(comp.productId, comp.id, null, out.gcode, filename, { replace: true });
      if (comp.isMultiColor) {
        for (const s of slots) await this.prisma.componentMaterial.updateMany({ where: { componentId: comp.id, colorIndex: s.colorIndex }, data: { gramsUsed: s.gramsUsed } });
      }
      await this.components.update(comp.productId, comp.id, { gramsUsed: grams, printMinutes: Math.max(minutes, 0) });
      return { unitsSliced: labels, layoutId: null };
    }

    // N units: a SLICED layout. Projects may hold several bodies per unit.
    const bodies = isProject ? await this.bodiesPerUnit(comp.id) : 1;
    const unitsPerPlate = Math.min(MAX_UNITS_PER_PLATE, Math.max(1, Math.round(labels / bodies)));
    const name = `x${unitsPerPlate} · ${printer.name}${types.some((t) => t !== 'PLA') ? ` · ${types.join('/')}` : ''}`;
    const layoutId = await this.layouts.createSliced(comp.id, {
      name, unitsPerPlate, plateMinutes: minutes, plateGrams: grams, colorChanges, objectCount: labels, printerId: printer.id, slots,
    });
    await this.plateFiles.attachBuffer(comp.productId, comp.id, layoutId, out.gcode, filename, {});
    return { unitsSliced: unitsPerPlate, layoutId };
  }

  /** Labels on the part's most recent 1-unit run (its bodies per unit), else 1. */
  private async bodiesPerUnit(componentId: string): Promise<number> {
    const v = await this.prisma.sliceRun.findFirst({
      where: { componentId, status: 'DONE', unitsRequested: 1, unitsSliced: { gt: 0 } },
      orderBy: { finishedAt: 'desc' },
      select: { unitsSliced: true },
    });
    return v?.unitsSliced && v.unitsSliced > 0 ? v.unitsSliced : 1;
  }

  private broadcast(ev: SliceRunEvent): void {
    try {
      this.gateway?.server?.emit('slice-run', ev);
    } catch (e) {
      this.logger.warn(`slice-run broadcast failed: ${(e as Error)?.message}`);
    }
  }
}
