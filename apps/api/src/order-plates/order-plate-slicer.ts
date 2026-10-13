import { HttpException, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plateShares, type OrderPlateEvent, type OrderPlatePreviewDto, type SliceFilamentMap, type SlotKey } from '@printforge/types';
import * as fs from 'fs/promises';
import { PrismaService } from '../common/prisma/prisma.service';
import { GcodeParserService } from '../file-parser/gcode-parser.service';
import { plateOutlinesOf } from '../file-parser/plate-footprint';
import { containedUploadPath } from '../products/product-images.service';
import { TX_OPTS } from '../products/product-locks';
import { unlinkWritten, writeUploadFile } from '../products/slicer-files';
import { SidecarSliceClient, sidecarFailure, type SidecarFilament, type SidecarMixedSliceRequest, type SidecarSliceRequest } from '../slice/sidecar-slice.client';
import { bodiesPerUnit, SliceProcessor, type OrderPlateQueue } from '../slice/slice.processor';
import { SlicerProfilesService } from '../slicer-profiles/slicer-profiles.service';
import { EventsGateway } from '../websocket/events.gateway';
import { OrderNeedsService, PLATE_INCLUDE, type PlanState } from './order-needs.service';
import type { PlateRow, StoredItem } from './order-plate-model';
import { bedOf, exactPreview } from './order-plate-preview';
import { checkPlate } from './order-plate-rules';
import { plateFileName, plateLabel, toPlateRow } from './order-plate-view';

/**
 * Slices one plate of an order's print plan (v2.19.0). The slice processor's
 * tick claims the plate (it shares the queue with the product page's slice
 * runs) and hands it here.
 *
 * The plate is checked again as it stands now — its parts, their models on
 * disk, the printer, the filament of the order line — then sent to the slicer
 * container: a MIXED plate as several models with the printer's default
 * process, a PROJECT plate as the one project with its own settings. The
 * G-code that comes back is stored as the plate's file, and the plate keeps
 * what the file says: its minutes and grams, how many units of each part were
 * really placed (a plate asked to hold more than fits comes back with fewer),
 * each part's share of the minutes and grams, and the outline of every object.
 *
 * The result is written only while the plate is still this run's: RUNNING,
 * with the `startedAt` its claim set. A plate that was reaped, replaced by a
 * new suggestion, deleted, or edited and queued again meanwhile keeps nothing
 * of the old run, and the file is removed again.
 */

/** A failure with the sentence the staff reads; `detail` is the slicer's raw output. */
class PlateFailed extends Error {
  constructor(message: string, public readonly detail: string | null = null) {
    super(message);
  }
}

const TIMED_OUT = 'The slicer did not finish in 10 minutes — try fewer units on this plate';
const round1 = (n: number) => Math.round(n * 10) / 10;

interface Sliced {
  gcode: Buffer;
  filename: string;
  printerModel: string | null;
  items: StoredItem[];
  filamentMap: SliceFilamentMap;
  minutes: number;
  grams: number;
  colorChanges: number;
  preview: OrderPlatePreviewDto | null;
}

