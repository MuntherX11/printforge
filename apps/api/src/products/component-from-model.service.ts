import { BadRequestException, ConflictException, forwardRef, HttpException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SLOT_KEYS, SliceErrorCode, type ComponentFromModelResult, type SlotKey } from '@printforge/types';
import { decideImportLinks, type LinkComponent } from '../catalog-core/colour-link-proposal';
import { ChunkUploadsService } from '../chunk-uploads/chunk-uploads.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { allowedBody } from '../common/utils/validate-number';
import { SliceService } from '../slice/slice.service';
import { isMultiColourComponent } from '../stock-ledger/colour-key';
import { CONVERTED_BLOCKER, CONVERTED_TAIL, liveConversion } from './option-conversion-rules';
import { rescaleSlotGrams } from './product-components.service';
import { GRAMS, MINUTES, stripHtml } from './product-input';
import { lockOptions, TX_OPTS } from './product-locks';
import { ProductSourcesService } from './product-sources.service';
import { sourceModelOf, type SourceMeta } from './product-sources';
import { unlinkWritten, type StoredFile } from './slicer-files';

/**
 * A part made from its model alone (ADMIN only): the owner uploads an
 * STL or an OrcaSlicer project, names the part and picks a filament per slot;
 * the part is created with the file as its source and the 1-unit validation
 * slice is queued. Grams and minutes are not known until that slice comes
 * back, so the part starts with the smallest values the manual create path
 * accepts (PLACEHOLDER_*), split evenly over its colours, and is marked
 * `pendingFirstSlice`: its cost is incomplete and no price is written from it.
 * The slice processor overwrites the numbers and clears the mark.
 *
 * Order: every check the slice makes runs first (400, nothing created, the
 * staged upload kept); the upload is then claimed (409 for a second request);
 * the part is committed; after that nothing fails the request.
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

/** What went wrong, for the owner: an HTTP error's sentence without its code; anything else is not shown raw. */
export function plainReason(e: unknown): string {
  if (e instanceof HttpException) {
    const raw = (e.getResponse() as any)?.message ?? e.message;
    return withoutErrorCode(String(Array.isArray(raw) ? raw.join(', ') : raw));
  }
  return 'an unexpected error. Open the part and slice it again';
}

const slotNumber = (key: string) => Number(key) + 1;

