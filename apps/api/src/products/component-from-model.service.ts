import { BadRequestException, ConflictException, forwardRef, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { SLOT_KEYS, SliceErrorCode, type ComponentFromModelResult, type SliceRunDto, type SlotKey } from '@printforge/types';
import { ChunkUploadsService } from '../chunk-uploads/chunk-uploads.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { allowedBody } from '../common/utils/validate-number';
import { SliceService } from '../slice/slice.service';
import { CONVERTED_BLOCKER, CONVERTED_TAIL, liveConversion } from './option-conversion-rules';
import { rescaleSlotGrams } from './product-components.service';
import { GRAMS, MINUTES, stripHtml } from './product-input';
import { lockOptions, TX_OPTS } from './product-locks';
import { ProductSourcesService } from './product-sources.service';
import { sourceModelOf, type SourceMeta } from './product-sources';
import { ProductsService } from './products.service';
import { unlinkWritten } from './slicer-files';

/**
 * A part made from its model alone (ADMIN only): the owner uploads an
 * STL or an OrcaSlicer project, names the part and picks a filament per slot;
 * the part is created with the file as its source and the 1-unit validation
 * slice is queued. Grams and minutes are not known until that slice comes
 * back, so the part starts with the smallest values the manual create path
 * accepts (PLACEHOLDER_*), split evenly over its colours, and the slice
 * processor overwrites them.
 *
 *  STL             → one filament ("0"), the printer asked for or the product's
 *  project, 1 slot → single-material part on the project's printer
 *  project, 2+     → multicolour part, one ComponentMaterial per slot — the
 *                    shape product-onboarding gives a sliced multicolour 3MF
 */

export const PLACEHOLDER_GRAMS = GRAMS.min;
export const PLACEHOLDER_MINUTES = MINUTES.min;
const DESCRIPTION_MAX = 120;

export interface ComponentFromModelInput {
  assembledUploadId: string;
  description: string;
  printerId: string | null;
  materials: Partial<Record<SlotKey, string>>;
  variantId: string | null;
}

function id(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 64) throw new BadRequestException(`"${field}" must be an id`);
  return raw.trim();
}

const blank = (v: unknown) => v === undefined || v === null || v === '';

/** Allowlist parser for `POST /products/:id/components/from-model` (decision 28). */
export function parseComponentFromModel(raw: unknown): ComponentFromModelInput {
  const b = allowedBody(raw, ['assembledUploadId', 'description', 'printerId', 'materials', 'variantId']);
  if (blank(b.assembledUploadId)) throw new BadRequestException('"assembledUploadId" is required');
  const description = typeof b.description === 'string' ? stripHtml(b.description) : '';
  if (!description || description.length > DESCRIPTION_MAX) throw new BadRequestException(`"description" must be 1 to ${DESCRIPTION_MAX} characters`);
  if (!b.materials || typeof b.materials !== 'object' || Array.isArray(b.materials)) throw new BadRequestException('"materials" must be an object');
  const materials: Partial<Record<SlotKey, string>> = {};
  for (const [k, v] of Object.entries(b.materials as Record<string, unknown>)) {
    if (!(SLOT_KEYS as readonly string[]).includes(k)) throw new BadRequestException(`"materials" keys must be slot numbers ${SLOT_KEYS.join(', ')}`);
    materials[k as SlotKey] = id(v, `materials[${k}]`);
  }
  return {
    assembledUploadId: id(b.assembledUploadId, 'assembledUploadId'),
    description,
    printerId: blank(b.printerId) ? null : id(b.printerId, 'printerId'),
    materials,
    variantId: blank(b.variantId) ? null : id(b.variantId, 'variantId'),
  };
}

/** "NO_FILAMENT_PROFILE: “PLA Black” has no filament profile…" → the sentence alone. */
export function withoutErrorCode(message: string): string {
  return message.replace(/^[A-Z][A-Z0-9_]*:\s*/, '');
}

const slotNumber = (key: string) => Number(key) + 1;

