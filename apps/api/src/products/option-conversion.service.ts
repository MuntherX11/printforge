import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { OrderStatus, Prisma } from '@prisma/client';
import {
  PLANNABLE_ORDER_STATUSES, type LayoutConversionPreview, type LayoutConversionResult, type Problem,
} from '@printforge/types';
import { resolveInConfig, type ResolvedComponent } from '../catalog-core/bom-resolve';
import { BomResolverService } from '../catalog-core/bom-resolver.service';
import { optionsOfKind, type ProductConfig } from '../catalog-core/catalog-config';
import { CatalogRequestContext } from '../catalog-core/catalog-context';
import { computeLineProgress } from '../catalog-core/line-progress';
import { standardSizeLabel } from '../catalog-core/option-pair';
import type { PlannerLayout } from '../catalog-core/plate-planner';
import { ProductionPlannerService } from '../catalog-core/production-planner.service';
import { ChunkUploadsService } from '../chunk-uploads/chunk-uploads.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { GcodeParserService, type GcodeAnalysis } from '../file-parser/gcode-parser.service';
import {
  liveConversion, parseConversionActive, parseLayoutConversion, planningRows, plateChecks, type LayoutConversionInput,
} from './option-conversion-rules';
import { plateLabelWarnings, STORE_FAILED, toLayoutView } from './plate-layouts.service';
import { matchPlateSlots, type FileTool, type MatchedSlot, type PartSlot } from './plate-slot-match';
import { lockOptions, optionHistory, TX_OPTS } from './product-locks';
import { slicerAttachmentData, unlinkWritten, writeUploadFile, type StoredFile } from './slicer-files';
import { COLOR_CHANGES_BOUNDS } from './slicer-import-input';
import { normaliseHex } from './slicer-materials';

/**
 * Convert to plate (O8a preview, O8 convert): an owner-driven action that turns
 * a legacy size option which is really "N per plate" into a plate layout on one
 * part, and switches the option off with its history kept. Never automatic.
 * Layouts never change a price, so nothing here reprices.
 */

type Db = Prisma.TransactionClient;
export interface ConversionActor { id: string }

interface OptionRowLite { id: string; productId: string; kind: string; name: string; convertedLayoutId: string | null }
interface ComponentLite { id: string; productId: string; variantId: string | null; description: string }
interface ParsedFile { buffer: Buffer; originalname: string; analysis: GcodeAnalysis }

interface Draft {
  config: ProductConfig;
  rc: ResolvedComponent;
  parts: PartSlot[];
  slots: MatchedSlot[];
  match: LayoutConversionPreview['slotMatch'];
  recommendActive: boolean;
  warnings: Problem[];
  colorChanges: number;
}

const MAX_GCODE_BYTES = 200 * 1024 * 1024;
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const QUOTE_OPEN = ['DRAFT', 'SENT'] as const;
const OPEN_LINES_SHOWN = 20;

@Injectable()
export class OptionConversionService {
  private readonly logger = new Logger(OptionConversionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gcodeParser: GcodeParserService,
    private readonly chunkUploads: ChunkUploadsService,
    private readonly resolver: BomResolverService,
    private readonly planner: ProductionPlannerService,
  ) {}

  // ------------------------------------------------------------------ checks

  /** Checks 1–4: the option is this product's, a size, not live-converted, and has nothing of its own. */
  private async checkOption(db: Db, productId: string, row: OptionRowLite | null): Promise<OptionRowLite> {
    if (!row || row.productId !== productId) throw new NotFoundException('Option not found');
    if (row.kind !== 'SIZE') throw new BadRequestException(`"${row.name}" is a colour — only sizes can become plate layouts`);
    const live = await liveConversion(db, row);
    if (live) {
      const d = live.component.description;
      throw new ConflictException(`"${row.name}" is already converted to ${d} ×${live.unitsPerPlate} — delete that layout under "${d}" → Manage to convert it again`);
    }
    const [components, tiers] = await Promise.all([
      db.productComponent.count({ where: { variantId: row.id } }),
      db.variantPriceTier.count({ where: { variantId: row.id } }),
    ]);
    if (components + tiers > 0) throw new ConflictException(`"${row.name}" has its own components or bulk tiers — it is a real size, not a plate`);
    return row;
  }

  /** Check 5: any component of the product (standard or owned by any size). */
  private async ownedComponent(db: Db, productId: string, componentId: string): Promise<ComponentLite> {
    const c = await db.productComponent.findUnique({
      where: { id: componentId },
      select: { id: true, productId: true, variantId: true, description: true },
    });
    if (!c || c.productId !== productId) throw new NotFoundException('Component not found');
    return c;
  }

