import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Problem, SlicerImportResult } from '@printforge/types';
import { decideImportLinks, type ImportedSlot, type LinkComponent } from '../catalog-core/colour-link-proposal';
import { round1 } from '../catalog-core/cost-engine';
import { PricingService } from '../catalog-core/pricing.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { sniffImage } from '../common/utils/image-sniff';
import { requiredNumber } from '../common/utils/validate-number';
import { GcodeParserService } from '../file-parser/gcode-parser.service';
import { ThreeMfParserService } from '../file-parser/threemf-parser.service';
import { isMultiColourComponent } from '../stock-ledger/colour-key';
import { componentSlotIndexes, duplicateLayout, plateLabelWarnings, slotsDifferWarning, slotsFor, toolsForComponent } from './plate-layouts.service';
import { lockOptions } from './product-locks';
import { slicerAttachmentData, StoredFile, thumbnailAttachmentData, unlinkWritten, writeUploadFile } from './slicer-files';
import { GRAMS_BOUNDS, MINUTES_BOUNDS } from './slicer-import-input';
import { matchMaterial, newMaterialData, normaliseMaterialType } from './slicer-materials';

/**
 * Slicer imports (spec §3.12): G-code files and 3MF plates become components,
 * or plate layouts on new or existing components. Everything is parsed and
 * every file written to disk first; then ONE transaction creates all rows
 * (filaments, attachments, components, slots, layouts). A failed transaction
 * unlinks the written files, so no component is left without its file and no
 * Attachment row is orphaned. Imports never write Product.colorChanges and
 * never touch photos or `imageUrl`.
 */

export const COLOUR_TARGET = "Colours use each size's components — import onto the product or a size";
export const FOREIGN_COMPONENT = 'That component belongs to another product or option';
const IMPORT_TX = { timeout: 60_000, maxWait: 10_000 };
const round2 = (x: number) => Math.round(x * 100) / 100;

export interface ImportFile {
  buffer: Buffer;
  originalname?: string;
}

export interface ImportOptions {
  sizeOptionId: string | null;
  units: Map<number, number>;
  targets: Map<number, string>;
}

interface Tool { index: number; grams: number; type: unknown; hex: unknown }

interface Item {
  key: number;
  ref: { fileName: string } | { plateIndex: number };
  /** component description / message label */
  name: string;
  sourceName: string;
  gcode: Buffer | null;
  gcodeFilename: string | null;
  sliced: boolean;
  grams: number;
  minutes: number;
  tools: Tool[];
  componentColorChanges: number;
  layoutColorChanges: number;
  labels: { objectCount: number | null; objectModels: Array<{ model: string; count: number }>; ignoredLabels: string[] };
  thumbnail: Buffer | null;
  plateIndex: number | null;
}

type Action = 'SKIP' | 'SINGLE' | 'PER_UNIT' | 'TARGET' | 'PLACEHOLDER';

interface Planned {
  item: Item;
  action: Action;
  units: number;
  targetId: string | null;
  file: StoredFile | null;
  thumb: StoredFile | null;
}

type Response = Omit<SlicerImportResult, 'product'>;

@Injectable()
export class ProductOnboardingService {
  private readonly logger = new Logger(ProductOnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gcodeParser: GcodeParserService,
    private readonly threeMfParser: ThreeMfParserService,
    private readonly pricing: PricingService,
  ) {}

  // ------------------------------------------------------------------ G-code

  async onboardFromGcode(productId: string, files: ImportFile[], opts: ImportOptions): Promise<Response> {
    const items: Item[] = files.map((file, i) => {
      const a = this.gcodeParser.parseHeader(file.buffer);
      const fileName = file.originalname || 'unknown.gcode';
      const used = (a.tools ?? []).filter((t) => (t.filamentGrams || 0) > 0)
        .map((t) => ({ index: t.index, grams: t.filamentGrams || 0, type: t.materialType ?? a.filamentType, hex: t.colorHex ?? null }));
      const grams = a.filamentUsedGrams || used.reduce((s, t) => s + t.grams, 0);
      const tools = used.length ? used : grams > 0 ? [{ index: 0, grams, type: a.filamentType, hex: a.filamentColors?.[0] ?? null }] : [];
      return {
        key: i, ref: { fileName }, name: fileName.replace(/\.(gcode|gco|g)$/i, '').slice(0, 200) || 'Component', sourceName: fileName,
        gcode: file.buffer, gcodeFilename: fileName.slice(0, 200), sliced: grams > 0, grams,
        minutes: a.estimatedTimeSeconds ? Math.round(a.estimatedTimeSeconds / 60) : 0, tools,
        componentColorChanges: Math.max(0, tools.length - 1), layoutColorChanges: Math.max(0, a.totalFilamentChanges ?? 0),
        labels: a, thumbnail: null, plateIndex: null,
      };
    });
    const multicolour = files.some((_, i) => items[i].tools.length > 1) ||
      items.some((it) => it.layoutColorChanges > 0);
    return this.run(productId, items, opts, 'gcode', multicolour);
  }