@Injectable()
export class ComponentFromModelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chunkUploads: ChunkUploadsService,
    private readonly sources: ProductSourcesService,
    private readonly products: ProductsService,
    @Inject(forwardRef(() => SliceService)) private readonly slice: SliceService,
  ) {}

  /** POST /products/:id/components/from-model */
  async create(productId: string, body: unknown): Promise<ComponentFromModelResult> {
    const input = parseComponentFromModel(body);
    const product = await this.prisma.product.findUnique({ where: { id: productId }, select: { id: true, defaultPrinterId: true } });
    if (!product) throw new NotFoundException('Product not found');
    const model = await this.sources.readStaged(input.assembledUploadId);
    const isProject = model.kind === 'THREEMF';

    const slotKeys = this.slotKeys(isProject, model.meta);
    const extra = Object.keys(input.materials).find((k) => !slotKeys.includes(k as SlotKey));
    if (extra) {
      throw new BadRequestException(isProject ? `Slot ${slotNumber(extra)} is not used by this project` : 'An STL part takes one filament: "materials" must name slot "0" only');
    }
    const missing = slotKeys.find((k) => !input.materials[k]);
    if (missing) throw new BadRequestException(`${SliceErrorCode.SLOT_UNMAPPED}: Slot ${slotNumber(missing)} has no filament`);
    const materialOf = (k: SlotKey) => input.materials[k]!;
    const found = await this.prisma.material.findMany({ where: { id: { in: slotKeys.map(materialOf) } }, select: { id: true } });
    const gone = slotKeys.find((k) => !found.some((m: { id: string }) => m.id === materialOf(k)));
    if (gone) throw new BadRequestException(`${SliceErrorCode.SLOT_UNMAPPED}: Slot ${slotNumber(gone)} names a filament that no longer exists`);

    const printerId = isProject ? model.meta.printerId : input.printerId ?? product.defaultPrinterId ?? null;
    if (!printerId) {
      throw new BadRequestException(
        !isProject ? 'Choose a printer — this product has no default printer'
          : model.meta.printerModel ? `This project is for ${model.meta.printerModel}, which matches none of your printers`
            : 'This project does not name a printer',
      );
    }

    // The owner's filament per slot is what later slices fall back to, not the file's own match.
    const meta: SourceMeta = isProject
      ? { ...model.meta, slots: model.meta.slots.map((s) => ({ ...s, materialId: input.materials[String(s.colorIndex) as SlotKey] ?? s.materialId })) }
      : model.meta;
    const multi = isProject && slotKeys.length > 1;
    const slotGrams = rescaleSlotGrams(slotKeys.map((k) => ({ colorIndex: Number(k), gramsUsed: 0 })), PLACEHOLDER_GRAMS);

    const stored = await this.sources.writeSourceFile(model, `a new part of product ${productId}`);
    let out: { componentId: string; attachment: any };
    try {
      out = await this.prisma.$transaction(async (tx: any) => {
        const variantId = await this.sizeOf(tx, productId, input.variantId);
        const last = await tx.productComponent.findFirst({ where: { productId, variantId }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
        const comp = await tx.productComponent.create({
          data: {
            productId, variantId, materialId: multi ? null : materialOf(slotKeys[0]), description: input.description,
            gramsUsed: PLACEHOLDER_GRAMS, printMinutes: PLACEHOLDER_MINUTES, quantity: 1, sortOrder: (last?.sortOrder ?? -1) + 1,
            isMultiColor: multi, colorChanges: 0, stockConfirmedAt: new Date(), colourSlotId: null, colourFixed: null,
          },
          select: { id: true },
        });
        if (multi) {
          for (const s of slotGrams) {
            await tx.componentMaterial.create({
              data: {
                componentId: comp.id, materialId: materialOf(String(s.colorIndex) as SlotKey), gramsUsed: s.gramsUsed,
                colorIndex: s.colorIndex, sortOrder: s.colorIndex, colourSlotId: null, colourFixed: null,
              },
            });
          }
        }
        const attachment = await this.sources.linkSource(tx, productId, comp.id, stored, model, meta);
        return { componentId: comp.id, attachment };
      }, TX_OPTS);
    } catch (e) {
      await unlinkWritten([stored]);
      throw e;
    }
    await this.chunkUploads.discard(input.assembledUploadId);
    await this.products.reprice(productId);

    const source = sourceModelOf({ sourceAttachmentId: out.attachment.id, sourceKind: model.kind }, out.attachment)!;
    const validation = await this.queueValidation(productId, out.componentId, printerId, Object.fromEntries(slotKeys.map((k) => [k, materialOf(k)])));
    return { componentId: out.componentId, source, ...validation };
  }

  /** The slots a filament is needed for: the project's own (at most four), "0" for an STL or a project naming none. */
  private slotKeys(isProject: boolean, meta: SourceMeta): SlotKey[] {
    if (!isProject || !meta.slots.length) return ['0'];
    const keys = meta.slots.map((s) => String(s.colorIndex));
    if (keys.some((k) => !(SLOT_KEYS as readonly string[]).includes(k))) {
      throw new BadRequestException(`This project uses ${keys.length} filaments — at most ${SLOT_KEYS.length} can be sliced`);
    }
    return keys as SlotKey[];
  }

  /** The SIZE option that owns the part (the rules of P9), or null for the standard size. */
  private async sizeOf(tx: any, productId: string, variantId: string | null): Promise<string | null> {
    if (!variantId) return null;
    const [row] = await lockOptions(tx, [variantId], 'SHARE');
    if (!row || row.productId !== productId) throw new NotFoundException('Size not found');
    if (row.kind === 'COLOUR') throw new BadRequestException("Colours use each size's components — add the component to a size");
    if (await liveConversion(tx, row)) throw new ConflictException(CONVERTED_BLOCKER(row.name, CONVERTED_TAIL.components));
    return row.id;
  }

  /** The 1-unit validation slice; when it cannot be queued the part stays and the notice says why. */
  private async queueValidation(
    productId: string, componentId: string, printerId: string, materials: Record<string, string>,
  ): Promise<{ validationRun: SliceRunDto | null; notice: string | null }> {
    try {
      return { validationRun: await this.slice.create(productId, componentId, { printerId, materials, units: 1 }, true), notice: null };
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      const raw = (e.getResponse() as any)?.message ?? e.message;
      return { validationRun: null, notice: withoutErrorCode(String(Array.isArray(raw) ? raw.join(', ') : raw)) };
    }
  }
}