  /** Check 8: an ACTIVE ×N already on the part (inactive ones don't count). */
  private async assertNoActive(db: Db, component: ComponentLite, units: number, name: string) {
    const dup = await db.plateLayout.findFirst({ where: { componentId: component.id, unitsPerPlate: units, isActive: true }, select: { id: true } });
    if (dup) throw new ConflictException(`A ×${units} layout already exists for "${component.description}" — deactivate "${name}" instead`);
  }

  /** Check 7: the staged plate G-code, read with keep so the POST (or a retry) can use it again. */
  private async readFile(uploadId: string): Promise<ParsedFile> {
    const f = await this.chunkUploads.consume(uploadId, MAX_GCODE_BYTES, { keep: true });
    const originalname = String(f.originalname || 'plate.gcode');
    if (!/\.(gcode|gco|g)$/.test(originalname.toLowerCase())) throw new BadRequestException('File must be a G-code file (.gcode, .gco, .g)');
    return { buffer: f.buffer, originalname, analysis: this.gcodeParser.parseHeader(f.buffer) };
  }

  /** Checks 1–8 in order, outside any transaction (the file is read and parsed here). */
  private async checkAll(productId: string, variantId: string, input: LayoutConversionInput) {
    const found = await this.prisma.productVariant.findFirst({
      where: { id: variantId, productId },
      select: { id: true, productId: true, kind: true, name: true, convertedLayoutId: true },
    });
    const option = await this.checkOption(this.prisma, productId, found);
    const component = await this.ownedComponent(this.prisma, productId, input.componentId);
    if (input.unitsPerPlate === 1) {
      throw new BadRequestException(`One unit per plate is "${component.description}" itself — deactivate "${option.name}" instead`);
    }
    const file = input.assembledUploadId ? await this.readFile(input.assembledUploadId) : null;
    await this.assertNoActive(this.prisma, component, input.unitsPerPlate, option.name);
    return { option, component, file };
  }

  // ------------------------------------------------------------------- plate

  /** The plate's slots, warnings and recommendation, from `db`'s current configuration. */
  private async draft(db: Db, productId: string, component: ComponentLite, input: LayoutConversionInput, file: ParsedFile | null): Promise<Draft> {
    const config = await this.resolver.requireConfig(productId, undefined, db);
    const rc = resolveInConfig(config, component.variantId, null).components.find((c) => c.componentId === component.id);
    if (!rc) throw new NotFoundException('Component not found');
    const desc = component.description;
    const units = input.unitsPerPlate;
    const parts: PartSlot[] = rc.slots.length
      ? rc.slots.map((s) => ({ colorIndex: s.colorIndex, material: s.material, perUnitGrams: s.gramsPerUnit }))
      : [{ colorIndex: 0, material: null, perUnitGrams: rc.gramsPerUnit }];
    const tools: FileTool[] = (file?.analysis.tools ?? [])
      .filter((t) => (t.filamentGrams ?? 0) > 0)
      .map((t) => ({ index: t.index, colorHex: normaliseHex(t.colorHex), grams: t.filamentGrams ?? 0 }));
    // The catalogue is only needed to colour a multicolour part's filaments that have no hex of their own.
    const needSwatches = rc.isMultiColor && tools.some((t) => t.colorHex) && parts.some((p) => !normaliseHex(p.material?.colorHex));
    const swatches = needSwatches ? await db.filamentCatalog.findMany({ select: { brand: true, colour: true, type: true, hex: true } }) : [];
    const matched = matchPlateSlots(desc, parts, tools, input.plateGrams, swatches);
    const checks = plateChecks(desc, units, input.plateMinutes, input.plateGrams, rc);
    const fileChanges = Math.min(COLOR_CHANGES_BOUNDS.max, Math.max(0, file?.analysis.totalFilamentChanges ?? 0));
    return {
      config, rc, parts,
      slots: matched.slots,
      match: matched.match,
      recommendActive: checks.recommendActive,
      warnings: [...(file ? plateLabelWarnings(desc, file.analysis, units) : []), ...matched.warnings, ...checks.warnings],
      colorChanges: input.colorChanges ?? (file ? fileChanges : 0),
    };
  }

  /** The sizes whose jobs plan this part (the converted option itself is switched off). */
  private appliesTo(config: ProductConfig, component: ComponentLite, variantId: string): string[] {
    if (component.variantId !== null) return [config.options.find((o) => o.id === component.variantId)?.name ?? 'Unknown size'];
    const fallback = optionsOfKind(config, 'SIZE')
      .filter((s) => s.isActive && s.id !== variantId && !config.components.some((c) => c.variantId === s.id))
      .map((s) => s.name);
    return [standardSizeLabel(config), ...fallback];
  }

