import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ComponentPlateLayout, Problem } from '@printforge/types';
import { round3 } from '../catalog-core/cost-engine';
import { ChunkUploadsService } from '../chunk-uploads/chunk-uploads.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { requiredNumber } from '../common/utils/validate-number';
import { GcodeParserService } from '../file-parser/gcode-parser.service';
import { isMultiColourComponent } from '../stock-ledger/colour-key';
import { ACTIVE_JOBS, TX_OPTS, unlinkAfterCommit, unreferencedAttachments } from './product-locks';
import { slicerAttachmentData, StoredFile, unlinkWritten, writeUploadFile } from './slicer-files';
import {
  COLOR_CHANGES_BOUNDS, GRAMS_BOUNDS, MINUTES_BOUNDS, parseLayoutCreate, parseLayoutPatch, UNITS_BOUNDS,
} from './slicer-import-input';

/**
 * Plate layouts of one component (spec §3.4, §4.3 M3–M5). A layout belongs to
 * exactly one component; the component's own per-unit definition is the
 * implicit ×1 and is never stored here. Layouts never change the single-unit
 * price, so nothing here reprices.
 */

const MAX_GCODE_BYTES = 200 * 1024 * 1024;
const round2 = (x: number) => Math.round(x * 100) / 100;

export const NO_LABELS = 'This file has no object labels — enter how many units are on the plate';
export const NO_TIME = 'No print time found in the file — enter the plate minutes';
export const NO_GRAMS = 'No filament weight found in the file — enter the plate grams';
export const STORE_FAILED = "Couldn't store the file — try again";

export function duplicateLayout(units: number, description: string) {
  return new ConflictException(`A ×${units} layout already exists for "${description}"`);
}

/** Warnings that compare a plate file's object labels with the units (§3.4). */
export function plateLabelWarnings(
  desc: string,
  labels: { objectCount: number | null; objectModels: Array<{ model: string; count: number }>; ignoredLabels: string[] },
  units: number | null,
): Problem[] {
  const out: Problem[] = [];
  if (labels.objectModels.length > 1) {
    out.push({
      code: 'MIXED_PLATE',
      message: `"${desc}": the plate holds different models (${labels.objectModels.map((m) => `${m.count} × ${m.model}`).join(', ')}) — a layout belongs to one component, so check the units`,
    });
  }
  if (units !== null && labels.objectCount !== null && units !== labels.objectCount) {
    out.push({ code: 'UNITS_DIFFER_FROM_LABELS', message: `"${desc}": ${units} units entered, but the file's labels count ${labels.objectCount} objects` });
  }
  if (labels.ignoredLabels.length > 0) {
    out.push({ code: 'TOWER_IGNORED', message: `"${desc}": ${labels.ignoredLabels.join(', ')} isn't an item and wasn't counted` });
  }
  return out;
}

/** The colour indexes of a component's own slots (single material = {0}). */
export function componentSlotIndexes(c: { isMultiColor: boolean; materialId: string | null; materials: Array<{ colorIndex: number }> }): number[] {
  return isMultiColourComponent(c as any) ? c.materials.map((m) => m.colorIndex).sort((a, b) => a - b) : [0];
}

export function slotsDifferWarning(desc: string, toolIndexes: number[], compIndexes: number[]): Problem | null {
  const a = [...new Set(toolIndexes)].sort((x, y) => x - y);
  const b = [...new Set(compIndexes)].sort((x, y) => x - y);
  if (a.length === b.length && a.every((v, i) => v === b[i])) return null;
  return {
    code: 'SLOTS_DIFFER',
    message: `"${desc}": the file prints colours ${a.map((i) => i + 1).join(', ') || 'none'} but the component has colours ${b.map((i) => i + 1).join(', ')} — check the filaments`,
  };
}

/**
 * A single-material component has one slot, colour index 0. A plate file that
 * prints it with one tool (T2 on a 4-slot AMS, say) is the same single colour,
 * so its one used tool is stored as slot 0 rather than raising SLOTS_DIFFER.
 * Multicolour components keep the file's tool indexes (§3.4 "Slots").
 */