  // --------------------------------------------------------------------- 3MF

  async onboardFromThreeMf(
    productId: string,
    fileBuffer: Buffer,
    dto: ImportOptions & { selectedPlates: number[]; plateNames?: Record<string, string>; fileName?: string },
  ): Promise<Response> {
    const analysis = await this.threeMfParser.parse(fileBuffer);
    for (const n of dto.selectedPlates) {
      if (!analysis.plates.some((p) => p.plateIndex === n)) throw new BadRequestException(`Plate ${n} isn't in this file`);
    }
    const items: Item[] = [];
    for (const plate of analysis.plates.filter((p) => dto.selectedPlates.includes(p.plateIndex))) {
      const name = (dto.plateNames?.[String(plate.plateIndex)] || plate.name).slice(0, 200);
      const sliced = plate.weightGrams > 0 || plate.printSeconds > 0;
      const gcode = sliced ? await this.threeMfParser.extractPlateGcode(fileBuffer, plate.plateIndex) : null;
      const b64 = plate.thumbnailBase64?.replace(/^data:image\/\w+;base64,/, '');
      items.push({
        key: plate.plateIndex, ref: { plateIndex: plate.plateIndex }, name, sourceName: `${name}.gcode`,
        gcode, gcodeFilename: gcode ? `${name}.gcode` : null, sliced, grams: plate.weightGrams,
        minutes: Math.round(plate.printSeconds / 60),
        tools: plate.tools.filter((t) => t.filamentGrams > 0).map((t) => ({ index: t.index, grams: t.filamentGrams, type: t.materialType, hex: t.colorHex ?? null })),
        componentColorChanges: plate.toolChanges, layoutColorChanges: plate.toolChanges,
        labels: { objectCount: plate.objectCount ?? null, objectModels: plate.objectModels ?? [], ignoredLabels: plate.ignoredLabels ?? [] },
        thumbnail: b64 ? Buffer.from(b64, 'base64') : null, plateIndex: plate.plateIndex,
      });
    }
    const out = await this.run(productId, items, dto, '3mf', false);
    return { slicer: analysis.slicer, ...out };
  }

  // ------------------------------------------------------------------ shared

  private refLabel(it: Item) {
    return 'fileName' in it.ref ? `"${it.name}"` : `Plate ${it.ref.plateIndex} "${it.name}"`;
  }

  /** Decide what each item becomes; throws 400 before anything is written. */
  private plan(items: Item[], opts: ImportOptions, kind: 'gcode' | '3mf'): Planned[] {
    return items.map((item) => {
      const units = opts.units.get(item.key) ?? 1;
      const targetId = opts.targets.get(item.key) ?? null;
      const base = { item, units, targetId, file: null, thumb: null };
      if (kind === 'gcode' && !(item.grams > 0)) return { ...base, action: 'SKIP' as const };
      if (targetId || units > 1) {
        const what = `${this.refLabel(item)} can't be a ×${units} plate layout`;
        if (!item.sliced) throw new BadRequestException(`${what}: it isn't sliced`);
        if (!(item.minutes > 0)) throw new BadRequestException(`${what}: no print time found in the file`);
        requiredNumber(item.minutes, `${item.name} plate minutes`, MINUTES_BOUNDS);
        requiredNumber(round2(item.grams), `${item.name} plate grams`, GRAMS_BOUNDS);
        return { ...base, action: targetId ? ('TARGET' as const) : ('PER_UNIT' as const) };
      }
      return { ...base, action: item.sliced ? ('SINGLE' as const) : ('PLACEHOLDER' as const) };
    });
  }