  /** Open order lines on the option with units left to plan, and its DRAFT/SENT quote lines. */
  private async openLines(productId: string, variantId: string): Promise<LayoutConversionPreview['openLines']> {
    const items = await this.prisma.orderItem.findMany({
      where: {
        productId, OR: [{ sizeOptionId: variantId }, { variantId }],
        order: { status: { in: [...PLANNABLE_ORDER_STATUSES] as OrderStatus[] } },
      },
      select: {
        id: true, productId: true, variantId: true, sizeOptionId: true, colourOptionId: true, quantity: true, description: true,
        order: { select: { orderNumber: true } },
      },
    });
    const { jobsByItem, movesByItem } = await this.planner.loadLineActivity(items.map((i) => i.id));
    const ctx = new CatalogRequestContext();
    const lines: LayoutConversionPreview['openLines']['lines'] = [];
    for (const item of items) {
      const res = await this.resolver.resolveForLine(item, `Order ${item.order.orderNumber}`, ctx);
      if (res.skip || res.pair.sizeOptionId !== variantId) continue;
      const progress = computeLineProgress(item, res.bom, jobsByItem.get(item.id) ?? [], movesByItem.get(item.id) ?? []);
      if (![...progress.components.values()].some((p) => p.remaining > 0)) continue;
      lines.push({ kind: 'ORDER', number: item.order.orderNumber, quantity: item.quantity, partlyPlanned: progress.partlyPlanned });
    }
    const quotes = await this.prisma.quoteItem.findMany({
      where: { sizeOptionId: variantId, quote: { status: { in: [...QUOTE_OPEN] } } },
      select: { quantity: true, quote: { select: { quoteNumber: true } } },
    });
    for (const q of quotes) lines.push({ kind: 'QUOTE', number: q.quote.quoteNumber, quantity: q.quantity, partlyPlanned: false });
    return { total: lines.length, lines: lines.slice(0, OPEN_LINES_SHOWN) };
  }

  // ------------------------------------------------------------------ routes

  /** O8a: what Convert would create and change. Reads only; the staged upload is kept. */
  async preview(productId: string, variantId: string, query: unknown): Promise<LayoutConversionPreview> {
    const input = parseLayoutConversion(query);
    const { component, file } = await this.checkAll(productId, variantId, input);
    const d = await this.draft(this.prisma, productId, component, input, file);
    const option = d.config.options.find((o) => o.id === variantId)!;
    const units = input.unitsPerPlate;
    const plate: PlannerLayout = {
      layoutId: 'new', label: `${component.description} ×${units}`, unitsPerPlate: units,
      plateMinutes: input.plateMinutes, plateGrams: input.plateGrams,
      slotGrams: new Map(d.slots.map((s) => [s.colorIndex, s.gramsUsed])),
    };
    const history = await optionHistory(this.prisma, variantId);
    return {
      option: {
        id: option.id, name: option.name, isActive: option.isActive, legacyPrice: option.basePrice,
        estimatedGrams: option.estimatedGrams, estimatedMinutes: option.estimatedMinutes,
      },
      component: {
        id: component.id, description: component.description, sizeOptionId: component.variantId,
        isMultiColour: d.rc.isMultiColor, gramsPerUnit: d.rc.gramsPerUnit, minutesPerUnit: d.rc.minutesPerUnit,
      },
      layout: {
        name: `×${units}`, unitsPerPlate: units, plateMinutes: input.plateMinutes, plateGrams: input.plateGrams,
        colorChanges: d.colorChanges, source: file ? 'GCODE' : 'MANUAL', objectCount: file ? file.analysis.objectCount : null,
        gcodeFilename: file ? file.originalname.slice(0, 200) : null,
        minutesPerUnit: round3(input.plateMinutes / units), gramsPerUnit: round3(input.plateGrams / units),
        slots: d.slots.map((s, i) => ({
          colorIndex: s.colorIndex, gramsUsed: s.gramsUsed, material: d.parts[i].material,
          colour: { hex: s.colour.hex, source: s.colour.source, swatch: s.colour.swatch }, tools: s.tools,
        })),
      },
      slotMatch: d.match,
      recommendActive: d.recommendActive,
      planning: {
        surplusPolicy: d.config.product.surplusPolicy,
        appliesTo: this.appliesTo(d.config, component, variantId),
        rows: planningRows(d.rc.layouts, plate, units, d.config.product.surplusPolicy, d.parts.map((p) => p.colorIndex)),
      },
      history: { orderLines: history.orderLines, quoteLines: history.quoteLines, jobs: history.jobs },
      openLines: await this.openLines(productId, variantId),
      warnings: d.warnings,
    };
  }