@Injectable()
export class OrderPlateSlicer implements OnModuleInit, OrderPlateQueue {
  private readonly logger = new Logger(OrderPlateSlicer.name);
  private readonly bootAt = new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly needs: OrderNeedsService,
    private readonly sidecar: SidecarSliceClient,
    private readonly gcodeParser: GcodeParserService,
    private readonly profiles: SlicerProfilesService,
    @Optional() private readonly processor?: SliceProcessor,
    @Optional() private readonly gateway?: EventsGateway,
  ) {}

  /** Joins the slice queue; plates the previous process was in the middle of start over. */
  async onModuleInit(): Promise<void> {
    this.processor?.registerOrderPlates(this);
    try {
      const stale = await this.prisma.orderPlate.updateMany({ where: { status: 'RUNNING', startedAt: { lt: this.bootAt } }, data: { status: 'QUEUED', startedAt: null } });
      if (stale.count) this.logger.log(`Re-queued ${stale.count} order plate(s) interrupted by a restart`);
    } catch (e) {
      this.logger.warn(`Boot re-queue of order plates failed: ${(e as Error)?.message}`);
    }
  }

  async reap(cutoff: Date): Promise<void> {
    const stuck = await this.prisma.orderPlate.findMany({ where: { status: 'RUNNING', startedAt: { lt: cutoff } }, select: { id: true, orderId: true } });
    for (const s of stuck) {
      const flipped = await this.prisma.orderPlate.updateMany({ where: { id: s.id, status: 'RUNNING' }, data: { status: 'FAILED', error: TIMED_OUT, errorDetail: null, finishedAt: new Date() } });
      if (flipped.count) this.broadcast({ id: s.id, orderId: s.orderId, status: 'FAILED', error: TIMED_OUT });
    }
  }

  async run(id: string): Promise<void> {
    const row = await this.prisma.orderPlate.findUnique({ where: { id }, include: PLATE_INCLUDE }).catch(() => null);
    if (!row) return;
    const plate = toPlateRow(row);
    // This run's claim: every write below matches it, so a later run of the same plate is never touched.
    const mine = { id, status: 'RUNNING' as const, startedAt: row.startedAt ? new Date(row.startedAt) : null };
    this.broadcast({ id, orderId: plate.orderId, status: 'RUNNING', error: null });
    try {
      const sliced = await this.slice(plate);
      if (await this.store(plate, sliced, mine)) {
        this.logger.log(`Order plate ${id} sliced: ${sliced.items.map((i) => `${i.unitsSliced}/${i.units}`).join(', ')} units`);
        this.broadcast({ id, orderId: plate.orderId, status: 'DONE', error: null });
      }
    } catch (e) {
      const failed = e instanceof PlateFailed ? e : new PlateFailed((e as Error)?.message || 'Slicing failed');
      if (!(e instanceof PlateFailed)) this.logger.error(`Order plate ${id} crashed: ${failed.message}`, (e as Error)?.stack);
      const error = failed.message.slice(0, 1000);
      const flipped = await this.prisma.orderPlate
        .updateMany({ where: mine, data: { status: 'FAILED', error, errorDetail: failed.detail, finishedAt: new Date() } })
        .catch(() => ({ count: 0 }));
      if (flipped.count) this.broadcast({ id, orderId: plate.orderId, status: 'FAILED', error });
    }
  }

  private async slice(plate: PlateRow): Promise<Sliced> {
    if (plate.kind === 'LAYOUT') throw new PlateFailed('This plate prints an existing file — there is nothing to slice');
    const state = await this.needs.load(plate.orderId);

    // The same rules as when the plate was made, on the order as it is now.
    let draft: ReturnType<typeof checkPlate>;
    try {
      draft = checkPlate(
        { kind: plate.kind, printerId: plate.printerId, items: plate.items.map((i) => ({ rowKey: i.rowKey, units: i.units })), layoutId: null, plateCount: 1 },
        state.needsByKey, state.printersById,
      );
    } catch (e) {
      if (e instanceof HttpException) throw new PlateFailed(e.message);
      throw e;
    }
    const printer = state.printersById.get(draft.printerId!)!;
    const machine = state.machines.get(printer.id);
    if (!machine) throw new PlateFailed(`${printer.name} has no machine profile — import one in Settings › Slicer`);
    const parts = draft.items.map((i) => state.needsByKey.get(i.rowKey)!);
    for (const n of parts) {
      const abs = n.source ? containedUploadPath(n.source.storagePath) : null;
      if (!abs || !(await fs.access(abs).then(() => true, () => false))) {
        throw new PlateFailed(`The model of "${n.componentDescription}" is missing on disk — upload it again on the product page`);
      }
    }
    const filaments = await this.filaments(draft.filamentMap);
    const siblings = (await this.prisma.slicerProfile.findMany({ select: { json: true } })).map((p) => ({ raw: p.json as Record<string, unknown> }));

    let req: SidecarSliceRequest | SidecarMixedSliceRequest;
    if (plate.kind === 'MIXED') {
      const process = await this.profiles.defaultProcessFor(printer.id);
      if (!process) throw new PlateFailed(`${printer.name} has no default process profile — set one in Settings › Slicer`);
      req = {
        inputs: parts.map((n, k) => ({ inputPath: n.source!.storagePath, kind: n.source!.kind === 'THREEMF' ? '3mf' as const : 'stl' as const, copies: draft.items[k].units })),
        machine: { raw: machine }, process: { raw: process as Record<string, unknown> }, filaments: filaments.slice(0, 1), siblings,
      };
    } else {
      // The project carries its own process.
      req = { inputPath: parts[0].source!.storagePath, kind: '3mf', copies: draft.items[0].units, machine: { raw: machine }, filaments, siblings };
    }
    const out = await this.sidecar.slice(req);
    if (!out.ok) {
      const failure = sidecarFailure(out);
      this.logger.warn(`Order plate ${plate.id}: the slicer failed (${out.code}, exit ${out.exitCode ?? 'none'}): ${out.message}`);
      // A plain sentence: the code a slice run keeps in front is dropped, and the part to blame is named.
      const sentence = failure.error.replace(/^[A-Z][A-Z_]+: /, '');
      const blamed = typeof out.input === 'number' ? parts[out.input] : undefined;
      throw new PlateFailed(blamed ? `"${blamed.componentDescription}": ${sentence}` : sentence, failure.detail);
    }

    const a = this.gcodeParser.parseHeader(out.gcode);
    const labels = a.objectCount;
    if (!labels) throw new PlateFailed('The slicer placed nothing on the plate — the parts may be larger than the bed');
    const minutes = Math.round((a.estimatedTimeSeconds ?? 0) / 60);
    if (!minutes) throw new PlateFailed('No print time was found in the sliced file');
    const tools = (a.tools ?? []).map((t) => ({ index: t.index, grams: t.filamentGrams || 0 })).filter((t) => t.grams > 0);
    const grams = a.filamentUsedGrams || tools.reduce((s, t) => s + t.grams, 0);
    if (!grams) throw new PlateFailed('No filament weight was found in the sliced file');

    // Units really placed: the slicer drops what does not fit without saying so.
    let placed: number[];
    if (plate.kind === 'MIXED') {
      const fromHeader = out.inputUnits ?? (parts.length === 1 ? [labels] : null);
      if (!fromHeader || fromHeader.length !== parts.length) {
        throw new PlateFailed('The slicer did not say how many of each part it placed — update the slicer container, then slice again');
      }
      placed = fromHeader;
    } else {
      placed = [Math.round(labels / (await bodiesPerUnit(this.prisma, parts[0].componentId)))];
    }
    placed = placed.map((u, k) => Math.max(0, Math.min(draft.items[k].units, Math.floor(u))));
    if (!placed.some((u) => u > 0)) throw new PlateFailed('The slicer placed nothing on the plate — the parts may be larger than the bed');

    const minuteShares = plateShares(minutes, placed.map((u, k) => u * parts[k].minutesPerUnit));
    const gramShares = plateShares(grams, placed.map((u, k) => u * parts[k].gramsPerUnit));
    const items: StoredItem[] = draft.items.map((i, k) => ({
      ...i, unitsSliced: placed[k],
      // A part the slicer left off entirely has no share (plateShares splits evenly only when no part has numbers).
      minutes: placed[k] ? round1(minuteShares[k]) : 0,
      grams: placed[k] ? round1(gramShares[k]) : 0,
    }));
    if (plate.kind === 'PROJECT' && tools.length) {
      items[0].slotGrams = Object.fromEntries(tools.filter((t) => t.index >= 0 && t.index <= 3).map((t) => [String(t.index) as SlotKey, t.grams]));
    }
    const { outlines, printableArea } = plateOutlinesOf(out.gcode);
    return {
      gcode: out.gcode,
      filename: plateFileName(state.order.orderNumber, plateLabel(plate.sortOrder, printer.name), plate.id),
      printerModel: a.printerModel ?? null,
      items, filamentMap: draft.filamentMap, minutes, grams: round1(grams),
      colorChanges: Math.max(0, a.totalFilamentChanges ?? 0),
      preview: exactPreview(bedOf(printableArea) ?? bedOf(machine.printable_area), outlines, items.map((i) => i.rowKey)),
    };
  }

  /** The raw preset and density of every slot's filament, in slot order; fails naming what is missing. */
  private async filaments(map: SliceFilamentMap): Promise<SidecarFilament[]> {
    const keys = (Object.keys(map) as SlotKey[]).sort();
    if (!keys.length) throw new PlateFailed('This plate names no filament');
    const materials = await this.prisma.material.findMany({ where: { id: { in: keys.map((k) => map[k]!.materialId) } }, select: { id: true, name: true, type: true, density: true } });
    const out: SidecarFilament[] = [];
    for (const k of keys) {
      const m = materials.find((x) => x.id === map[k]!.materialId);
      if (!m) throw new PlateFailed(`"${map[k]!.name}" no longer exists (merged or deleted) — choose the filament again on the order line`);
      const raw = await this.profiles.filamentFor(m.id);
      if (!raw) throw new PlateFailed(`"${m.name}" has no slicer preset, and there is no main preset for ${m.type} — set one in Settings › Slicer`);
      out.push({ raw: raw as Record<string, unknown>, density: String(m.density ?? 1.24) });
    }
    return out;
  }

  /** The file and the plate's numbers in one transaction; false (and no file) when the plate is no longer this run's. */
  private async store(plate: PlateRow, s: Sliced, mine: { id: string; status: 'RUNNING'; startedAt: Date | null }): Promise<boolean> {
    let stored;
    try {
      stored = await writeUploadFile(s.gcode, 'gcode');
    } catch (e) {
      this.logger.error(`Storing the G-code of order plate ${plate.id} failed: ${(e as Error)?.message}`, (e as Error)?.stack);
      throw new PlateFailed('The sliced file could not be saved on the server — check the disk, then slice again');
    }
    let kept = false;
    try {
      kept = await this.prisma.$transaction(async (tx: any) => {
        const att = await tx.attachment.create({
          data: {
            // Its own entity type: the file belongs to the plate, not to the order's list of attachments.
            entityType: 'order-plate', entityId: plate.id, filename: stored.filename, originalName: s.filename,
            mimeType: 'application/octet-stream', sizeBytes: stored.sizeBytes, storagePath: stored.storagePath,
            slicedForPrinter: s.printerModel ? s.printerModel.slice(0, 120) : null,
          },
          select: { id: true },
        });
        const flipped = await tx.orderPlate.updateMany({
          where: mine,
          data: {
            status: 'DONE', items: s.items as unknown as Prisma.InputJsonValue, filamentMap: s.filamentMap as unknown as Prisma.InputJsonValue,
            minutes: s.minutes, grams: s.grams, colorChanges: s.colorChanges, attachmentId: att.id, gcodeFilename: s.filename,
            preview: (s.preview as unknown as Prisma.InputJsonValue | null) ?? Prisma.DbNull, error: null, errorDetail: null, finishedAt: new Date(),
          },
        });
        // Not this run's any more (reaped, replaced, deleted, queued again): the Attachment row goes with the file.
        if (!flipped.count) await tx.attachment.delete({ where: { id: att.id } });
        return flipped.count > 0;
      }, TX_OPTS);
    } finally {
      if (!kept) await unlinkWritten([stored]);
    }
    return kept;
  }

  private broadcast(ev: OrderPlateEvent): void {
    try {
      this.gateway?.server?.emit('order-plate', ev);
    } catch (e) {
      this.logger.warn(`order-plate broadcast failed: ${(e as Error)?.message}`);
    }
  }
}