@Injectable()
export class ComponentFromModelService {
  private readonly logger = new Logger(ComponentFromModelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chunkUploads: ChunkUploadsService,
    private readonly sources: ProductSourcesService,
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

    // Everything the first slice needs, before anything is created: a missing
    // profile is a 400 here (the staged upload stays, so the owner can fix
    // Settings and retry), not a part priced on placeholder numbers.
    const chosen = Object.fromEntries(slotKeys.map((k) => [k, materialOf(k)])) as Partial<Record<SlotKey, string>>;
    await this.slice.assertSliceable({ kind: model.kind, meta: model.meta, printerId, defaultPrinterId: null, materials: chosen });

    // The owner's filament per slot is what later slices fall back to, not the file's own match.
    const meta: SourceMeta = isProject
      ? { ...model.meta, slots: model.meta.slots.map((s) => ({ ...s, materialId: input.materials[String(s.colorIndex) as SlotKey] ?? s.materialId })) }
      : model.meta;
    const multi = isProject && slotKeys.length > 1;
    const slotGrams = rescaleSlotGrams(slotKeys.map((k) => ({ colorIndex: Number(k), gramsUsed: 0 })), PLACEHOLDER_GRAMS);

    // One request per staged upload: a second POST naming it is refused (409) instead of making a second part.
    await this.chunkUploads.claim(input.assembledUploadId);
    let stored: StoredFile | null = null;
    let out: { componentId: string; attachment: any };
    try {
      stored = await this.sources.writeSourceFile(model, `a new part of product ${productId}`);
      const file = stored;
      out = await this.prisma.$transaction(async (tx: any) => {
        const size = await this.sizeOf(tx, productId, input.variantId);
        const variantId = size?.id ?? null;
        const last = await tx.productComponent.findFirst({ where: { productId, variantId }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
        const link = await this.linkDecisions(tx, productId, size, input.description, multi, slotKeys.map((k) => ({ colorIndex: Number(k), materialId: materialOf(k) })));
        const comp = await tx.productComponent.create({
          data: {
            productId, variantId, materialId: multi ? null : materialOf(slotKeys[0]), description: input.description,
            gramsUsed: PLACEHOLDER_GRAMS, printMinutes: PLACEHOLDER_MINUTES, quantity: 1, sortOrder: (last?.sortOrder ?? -1) + 1,
            isMultiColor: multi, colorChanges: 0, stockConfirmedAt: new Date(), pendingFirstSlice: true,
            colourSlotId: multi ? null : link(Number(slotKeys[0])).colourSlotId, colourFixed: multi ? null : link(Number(slotKeys[0])).colourFixed,
          },
          select: { id: true },
        });
        if (multi) {
          for (const s of slotGrams) {
            await tx.componentMaterial.create({
              data: {
                componentId: comp.id, materialId: materialOf(String(s.colorIndex) as SlotKey), gramsUsed: s.gramsUsed,
                colorIndex: s.colorIndex, sortOrder: s.colorIndex, ...link(s.colorIndex),
              },
            });
          }
        }
        const attachment = await this.sources.linkSource(tx, productId, comp.id, file, model, meta);
        return { componentId: comp.id, attachment };
      }, TX_OPTS);
    } catch (e) {
      if (stored) await unlinkWritten([stored]);
      await this.chunkUploads.release(input.assembledUploadId);
      throw e;
    }

    // The part exists from here on: nothing below may fail the request, or the
    // dialog would offer a retry of an upload that is gone. No reprice either:
    // the part is not measured, and the slice processor reprices when it is.
    const source = sourceModelOf({ sourceAttachmentId: out.attachment.id, sourceKind: model.kind }, out.attachment)!;
    try {
      await this.chunkUploads.discard(input.assembledUploadId);
      const validationRun = await this.slice.create(productId, out.componentId, { printerId, materials: chosen, units: 1 }, true);
      return { componentId: out.componentId, source, validationRun, notice: null };
    } catch (e) {
      const reason = plainReason(e);
      this.logger.warn(`Part ${out.componentId} was added from its model but its first slice was not queued: ${(e as Error)?.message ?? reason}`);
      return { componentId: out.componentId, source, validationRun: null, notice: `The part was added but the first slice could not be queued: ${reason}` };
    }
  }

  /**
   * The colour-slot link of each of the new part's colours, decided the way
   * product onboarding decides them for an imported part (decideImportLinks):
   * by filament, then by position on a size; a product without colour slots
   * leaves everything unlinked.
   */
  private async linkDecisions(
    tx: any, productId: string, size: { id: string; name: string } | null, description: string, multi: boolean,
    slots: Array<{ colorIndex: number; materialId: string }>,
  ): Promise<(colorIndex: number) => { colourSlotId: string | null; colourFixed: boolean | null }> {
    const none = { colourSlotId: null, colourFixed: null };
    const colourSlots = await tx.productColourSlot.findMany({ where: { productId }, select: { id: true, name: true } });
    if (!colourSlots.length) return () => none;
    const product = await tx.product.findUnique({ where: { id: productId }, select: { baseOptionLabel: true } });
    const existing: any[] = await tx.productComponent.findMany({ where: { productId }, include: { materials: true } });
    const linkInput: LinkComponent[] = existing.map((c) => ({
      id: c.id, description: c.description, variantId: c.variantId ?? null, sortOrder: c.sortOrder, createdAt: c.createdAt,
      isMultiColor: isMultiColourComponent(c),
      slots: isMultiColourComponent(c)
        ? c.materials.map((m: any) => ({ colorIndex: m.colorIndex, materialId: m.materialId, colourSlotId: m.colourSlotId ?? null, colourFixed: m.colourFixed ?? null }))
        : c.materialId ? [{ colorIndex: 0, materialId: c.materialId, colourSlotId: c.colourSlotId ?? null, colourFixed: c.colourFixed ?? null }] : [],
    }));
    const ids = [...new Set([...slots.map((s) => s.materialId), ...linkInput.flatMap((c) => c.slots.map((s) => s.materialId))])];
    const materials: Array<{ id: string; name: string; type: string }> = await tx.material.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, type: true } });
    const rank = existing.filter((c) => (c.variantId ?? null) === (size?.id ?? null)).length;
    const { decisions } = decideImportLinks({
      newSlots: slots.map((s) => ({
        componentKey: 'new', description, colorIndex: s.colorIndex, materialId: s.materialId,
        materialType: String(materials.find((m) => m.id === s.materialId)?.type ?? 'OTHER'), isMultiColor: multi, rank,
      })),
      existing: linkInput, colourSlots,
      materials: new Map(materials.map((m) => [m.id, { name: m.name, type: String(m.type) }])),
      targetSize: size, standardSizeLabel: product?.baseOptionLabel ?? 'Standard',
    });
    return (colorIndex) => {
      const d = decisions.find((x) => x.colorIndex === colorIndex);
      return d ? { colourSlotId: d.colourSlotId, colourFixed: d.colourFixed } : none;
    };
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
  private async sizeOf(tx: any, productId: string, variantId: string | null): Promise<{ id: string; name: string } | null> {
    if (!variantId) return null;
    const [row] = await lockOptions(tx, [variantId], 'SHARE');
    if (!row || row.productId !== productId) throw new NotFoundException('Size not found');
    if (row.kind === 'COLOUR') throw new BadRequestException("Colours use each size's components — add the component to a size");
    if (await liveConversion(tx, row)) throw new ConflictException(CONVERTED_BLOCKER(row.name, CONVERTED_TAIL.components));
    return { id: row.id, name: row.name };
  }
}
