import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ORDER_PLAN_MAX_PLATES, type OrderPlateDto, type OrderPlateEvent, type OrderPrintPlanDto } from '@printforge/types';
import { PrismaService } from '../common/prisma/prisma.service';
import { assertPlannable } from '../production/job-plan-rules';
import { lockOrderPlan } from '../production/job-transitions';
import { containedUploadPath } from '../products/product-images.service';
import { TX_OPTS, unlinkAfterCommit, unreferencedAttachments } from '../products/product-locks';
import { EventsGateway } from '../websocket/events.gateway';
import { OrderNeedsService, PLATE_INCLUDE, type PlanState } from './order-needs.service';
import { suggestOrderPlates, toSuggestNeed } from './order-plan-suggest';
import { zipEntryName } from './order-plate-download';
import { parseCreatePlate, parseNoBody, parseUpdatePlate } from './order-plate-input';
import { liveJobsOf, storedItemsOf, type PlateRow } from './order-plate-model';
import { bedOf, exactPreview } from './order-plate-preview';
import { checkPlate, type PlateDraft } from './order-plate-rules';
import { plateFileName, plateLabel, toPlanDto, toPlateDto } from './order-plate-view';

/**
 * The plates of an order's print plan (v2.19.0): the suggestion, staff's
 * changes to it and the slice queue.
 *
 * Every write runs under the order's plan lock (`plan:<orderId>`, the lock J5
 * and the order's cancel take), so a plate never changes while jobs are being
 * made from it. A plate that has jobs is locked; one that is being sliced is
 * the processor's until it is done. Any change to a sliced plate drops its
 * file and returns it to DRAFT — except a LAYOUT plate, which prints a file
 * the part already has and is DONE from the start.
 */

export const PLATE_RUNNING = 'This plate is being sliced right now — wait for it to finish';
export const PLATE_LOCKED = 'Jobs were made from this plate — cancel them before changing it';
export const PLATE_NOT_FOUND = 'Plate not found';

@Injectable()
export class OrderPlatesService {
  private readonly logger = new Logger(OrderPlatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly needs: OrderNeedsService,
    @Optional() private readonly gateway?: EventsGateway,
  ) {}

  // ------------------------------------------------------------------ reads

  async getPlan(orderId: string): Promise<OrderPrintPlanDto> {
    const state = await this.needs.load(orderId);
    return toPlanDto({ orderId, plannable: state.plannable, plates: state.plates, view: state, slicerReachable: await this.needs.slicerReachable() });
  }

  private async plateDto(id: string): Promise<OrderPlateDto> {
    const row = await this.prisma.orderPlate.findUnique({ where: { id }, select: { orderId: true } });
    if (!row) throw new NotFoundException(PLATE_NOT_FOUND);
    const state = await this.needs.load(row.orderId);
    const plate = state.plates.find((p) => p.id === id);
    if (!plate) throw new NotFoundException(PLATE_NOT_FOUND);
    return toPlateDto(plate, state);
  }

  /**
   * The file of a plate: its path inside the uploads directory and the name it
   * downloads under. A sliced plate has its own file. A LAYOUT plate prints a
   * plate file of the part, so it serves the file that plate has NOW (the one
   * a job made from it will carry), even when it was replaced since.
   */
  async file(id: string): Promise<{ abs: string; filename: string }> {
    const plate = await this.prisma.orderPlate.findUnique({ where: { id }, include: { ...PLATE_INCLUDE, order: { select: { orderNumber: true } } } });
    if (!plate) throw new NotFoundException(PLATE_NOT_FOUND);
    let attachmentId: string | null = plate.attachmentId ?? null;
    let filename: string | null = plate.gcodeFilename ?? null;
    if (plate.kind === 'LAYOUT') {
      const componentId = storedItemsOf(plate.items)[0]?.componentId;
      const own = plate.layoutId
        ? await this.prisma.plateLayout.findUnique({ where: { id: plate.layoutId }, select: { attachmentId: true, gcodeFilename: true } })
        : componentId ? await this.prisma.productComponent.findUnique({ where: { id: componentId }, select: { attachmentId: true, gcodeFilename: true } }) : null;
      attachmentId = own?.attachmentId ?? null;
      filename = own?.gcodeFilename ?? null;
    }
    const att = attachmentId ? await this.prisma.attachment.findUnique({ where: { id: attachmentId }, select: { storagePath: true, originalName: true } }) : null;
    const abs = att ? containedUploadPath(att.storagePath) : null;
    if (!abs) {
      if (plate.kind === 'LAYOUT') throw new NotFoundException('This plate of the part has no file any more — upload one on the product page');
      throw new NotFoundException(attachmentId ? 'The file of this plate was deleted — slice it again' : 'This plate has no file yet — slice it first');
    }
    // The stored name is the one a job of this plate carries, so the printer's report matches it.
    return { abs, filename: filename || att?.originalName || plateFileName(plate.order.orderNumber, plateLabel(plate.sortOrder, plate.printer?.name ?? null), plate.id) };
  }