  /** O8: create the plate layout and switch the option off, in one transaction. */
  async convert(productId: string, variantId: string, body: unknown, actor: ConversionActor): Promise<LayoutConversionResult> {
    const input = parseLayoutConversion(body);
    const requested = parseConversionActive(body);
    const { file } = await this.checkAll(productId, variantId, input);

    let stored: StoredFile | null = null;
    if (file) {
      try {
        stored = await writeUploadFile(file.buffer, 'gcode');
      } catch (e) {
        this.logger.error(`Storing a plate G-code for option ${variantId} failed: ${(e as Error)?.message}`, (e as Error)?.stack);
        throw new BadRequestException(STORE_FAILED);
      }
    }

    let out: { layoutId: string; attachmentId: string | null; name: string; warnings: Problem[] };
    try {
      out = await this.prisma.$transaction(async (tx) => {
        const [row] = await lockOptions(tx, [variantId], 'UPDATE');
        const option = await this.checkOption(tx, productId, row ?? null);
        const component = await this.ownedComponent(tx, productId, input.componentId);
        await this.assertNoActive(tx, component, input.unitsPerPlate, option.name);
        const legacy = await tx.productVariant.findUnique({ where: { id: variantId } });
        const d = await this.draft(tx, productId, component, input, file);
        const isActive = requested ?? d.recommendActive;
        const units = input.unitsPerPlate;

        const att = file && stored
          ? await tx.attachment.create({ data: slicerAttachmentData(productId, stored, file.originalname, file.analysis.printerModel), select: { id: true } })
          : null;
        const layout = await tx.plateLayout.create({
          data: {
            componentId: component.id, name: `×${units}`, unitsPerPlate: units, plateMinutes: input.plateMinutes, plateGrams: input.plateGrams,
            colorChanges: d.colorChanges, source: file ? 'GCODE' : 'MANUAL', attachmentId: att?.id ?? null,
            gcodeFilename: file ? file.originalname.slice(0, 200) : null, objectCount: file ? file.analysis.objectCount : null, isActive,
          },
          select: { id: true },
        });
        for (const s of d.slots) await tx.plateLayoutSlot.create({ data: { layoutId: layout.id, colorIndex: s.colorIndex, gramsUsed: s.gramsUsed } });
        await tx.productVariant.update({ where: { id: variantId }, data: { isActive: false, convertedLayoutId: layout.id } });
        await tx.auditLog.create({
          data: {
            userId: actor.id,
            action: 'ProductVariant.convertedToLayout',
            entityType: 'ProductVariant',
            entityId: variantId,
            details: {
              productId, optionName: option.name, wasActive: legacy?.isActive ?? null, legacyPrice: legacy?.basePrice ?? null,
              legacyGrams: legacy?.estimatedGrams ?? null, legacyMinutes: legacy?.estimatedMinutes ?? null,
              previousLayoutId: option.convertedLayoutId ?? null, componentId: component.id, componentDescription: component.description,
              layoutId: layout.id, unitsPerPlate: units, plateMinutes: input.plateMinutes, plateGrams: input.plateGrams,
              source: file ? 'GCODE' : 'MANUAL', attachmentId: att?.id ?? null, isActive, recommendActive: d.recommendActive,
              slotMatch: d.match, warningCodes: d.warnings.map((w) => w.code),
            } satisfies Prisma.InputJsonValue,
          },
        });
        return { layoutId: layout.id, attachmentId: att?.id ?? null, name: option.name, warnings: d.warnings };
      }, TX_OPTS);
    } catch (e) {
      if (stored) await unlinkWritten([stored]);
      throw e;
    }
    if (input.assembledUploadId) await this.chunkUploads.discard(input.assembledUploadId);

    const layout = await this.prisma.plateLayout.findUnique({ where: { id: out.layoutId }, include: { slots: true } });
    const attachment = out.attachmentId
      ? await this.prisma.attachment.findUnique({ where: { id: out.attachmentId }, select: { id: true, originalName: true, filename: true, sizeBytes: true } })
      : null;
    return {
      layout: toLayoutView(layout, attachment),
      option: { id: variantId, name: out.name, isActive: false, convertedLayoutId: out.layoutId },
      warnings: out.warnings,
    };
  }
}