export function toolsForComponent<T extends { index: number }>(
  c: { isMultiColor: boolean; materialId: string | null; materials: Array<{ colorIndex: number }> },
  tools: T[],
): T[] {
  if (!isMultiColourComponent(c as any) && tools.length === 1) return [{ ...tools[0], index: 0 }];
  return tools;
}

/** Plate slots from used tools, scaled so they sum to `plateGrams` (single-tool files → one slot 0). */
export function slotsFor(tools: Array<{ index: number; grams: number }>, plateGrams: number): Array<{ colorIndex: number; gramsUsed: number }> {
  const used = tools.filter((t) => t.grams > 0);
  if (!used.length) return [{ colorIndex: 0, gramsUsed: round2(plateGrams) }];
  const sum = used.reduce((s, t) => s + t.grams, 0);
  return used.map((t) => ({ colorIndex: t.index, gramsUsed: round2((t.grams / sum) * plateGrams) }));
}

export function toLayoutView(l: any, attachment?: { id: string; originalName: string | null; filename: string; sizeBytes: number } | null): ComponentPlateLayout {
  return {
    id: l.id, name: l.name, unitsPerPlate: l.unitsPerPlate, plateMinutes: l.plateMinutes, plateGrams: l.plateGrams,
    colorChanges: l.colorChanges ?? 0, source: l.source, objectCount: l.objectCount ?? null, isActive: l.isActive !== false,
    sortOrder: l.sortOrder ?? 0, minutesPerUnit: round3(l.plateMinutes / l.unitsPerPlate), gramsPerUnit: round3(l.plateGrams / l.unitsPerPlate),
    file: attachment
      ? { attachmentId: attachment.id, filename: attachment.originalName || attachment.filename, sizeBytes: attachment.sizeBytes, downloadUrl: `/api/attachments/${attachment.id}/download` }
      : null,
    slots: [...(l.slots ?? [])].sort((a: any, b: any) => a.colorIndex - b.colorIndex).map((s: any) => ({ colorIndex: s.colorIndex, gramsUsed: s.gramsUsed })),
  };
}

@Injectable()
export class PlateLayoutsService {
  private readonly logger = new Logger(PlateLayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gcodeParser: GcodeParserService,
    private readonly chunkUploads: ChunkUploadsService,
  ) {}

  /** 404 unless the component belongs to the product (§3.4 "Ownership"). */
  private async ownedComponent(db: any, productId: string, componentId: string) {
    const c = await db.productComponent.findUnique({ where: { id: componentId }, include: { materials: true } });
    if (!c || c.productId !== productId) throw new NotFoundException('Component not found');
    return c;
  }

  private async ownedLayout(db: any, productId: string, componentId: string, layoutId: string) {
    const c = await this.ownedComponent(db, productId, componentId);
    const l = await db.plateLayout.findUnique({ where: { id: layoutId }, include: { slots: true } });
    if (!l || l.componentId !== componentId) throw new NotFoundException('Layout not found');
    return { component: c, layout: l };
  }