  private async run(productId: string, items: Item[], opts: ImportOptions, kind: 'gcode' | '3mf', multicolour: boolean): Promise<Response> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, defaultPrinterId: true, baseOptionLabel: true },
    });
    if (!product) throw new NotFoundException('Product not found');
    const scope = opts.sizeOptionId;
    if (scope) {
      const v = await this.prisma.productVariant.findUnique({ where: { id: scope }, select: { id: true, productId: true, kind: true } });
      if (!v || v.productId !== productId) throw new NotFoundException('Size not found');
      if (v.kind === 'COLOUR') throw new BadRequestException(COLOUR_TARGET);
    }
    for (const [, componentId] of opts.targets) {
      const c = await this.prisma.productComponent.findUnique({ where: { id: componentId }, select: { productId: true, variantId: true } });
      if (!c || c.productId !== productId || (c.variantId ?? null) !== scope) throw new BadRequestException(FOREIGN_COMPONENT);
    }
    const planned = this.plan(items, opts, kind);
    const warnings: Problem[] = [];

    // Files to disk first (§3.12 "Transactions").
    const written: StoredFile[] = [];
    for (const p of planned) {
      if (p.action === 'SKIP') continue;
      const needsFile = p.item.gcode && p.action !== 'PLACEHOLDER';
      try {
        if (needsFile) {
          p.file = await writeUploadFile(p.item.gcode!, 'gcode');
          written.push(p.file);
        }
        if (p.item.thumbnail && p.action !== 'TARGET') {
          if (sniffImage(p.item.thumbnail)?.ext === 'png') {
            p.thumb = await writeUploadFile(p.item.thumbnail, 'png', `plate-${p.item.plateIndex}-${Date.now()}.png`);
            written.push(p.thumb);
          } else {
            warnings.push({ code: 'THUMBNAIL_DROPPED', message: `${this.refLabel(p.item)}: its preview image isn't a PNG and was not kept` });
          }
        }
      } catch (e) {
        this.logger.error(`Storing ${p.item.sourceName} for product ${productId} failed: ${(e as Error)?.message}`, (e as Error)?.stack);
        await unlinkWritten(written);
        throw new BadRequestException(`Couldn't store "${p.item.sourceName}" — nothing was imported`);
      }
    }

    let out: Response;
    try {
      out = await this.prisma.$transaction((tx: any) => this.writeRows(tx, productId, scope, product, planned, kind, multicolour, warnings), IMPORT_TX);
    } catch (e) {
      await unlinkWritten(written);
      throw e;
    }
    try {
      await this.pricing.recalcPricing(productId);
    } catch (e) {
      this.logger.warn(`Repricing ${productId} after an import failed: ${(e as Error)?.message}`);
    }
    return out;
  }

  private async writeRows(
    tx: any, productId: string, scope: string | null,
    product: { defaultPrinterId: string | null; baseOptionLabel: string | null },
    planned: Planned[], kind: 'gcode' | '3mf', multicolour: boolean, warnings: Problem[],
  ): Promise<Response> {
    const results: Response['results'] = [];
    const layoutsCreated: Response['layoutsCreated'] = [];
    const skipped: Response['skipped'] = [];
    const createdMaterials: Response['createdMaterials'] = [];

    // §3.1 rule 3: the size row is locked and its kind re-read inside the import.
    let sizeRow: { id: string; name: string } | null = null;
    if (scope) {
      const [row] = await lockOptions(tx, [scope], 'SHARE');
      if (!row || row.productId !== productId) throw new NotFoundException('Size not found');
      if (row.kind === 'COLOUR') throw new BadRequestException(COLOUR_TARGET);
      sizeRow = { id: row.id, name: row.name };
    }

    const materials: any[] = await tx.material.findMany({ select: { id: true, name: true, type: true, color: true, colorHex: true } });
    const materialFor = async (t: Tool): Promise<string> => {
      const type = normaliseMaterialType(t.type);
      const hit = matchMaterial(materials, type, t.hex);
      if (hit) return hit.id;
      const data = newMaterialData(t.type, type, t.hex);
      const m = await tx.material.create({ data, select: { id: true, name: true, type: true, color: true, colorHex: true } });
      materials.push(m);
      createdMaterials.push({ id: m.id, name: m.name, colorHex: m.colorHex ?? null });
      return m.id;
    };

    // New components: filaments first, then one link decision for all their slots.
    const existing: any[] = await tx.productComponent.findMany({ where: { productId }, include: { materials: true } });
    const inScope = existing.filter((c) => (c.variantId ?? null) === scope);
    let nextSort = inScope.reduce((m, c) => Math.max(m, c.sortOrder), -1) + 1;
    let rank = inScope.length;
    const specs: Array<{ p: Planned; key: string; sortOrder: number; multi: boolean; materialId: string | null; slots: Array<{ colorIndex: number; materialId: string; grams: number }> }> = [];
    const newSlots: ImportedSlot[] = [];
    for (const p of planned) {
      if (p.action !== 'SINGLE' && p.action !== 'PER_UNIT' && p.action !== 'PLACEHOLDER') continue;
      const key = `new-${specs.length}`;
      const tools = p.action === 'PLACEHOLDER' ? p.item.tools.slice(0, 1) : p.item.tools;
      const multi = p.action !== 'PLACEHOLDER' && tools.length >= 2;
      const slots: Array<{ colorIndex: number; materialId: string; grams: number }> = [];
      for (const t of tools) slots.push({ colorIndex: multi ? t.index : 0, materialId: await materialFor(t), grams: t.grams });
      const materialId = multi ? null : slots[0]?.materialId ?? null;
      specs.push({ p, key, sortOrder: nextSort++, multi, materialId, slots });
      if (p.action !== 'PLACEHOLDER') {
        for (const s of multi ? slots : slots.slice(0, 1)) {
          newSlots.push({
            componentKey: key, description: p.item.name, colorIndex: s.colorIndex, materialId: s.materialId,
            materialType: materials.find((m) => m.id === s.materialId)?.type ?? 'OTHER', isMultiColor: multi, rank,
          });
        }
      }
      rank++;
    }
    const colourSlots = await tx.productColourSlot.findMany({ where: { productId }, select: { id: true, name: true } });
    const linkInput: LinkComponent[] = existing.map((c) => ({
      id: c.id, description: c.description, variantId: c.variantId ?? null, sortOrder: c.sortOrder, createdAt: c.createdAt,
      isMultiColor: isMultiColourComponent(c),
      slots: isMultiColourComponent(c)
        ? c.materials.map((m: any) => ({ colorIndex: m.colorIndex, materialId: m.materialId, colourSlotId: m.colourSlotId ?? null, colourFixed: m.colourFixed ?? null }))
        : c.materialId ? [{ colorIndex: 0, materialId: c.materialId, colourSlotId: c.colourSlotId ?? null, colourFixed: c.colourFixed ?? null }] : [],
    }));
    const { decisions, warnings: linkWarnings } = decideImportLinks({
      newSlots, existing: linkInput, colourSlots,
      materials: new Map(materials.map((m) => [m.id, { name: m.name, type: m.type }])),
      targetSize: sizeRow, standardSizeLabel: product.baseOptionLabel ?? 'Standard',
    });
    const decision = (key: string, colorIndex: number) => decisions.find((d) => d.componentKey === key && d.colorIndex === colorIndex);

    const attach = async (p: Planned) =>
      p.file ? (await tx.attachment.create({ data: slicerAttachmentData(productId, p.file, p.item.sourceName), select: { id: true } })).id : null;
    const now = new Date();

    for (const s of specs) {
      const { p } = s;
      const it = p.item;
      const perUnit = p.action === 'PER_UNIT';
      const n = perUnit ? p.units : 1;
      const attachmentId = await attach(p);
      const thumbId = p.thumb
        ? (await tx.attachment.create({ data: thumbnailAttachmentData(productId, p.thumb, it.plateIndex ?? 0), select: { id: true } })).id
        : null;
      const single = !s.multi ? decision(s.key, 0) : undefined;
      const comp = await tx.productComponent.create({
        data: {
          productId, variantId: scope, materialId: s.materialId, description: it.name,
          gramsUsed: round2(it.grams / n), printMinutes: round1(it.minutes / n), quantity: 1, sortOrder: s.sortOrder,
          isMultiColor: s.multi, colorChanges: it.componentColorChanges,
          // A ×N plate's file belongs to its layout, not to one unit.
          gcodeFilename: perUnit ? null : it.gcodeFilename, attachmentId: perUnit ? null : attachmentId,
          thumbnailAttachmentId: thumbId, stockConfirmedAt: now,
          colourSlotId: single?.colourSlotId ?? null, colourFixed: single?.colourFixed ?? null,
        },
        select: { id: true },
      });
      if (s.multi) {
        for (const sl of s.slots) {
          const d = decision(s.key, sl.colorIndex);
          await tx.componentMaterial.create({
            data: {
              componentId: comp.id, materialId: sl.materialId, gramsUsed: round2(sl.grams / n), colorIndex: sl.colorIndex, sortOrder: sl.colorIndex,
              colourSlotId: d?.colourSlotId ?? null, colourFixed: d?.colourFixed ?? null,
            },
          });
        }
      }
      let layoutId: string | undefined;
      if (perUnit) {
        // Slots follow the new component: colour indexes for multicolour, 0 for a single material.
        layoutId = await this.createLayout(tx, comp.id, p, attachmentId, s.multi ? it.tools : it.tools.slice(0, 1).map((t) => ({ ...t, index: 0 })));
        await tx.productComponent.update({ where: { id: comp.id }, data: { perUnitEstimatedFromLayoutId: layoutId } });
        layoutsCreated.push({ componentId: comp.id, layoutId, unitsPerPlate: p.units });
      }
      results.push({ ...it.ref, name: it.name, componentsCreated: 1, componentId: comp.id, ...(layoutId ? { layoutId } : {}) });
      this.itemWarnings(p, warnings);
    }

    for (const p of planned) {
      const it = p.item;
      if (p.action === 'SKIP') {
        skipped.push({ ...it.ref, reason: 'no filament weight in file' });
        results.push({ ...it.ref, name: it.name, componentsCreated: 0 });
      } else if (p.action === 'TARGET') {
        const target = await tx.productComponent.findUnique({ where: { id: p.targetId! }, include: { materials: true } });
        if (!target || target.productId !== productId || (target.variantId ?? null) !== scope) throw new BadRequestException(FOREIGN_COMPONENT);
        const dup = await tx.plateLayout.findFirst({ where: { componentId: target.id, unitsPerPlate: p.units, isActive: true }, select: { id: true } });
        if (dup) throw duplicateLayout(p.units, target.description);
        const attachmentId = await attach(p);
        const tools = toolsForComponent(target, it.tools);
        const layoutId = await this.createLayout(tx, target.id, p, attachmentId, tools);
        layoutsCreated.push({ componentId: target.id, layoutId, unitsPerPlate: p.units });
        results.push({ ...it.ref, name: it.name, componentsCreated: 0, componentId: target.id, layoutId });
        const differ = slotsDifferWarning(target.description, tools.length ? tools.map((t) => t.index) : [0], componentSlotIndexes(target));
        if (differ) warnings.push({ ...differ, componentId: target.id });
        this.itemWarnings(p, warnings);
      }
    }
    warnings.push(...linkWarnings);

    // The existing name-based default printer (G-code imports), kept but reported.
    let defaultPrinterAssigned: Response['defaultPrinterAssigned'] = null;
    if (kind === 'gcode' && !product.defaultPrinterId && specs.length + layoutsCreated.length > 0) {
      const printer = await tx.printer.findFirst({
        where: { name: { contains: multicolour ? 'HI' : 'Ender', mode: 'insensitive' }, isActive: true },
        select: { id: true, name: true },
      });
      if (printer) {
        await tx.product.update({ where: { id: productId }, data: { defaultPrinterId: printer.id } });
        defaultPrinterAssigned = { id: printer.id, name: printer.name };
      }
    }
    return { results, layoutsCreated, skipped, warnings, createdMaterials, defaultPrinterAssigned };
  }

  private async createLayout(tx: any, componentId: string, p: Planned, attachmentId: string | null, tools: Tool[]): Promise<string> {
    const it = p.item;
    const grams = round2(it.grams);
    const layout = await tx.plateLayout.create({
      data: {
        componentId, name: `×${p.units}`, unitsPerPlate: p.units, plateMinutes: it.minutes, plateGrams: grams,
        colorChanges: Math.min(10_000, it.layoutColorChanges), source: 'GCODE', attachmentId,
        gcodeFilename: attachmentId ? it.gcodeFilename : null, objectCount: it.labels.objectCount, isActive: true,
      },
      select: { id: true },
    });
    for (const s of slotsFor(tools, grams)) await tx.plateLayoutSlot.create({ data: { layoutId: layout.id, ...s } });
    return layout.id;
  }

  /** Label and slicing warnings of one imported item (§3.12 "Warnings"). */
  private itemWarnings(p: Planned, warnings: Problem[]) {
    const it = p.item;
    if (p.action === 'PLACEHOLDER') {
      warnings.push({
        code: 'PLATE_NOT_SLICED',
        message: `Plate ${it.plateIndex} "${it.name}" isn't sliced — its weight and time are 0 until you enter them or re-import it sliced`,
      });
      return;
    }
    if (p.action !== 'SINGLE') {
      warnings.push(...plateLabelWarnings(it.name, it.labels, p.units));
      return;
    }
    if (it.labels.objectModels.length > 1) warnings.push(...plateLabelWarnings(it.name, { ...it.labels, ignoredLabels: [] }, null));
    if (it.labels.objectCount !== null && it.labels.objectCount > 1) {
      warnings.push({
        code: 'MULTIPLE_OBJECTS',
        message: `"${it.name}" file contains ${it.labels.objectCount} objects — if this is a multi-unit plate, set its units on the plate`,
      });
    }
  }
}