  /** Every plate file of the order, each once, under distinct names (for the zip). */
  async files(orderId: string): Promise<{ orderNumber: string; entries: Array<{ abs: string; filename: string }> }> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { orderNumber: true } });
    if (!order) throw new NotFoundException('Order not found');
    const plates = await this.prisma.orderPlate.findMany({ where: { orderId }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
    const entries: Array<{ abs: string; filename: string }> = [];
    const seen = new Set<string>();
    const names = new Set<string>();
    for (const p of plates) {
      const f = await this.file(p.id).catch(() => null);
      if (!f || seen.has(f.abs)) continue;
      seen.add(f.abs);
      const base = zipEntryName(f.filename);
      let name = base;
      for (let n = 2; names.has(name.toLowerCase()); n++) name = base.replace(/(\.[^.]+)?$/, ` (${n})$1`);
      names.add(name.toLowerCase());
      entries.push({ abs: f.abs, filename: name });
    }
    if (!entries.length) throw new NotFoundException('No plate of this order has a file yet');
    return { orderNumber: order.orderNumber, entries };
  }

  // ----------------------------------------------------------------- writes

  /**
   * One write under the order's plan lock, on the plan as it is inside it. The
   * parts' files are read before the lock is taken, never while it is held;
   * files the write drops are unlinked after the commit.
   */
  private async write<T>(orderId: string, run: (tx: any, state: PlanState, unlink: Array<string | null>) => Promise<T>, opts: { capacity?: boolean } = {}): Promise<T> {
    const unlink: Array<string | null> = [];
    const files = await this.needs.prepare(orderId);
    const out = await this.prisma.$transaction(async (tx: any) => {
      await lockOrderPlan(tx, orderId);
      const state = await this.needs.load(orderId, { db: tx, capacity: opts.capacity, files });
      assertPlannable(state.order.status);
      return run(tx, state, unlink);
    }, TX_OPTS);
    await unlinkAfterCommit(unlink);
    return out;
  }

  private async orderOf(plateId: string): Promise<string> {
    const row = await this.prisma.orderPlate.findUnique({ where: { id: plateId }, select: { orderId: true } });
    if (!row) throw new NotFoundException(PLATE_NOT_FOUND);
    return row.orderId;
  }

  /** The plate inside the lock, free to change: not being sliced, no jobs. */
  private editable(state: PlanState, id: string): PlateRow {
    const plate = state.plates.find((p) => p.id === id);
    if (!plate) throw new NotFoundException(PLATE_NOT_FOUND);
    if (plate.status === 'RUNNING') throw new ConflictException(PLATE_RUNNING);
    if (liveJobsOf(state.jobs, id).length) throw new ConflictException(PLATE_LOCKED);
    return plate;
  }

  /**
   * Removes the Attachment rows of sliced files that nothing prints any more
   * (never a LAYOUT plate's: that file is the part's). Call after the plates
   * were changed; returns the paths to unlink once the transaction commits.
   */
  private async dropFiles(tx: any, plates: ReadonlyArray<Pick<PlateRow, 'kind' | 'attachmentId'>>): Promise<Array<string | null>> {
    const ids = plates.filter((p) => p.kind !== 'LAYOUT' && p.attachmentId).map((p) => p.attachmentId!);
    const paths: Array<string | null> = [];
    for (const o of await unreferencedAttachments(tx, ids)) {
      if (await tx.orderPlate.count({ where: { attachmentId: o.id } })) continue;
      await tx.attachment.delete({ where: { id: o.id } });
      paths.push(o.abs);
    }
    return paths;
  }

  /** The columns of a checked plate. A LAYOUT plate is DONE at once, with its layout's file, numbers and drawing. */
  private dataOf(draft: PlateDraft, state: PlanState) {
    const l = draft.layout;
    const items = l ? draft.items.map((i) => ({ ...i, minutes: l.plateMinutes, grams: l.plateGrams })) : draft.items;
    return {
      kind: draft.kind,
      status: l ? ('DONE' as const) : ('DRAFT' as const),
      printerId: draft.printerId,
      items: items as unknown as Prisma.InputJsonValue,
      filamentMap: draft.filamentMap as unknown as Prisma.InputJsonValue,
      layoutId: draft.layoutId,
      plateCount: draft.plateCount,
      estMinutes: draft.estMinutes,
      estGrams: draft.estGrams,
      minutes: l ? l.plateMinutes : null,
      grams: l ? l.plateGrams : null,
      colorChanges: l?.colorChanges ?? 0,
      attachmentId: l?.attachmentId ?? null,
      gcodeFilename: l?.gcodeFilename ?? null,
      preview: (l ? this.layoutPreview(l.attachmentId ?? null, draft, state) : null) ?? Prisma.DbNull,
      error: null,
      errorDetail: null,
      startedAt: null,
      finishedAt: l ? new Date() : null,
    };
  }

  /** The exact drawing of an existing plate file (read before the lock); null when it has none or labels no object. */
  private layoutPreview(attachmentId: string | null, draft: PlateDraft, state: PlanState): Prisma.InputJsonValue | null {
    const read = attachmentId ? state.files.outlines.get(attachmentId) : null;
    if (!read) return null;
    const machine = draft.printerId ? state.machines.get(draft.printerId) : undefined;
    const bed = bedOf(read.printableArea) ?? bedOf(machine?.printable_area);
    return exactPreview(bed, read.outlines, draft.items.map((i) => i.rowKey)) as unknown as Prisma.InputJsonValue | null;
  }

  /** "Prepare print files" / "Reset to suggestion": replaces every plate that has no jobs. */
  async suggest(orderId: string, body: unknown): Promise<OrderPrintPlanDto> {
    parseNoBody(body);
    await this.write(orderId, async (tx, state, unlink) => {
      const s = suggestOrderPlates(state.needs.map((n) => toSuggestNeed(n, n.open)), state.printers);
      const locked = state.plates.filter((p) => liveJobsOf(state.jobs, p.id).length);
      const replaced = state.plates.filter((p) => !locked.includes(p));
      if (replaced.length) await tx.orderPlate.deleteMany({ where: { id: { in: replaced.map((p) => p.id) } } });
      unlink.push(...await this.dropFiles(tx, replaced));
      // Numbers continue after the plates that stay, so a number never names two plates.
      let sortOrder = locked.reduce((m, p) => Math.max(m, p.sortOrder + 1), 0);
      for (const p of s.plates.slice(0, Math.max(0, ORDER_PLAN_MAX_PLATES - locked.length))) {
        // The suggestion is checked like a plate made by hand: the same rules, one place.
        const draft = checkPlate({ kind: p.kind, printerId: p.printerId, items: p.items, layoutId: p.layoutId, plateCount: p.plateCount }, state.needsByKey, state.printersById);
        await tx.orderPlate.create({ data: { orderId, sortOrder: sortOrder++, ...this.dataOf(draft, state) } });
      }
    }, { capacity: true });
    // What could not be placed is a warning of the plan itself, so a later read says it too.
    return this.getPlan(orderId);
  }

  async createPlate(orderId: string, body: unknown): Promise<OrderPlateDto> {
    const input = parseCreatePlate(body);
    const id = await this.write(orderId, async (tx, state) => {
      if (state.plates.length >= ORDER_PLAN_MAX_PLATES) throw new BadRequestException(`An order's plan holds at most ${ORDER_PLAN_MAX_PLATES} plates`);
      const draft = checkPlate(input, state.needsByKey, state.printersById);
      const sortOrder = state.plates.reduce((m, p) => Math.max(m, p.sortOrder + 1), 0);
      const row = await tx.orderPlate.create({ data: { orderId, sortOrder, ...this.dataOf(draft, state) }, select: { id: true } });
      return row.id as string;
    });
    return this.plateDto(id);
  }

  async updatePlate(id: string, body: unknown): Promise<OrderPlateDto> {
    const input = parseUpdatePlate(body);
    const orderId = await this.orderOf(id);
    await this.write(orderId, async (tx, state, unlink) => {
      const plate = this.editable(state, id);
      if (input.plateCount !== undefined && input.plateCount !== 1 && plate.kind !== 'LAYOUT') {
        throw new BadRequestException('Only a plate that prints an existing file can be printed several times — add another plate instead');
      }
      const draft = checkPlate({
        kind: plate.kind,
        printerId: input.printerId !== undefined ? input.printerId : plate.printerId,
        items: input.items ?? plate.items.map((i) => ({ rowKey: i.rowKey, units: i.units })),
        layoutId: plate.layoutId,
        plateCount: input.plateCount ?? plate.plateCount,
      }, state.needsByKey, state.printersById);
      await tx.orderPlate.update({ where: { id }, data: this.dataOf(draft, state) });
      unlink.push(...await this.dropFiles(tx, [plate]));
    });
    this.broadcast(id, orderId, 'DRAFT');
    return this.plateDto(id);
  }

  async deletePlate(id: string): Promise<{ deleted: true }> {
    const orderId = await this.orderOf(id);
    await this.write(orderId, async (tx, state, unlink) => {
      const plate = this.editable(state, id);
      await tx.orderPlate.delete({ where: { id } });
      unlink.push(...await this.dropFiles(tx, [plate]));
    });
    return { deleted: true };
  }

  // ------------------------------------------------------------------ slice

  /** Queues every plate that still has to be sliced: DRAFT or FAILED, MIXED or PROJECT, no jobs. */
  async queueAll(orderId: string, body: unknown): Promise<{ queued: number }> {
    parseNoBody(body);
    const ids = await this.write(orderId, async (tx, state) => {
      const todo = state.plates.filter((p) => p.kind !== 'LAYOUT' && (p.status === 'DRAFT' || p.status === 'FAILED') && !liveJobsOf(state.jobs, p.id).length);
      return this.queue(tx, todo.map((p) => p.id));
    });
    for (const id of ids) this.broadcast(id, orderId, 'QUEUED');
    return { queued: ids.length };
  }

  async queueOne(id: string, body: unknown): Promise<OrderPlateDto> {
    parseNoBody(body);
    const orderId = await this.orderOf(id);
    const ids = await this.write(orderId, async (tx, state) => {
      const plate = this.editable(state, id);
      if (plate.kind === 'LAYOUT') throw new BadRequestException('This plate prints an existing file — there is nothing to slice');
      if (plate.status === 'QUEUED') throw new ConflictException('This plate is already waiting for the slicer');
      if (plate.status === 'DONE') throw new ConflictException('This plate is already sliced — change it to slice it again');
      return this.queue(tx, [id]);
    });
    for (const x of ids) this.broadcast(x, orderId, 'QUEUED');
    return this.plateDto(id);
  }

  /** DRAFT / FAILED → QUEUED, guarded on the status so a plate is never queued twice. Returns the ids that were. */
  private async queue(tx: any, ids: string[]): Promise<string[]> {
    const queued: string[] = [];
    for (const id of ids) {
      const flipped = await tx.orderPlate.updateMany({
        where: { id, status: { in: ['DRAFT', 'FAILED'] } },
        data: { status: 'QUEUED', queuedAt: new Date(), error: null, errorDetail: null, startedAt: null, finishedAt: null },
      });
      if (flipped.count) queued.push(id);
    }
    return queued;
  }

  private broadcast(id: string, orderId: string, status: OrderPlateEvent['status'], error: string | null = null): void {
    try {
      const ev: OrderPlateEvent = { id, orderId, status, error };
      this.gateway?.server?.emit('order-plate', ev);
    } catch (e) {
      this.logger.warn(`order-plate broadcast failed: ${(e as Error)?.message}`);
    }
  }
}