  private async assertNoActiveSize(db: any, componentId: string, units: number, description: string, exceptId?: string) {
    const dup = await db.plateLayout.findFirst({
      where: { componentId, unitsPerPlate: units, isActive: true, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { id: true },
    });
    if (dup) throw duplicateLayout(units, description);
  }

  private async view(db: any, layoutId: string): Promise<ComponentPlateLayout> {
    const l = await db.plateLayout.findUnique({ where: { id: layoutId }, include: { slots: true } });
    const att = l?.attachmentId
      ? await db.attachment.findUnique({ where: { id: l.attachmentId }, select: { id: true, originalName: true, filename: true, sizeBytes: true } })
      : null;
    return toLayoutView(l, att);
  }

  /** M3: from a staged plate G-code, or manual (all three numbers). */
  async create(productId: string, componentId: string, body: unknown): Promise<{ layout: ComponentPlateLayout; warnings: Problem[] }> {
    const input = parseLayoutCreate(body);
    const comp = await this.ownedComponent(this.prisma, productId, componentId);
    const desc: string = comp.description;
    const warnings: Problem[] = [];

    if (!input.assembledUploadId) {
      const units = input.unitsPerPlate!;
      const grams = input.plateGrams!;
      const layoutId = await this.prisma.$transaction(async (tx: any) => {
        await this.ownedComponent(tx, productId, componentId);
        await this.assertNoActiveSize(tx, componentId, units, desc);
        const layout = await tx.plateLayout.create({
          data: {
            componentId, name: input.name ?? `×${units}`, unitsPerPlate: units, plateMinutes: input.plateMinutes!, plateGrams: grams,
            colorChanges: input.colorChanges ?? 0, source: 'MANUAL', objectCount: null, isActive: true,
          },
          select: { id: true },
        });
        const slots = this.manualSlots(comp, grams);
        for (const s of slots) await tx.plateLayoutSlot.create({ data: { layoutId: layout.id, ...s } });
        return layout.id;
      }, TX_OPTS);
      return { layout: await this.view(this.prisma, layoutId), warnings };
    }

    // From a G-code: read with keep, so a failed attempt can be retried.
    const file = await this.chunkUploads.consume(input.assembledUploadId, MAX_GCODE_BYTES, { keep: true });
    const name = String(file.originalname || '').toLowerCase();
    if (!/\.(gcode|gco|g)$/.test(name)) throw new BadRequestException('File must be a G-code file (.gcode, .gco, .g)');
    const a = this.gcodeParser.parseHeader(file.buffer);

    const units = input.unitsPerPlate ?? a.objectCount;
    if (units === null || units === undefined) throw new BadRequestException(NO_LABELS);
    requiredNumber(units, 'unitsPerPlate', UNITS_BOUNDS);
    const minutes = input.plateMinutes ?? Math.round((a.estimatedTimeSeconds ?? 0) / 60);
    if (!minutes) throw new BadRequestException(NO_TIME);
    requiredNumber(minutes, 'plateMinutes', MINUTES_BOUNDS);
    const toolSum = (a.tools ?? []).reduce((s, t) => s + (t.filamentGrams || 0), 0);
    const fileGrams = a.filamentUsedGrams || toolSum;
    const grams = input.plateGrams ?? fileGrams;
    if (!grams) throw new BadRequestException(NO_GRAMS);
    requiredNumber(grams, 'plateGrams', GRAMS_BOUNDS);
    const colorChanges = input.colorChanges ?? Math.min(COLOR_CHANGES_BOUNDS.max, Math.max(0, a.totalFilamentChanges ?? 0));

    const tools = toolsForComponent(comp, (a.tools ?? []).map((t) => ({ index: t.index, grams: t.filamentGrams || 0 })).filter((t) => t.grams > 0));
    warnings.push(...plateLabelWarnings(desc, a, input.unitsPerPlate ?? null));
    const differ = slotsDifferWarning(desc, tools.length ? tools.map((t) => t.index) : [0], componentSlotIndexes(comp));
    if (differ) warnings.push(differ);

    let stored: StoredFile;
    try {
      stored = await writeUploadFile(file.buffer, 'gcode');
    } catch (e) {
      this.logger.error(`Storing a plate G-code for component ${componentId} failed: ${(e as Error)?.message}`, (e as Error)?.stack);
      throw new BadRequestException(STORE_FAILED);
    }

    let layoutId: string;
    try {
      layoutId = await this.prisma.$transaction(async (tx: any) => {
        await this.ownedComponent(tx, productId, componentId);
        await this.assertNoActiveSize(tx, componentId, units, desc);
        const att = await tx.attachment.create({ data: slicerAttachmentData(productId, stored, file.originalname), select: { id: true } });
        const layout = await tx.plateLayout.create({
          data: {
            componentId, name: input.name ?? `×${units}`, unitsPerPlate: units, plateMinutes: minutes, plateGrams: grams,
            colorChanges, source: 'GCODE', attachmentId: att.id, gcodeFilename: String(file.originalname || 'plate.gcode').slice(0, 200),
            objectCount: a.objectCount, isActive: true,
          },
          select: { id: true },
        });
        for (const s of slotsFor(tools, grams)) await tx.plateLayoutSlot.create({ data: { layoutId: layout.id, ...s } });
        return layout.id;
      }, TX_OPTS);
    } catch (e) {
      await unlinkWritten([stored]);
      throw e;
    }
    await this.chunkUploads.discard(input.assembledUploadId);
    return { layout: await this.view(this.prisma, layoutId), warnings };
  }

  /** Manual layouts split the plate grams across the component's own slots in its per-unit proportions. */
  private manualSlots(comp: any, grams: number) {
    if (!isMultiColourComponent(comp)) return [{ colorIndex: 0, gramsUsed: round2(grams) }];
    const mats: Array<{ colorIndex: number; gramsUsed: number }> = comp.materials;
    const anyGrams = mats.some((m) => m.gramsUsed > 0);
    // Equal split when the component has no per-slot grams to go by.
    return slotsFor(mats.map((m) => ({ index: m.colorIndex, grams: anyGrams ? Math.max(0, m.gramsUsed) : 1 })), grams);
  }

  /** M4. Changing `plateGrams` rescales the slots proportionally. */
  async update(productId: string, componentId: string, layoutId: string, body: unknown): Promise<ComponentPlateLayout> {
    const input = parseLayoutPatch(body);
    await this.prisma.$transaction(async (tx: any) => {
      const { component, layout } = await this.ownedLayout(tx, productId, componentId, layoutId);
      const units = input.unitsPerPlate ?? layout.unitsPerPlate;
      const active = input.isActive ?? layout.isActive;
      if (active && (units !== layout.unitsPerPlate || !layout.isActive)) {
        await this.assertNoActiveSize(tx, componentId, units, component.description, layoutId);
      }
      const data: Record<string, unknown> = {};
      for (const k of ['name', 'unitsPerPlate', 'plateMinutes', 'plateGrams', 'colorChanges', 'isActive', 'sortOrder'] as const) {
        if (input[k] !== undefined) data[k] = input[k];
      }
      if (!Object.keys(data).length) return;
      await tx.plateLayout.update({ where: { id: layoutId }, data });
      if (input.plateGrams !== undefined && input.plateGrams !== layout.plateGrams) {
        const slots = layout.slots ?? [];
        const sum = slots.reduce((s: number, x: any) => s + x.gramsUsed, 0);
        for (const s of slots) {
          const g = sum > 0 ? (s.gramsUsed / sum) * input.plateGrams : input.plateGrams / slots.length;
          await tx.plateLayoutSlot.update({ where: { id: s.id }, data: { gramsUsed: round2(g) } });
        }
      }
    }, TX_OPTS);
    return this.view(this.prisma, layoutId);
  }

  /** M5: open job → 409; used by history → deactivated; else deleted with its file. */
  async remove(productId: string, componentId: string, layoutId: string): Promise<{ deleted: true } | { deactivated: true }> {
    const out = await this.prisma.$transaction(async (tx: any) => {
      const { layout } = await this.ownedLayout(tx, productId, componentId, layoutId);
      const open = await tx.productionJob.count({ where: { status: { in: ACTIVE_JOBS }, plates: { some: { layoutId } } } });
      if (open > 0) throw new ConflictException('This layout is planned on an open job — finish or cancel the job first');
      const history = await tx.jobPlate.count({ where: { layoutId } });
      if (history > 0) {
        await tx.plateLayout.update({ where: { id: layoutId }, data: { isActive: false } });
        return { result: { deactivated: true as const }, unlink: [] as Array<string | null> };
      }
      await tx.plateLayout.delete({ where: { id: layoutId } });
      const orphans = await unreferencedAttachments(tx, [layout.attachmentId]);
      for (const o of orphans) await tx.attachment.delete({ where: { id: o.id } });
      return { result: { deleted: true as const }, unlink: orphans.map((o) => o.abs) };
    }, TX_OPTS);
    await unlinkAfterCommit(out.unlink);
    return out.result;
  }
}
