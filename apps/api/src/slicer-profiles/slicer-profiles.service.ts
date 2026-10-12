import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  SlicerProfileKind,
  STOCK_PROFILE_SUFFIX,
  type CreateStockProfileDto,
  type MaterialType,
  type SlicerBundleImportResult,
  type SlicerHealth,
  type SlicerProfileDto,
  type SlicerStockPresetList,
} from '@printforge/types';
import { PrismaService } from '../common/prisma/prisma.service';
import { BundleError, parseBundle, type ParsedPreset, type PresetJson } from './bundle-import';
import type { SlicerProfilePatch } from './profile-input';
import { SidecarClient } from './sidecar.client';

/**
 * Orca presets the owner exported, stored exactly as exported and mapped to a
 * printer (MACHINE: the printer it drives; PROCESS: the printer it is the
 * default for) or a shop filament (FILAMENT). The slice processor reads them
 * through `machineFor` / `defaultProcessFor` / `filamentFor`.
 *
 * A preset that ships with OrcaSlicer needs no export: it is stored as a thin
 * reference `{ name: "<stock name> (stock)", inherits: "<stock name>", from: "User" }`
 * that the slicer container flattens like any other preset. The name differs
 * from the parent's on purpose: a preset inheriting its own name is a cycle.
 *
 *   filament to slice ──▶ preset mapped to it? ──yes──▶ that preset
 *                              │ no
 *                              ▼
 *                    main preset for its type? ──yes──▶ the main preset
 *                              │ no
 *                              ▼
 *                            null (NO_FILAMENT_PROFILE)
 */

interface ProfileRow {
  id: string;
  kind: SlicerProfileKind;
  name: string;
  json: unknown;
  printerId: string | null;
  materialId: string | null;
  materialType?: string | null;
  isDefault: boolean;
  updatedAt: Date;
}

const STOCK_KEYS = ['name', 'inherits', 'from'];

/** A stock reference carries nothing of its own: only name / inherits / from. */
export function isStockReference(json: unknown): boolean {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
  const preset = json as Record<string, unknown>;
  return typeof preset.inherits === 'string' && preset.inherits.length > 0 && Object.keys(preset).every((k) => STOCK_KEYS.includes(k));
}

const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;

@Injectable()
export class SlicerProfilesService {
  private readonly logger = new Logger(SlicerProfilesService.name);

  constructor(private readonly prisma: PrismaService, private readonly sidecar: SidecarClient) {}

  async list(): Promise<SlicerProfileDto[]> {
    const rows = await this.prisma.slicerProfile.findMany({ orderBy: [{ kind: 'asc' }, { name: 'asc' }] });
    return rows.map((r) => this.toDto(r as ProfileRow));
  }

  health(): Promise<SlicerHealth> {
    return this.sidecar.health();
  }

  /**
   * Import an .orca_printer / .orca_filament bundle: upsert each preset by
   * (kind, name). Replacing a preset keeps its printer / filament mapping and
   * default flag — only the JSON changes. The sidecar chain check runs when
   * the container answers; otherwise `check` is null and the check is
   * deferred to the first slice.
   */
  async importBundle(file: Express.Multer.File | undefined): Promise<SlicerBundleImportResult> {
    if (!file?.buffer?.length) throw new BadRequestException('No file uploaded');
    if (file.buffer.length > MAX_BUNDLE_BYTES) throw new BadRequestException('Bundle is larger than 20 MB');

    let parsed: Awaited<ReturnType<typeof parseBundle>>;
    try {
      parsed = await parseBundle(file.buffer);
    } catch (err) {
      if (err instanceof BundleError) throw new BadRequestException(err.message);
      throw err;
    }

    const result: SlicerBundleImportResult = { imported: [], skipped: parsed.skipped, check: null };
    for (const preset of parsed.presets) {
      const row = await this.upsertPreset(preset);
      result.imported.push({ id: row.id, kind: preset.kind, name: preset.name, replaced: row.replaced });
    }
    this.logger.log(`Imported ${result.imported.length} slicer preset(s), skipped ${result.skipped.length}`);

    if (parsed.presets.length > 0) {
      result.check = await this.sidecar.checkProfiles(parsed.presets.map(({ kind, name, json }) => ({ kind, name, json })));
    }
    return result;
  }

  /** Search the presets bundled with OrcaSlicer. The sidecar down → an empty list and `reachable: false`. */
  async listStock(kind: SlicerProfileKind, q: string): Promise<SlicerStockPresetList> {
    const presets = await this.sidecar.listStock(kind, q);
    return presets === null ? { presets: [], reachable: false } : { presets, reachable: true };
  }

  /**
   * Store a reference to the stock preset `name` (upsert by kind and stored
   * name, so adding it twice keeps its mapping). The sidecar confirms the
   * preset exists first: a reference to nothing would only fail at slice time.
   */
  async createStock(input: CreateStockProfileDto): Promise<SlicerProfileDto> {
    const exists = await this.sidecar.hasStock(input.kind, input.name);
    if (exists === null) throw new BadRequestException('The slicer is offline');
    if (!exists) throw new BadRequestException('The slicer has no stock preset with that name');

    const name = `${input.name}${STOCK_PROFILE_SUFFIX}`;
    const { id } = await this.upsertPreset({ kind: input.kind, name, json: { name, inherits: input.name, from: 'User' } });
    const row = await this.prisma.slicerProfile.findUnique({ where: { id } });
    return this.toDto(row as ProfileRow);
  }

  private async upsertPreset(preset: Pick<ParsedPreset, 'kind' | 'name' | 'json'>): Promise<{ id: string; replaced: boolean }> {
    const where = { kind_name: { kind: preset.kind, name: preset.name } };
    const existing = await this.prisma.slicerProfile.findUnique({ where, select: { id: true } });
    const json = preset.json as Prisma.InputJsonValue;
    if (existing) {
      await this.prisma.slicerProfile.update({ where: { id: existing.id }, data: { json } });
      return { id: existing.id, replaced: true };
    }
    const created = await this.prisma.slicerProfile.create({
      data: { kind: preset.kind, name: preset.name, json },
      select: { id: true },
    });
    return { id: created.id, replaced: false };
  }

  async update(id: string, patch: SlicerProfilePatch): Promise<SlicerProfileDto> {
    const row = (await this.prisma.slicerProfile.findUnique({ where: { id } })) as ProfileRow | null;
    if (!row) throw new NotFoundException('Slicer profile not found');

    const data: { printerId?: string | null; materialId?: string | null; materialType?: MaterialType | null; isDefault?: boolean } = {};

    if (patch.printerId !== undefined) {
      if (row.kind === SlicerProfileKind.FILAMENT) throw new BadRequestException('A filament preset maps to a filament, not a printer');
      if (patch.printerId !== null) {
        const printer = await this.prisma.printer.findUnique({ where: { id: patch.printerId }, select: { id: true } });
        if (!printer) throw new NotFoundException('Printer not found');
      }
      data.printerId = patch.printerId;
    }

    if (patch.materialId !== undefined) {
      if (row.kind !== SlicerProfileKind.FILAMENT) throw new BadRequestException('Only a filament preset maps to a filament');
      if (patch.materialId !== null) {
        const material = await this.prisma.material.findUnique({ where: { id: patch.materialId }, select: { id: true } });
        if (!material) throw new NotFoundException('Filament not found');
      }
      data.materialId = patch.materialId;
    }

    if (patch.materialType !== undefined) {
      if (row.kind !== SlicerProfileKind.FILAMENT) throw new BadRequestException('Only a filament preset can be the main preset for a filament type');
      data.materialType = patch.materialType;
    }

    const printerAfter = data.printerId !== undefined ? data.printerId : row.printerId;
    if (patch.isDefault !== undefined) {
      if (row.kind !== SlicerProfileKind.PROCESS) throw new BadRequestException('Only a process preset can be a printer\'s default');
      if (patch.isDefault && !printerAfter) throw new BadRequestException('Choose the printer first, then make the preset its default');
      data.isDefault = patch.isDefault;
    }
    // A process preset losing its printer cannot stay that printer's default.
    if (row.kind === SlicerProfileKind.PROCESS && printerAfter === null) data.isDefault = false;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (data.isDefault === true) {
        await tx.slicerProfile.updateMany({
          where: { kind: SlicerProfileKind.PROCESS, printerId: printerAfter!, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }
      // One main preset per filament type: the type moves here from whichever preset had it.
      if (data.materialType) {
        await tx.slicerProfile.updateMany({
          where: { kind: SlicerProfileKind.FILAMENT, materialType: data.materialType, id: { not: id } },
          data: { materialType: null },
        });
      }
      return tx.slicerProfile.update({ where: { id }, data });
    });
    return this.toDto(updated as ProfileRow);
  }

  /** 409 while the preset is mapped: unmap it first so a slice never loses its profile silently. */
  async remove(id: string): Promise<{ deleted: true }> {
    const row = (await this.prisma.slicerProfile.findUnique({ where: { id } })) as ProfileRow | null;
    if (!row) throw new NotFoundException('Slicer profile not found');
    if (row.printerId || row.materialId) {
      throw new ConflictException(`"${row.name}" is still mapped — unmap it before deleting`);
    }
    if (row.materialType) {
      throw new ConflictException(`"${row.name}" is the main preset for ${row.materialType}. Clear that before deleting`);
    }
    await this.prisma.slicerProfile.delete({ where: { id } });
    return { deleted: true };
  }

  // ─── Helpers for the slice processor ───────────────────────────────────────

  /** The raw MACHINE preset mapped to this printer, or null. */
  async machineFor(printerId: string): Promise<PresetJson | null> {
    const row = await this.prisma.slicerProfile.findFirst({
      where: { kind: SlicerProfileKind.MACHINE, printerId },
      orderBy: { updatedAt: 'desc' },
      select: { json: true },
    });
    return (row?.json as PresetJson | undefined) ?? null;
  }

  /** The raw PROCESS preset that is this printer's default, or null. */
  async defaultProcessFor(printerId: string): Promise<PresetJson | null> {
    const row = await this.prisma.slicerProfile.findFirst({
      where: { kind: SlicerProfileKind.PROCESS, printerId, isDefault: true },
      select: { json: true },
    });
    return (row?.json as PresetJson | undefined) ?? null;
  }

  /**
   * The raw FILAMENT preset this shop filament is sliced with: the preset
   * mapped to it, else the main preset for its material type, else null.
   */
  async filamentFor(materialId: string): Promise<PresetJson | null> {
    const own = await this.prisma.slicerProfile.findFirst({
      where: { kind: SlicerProfileKind.FILAMENT, materialId },
      orderBy: { updatedAt: 'desc' },
      select: { json: true },
    });
    if (own) return own.json as PresetJson;

    const material = await this.prisma.material.findUnique({ where: { id: materialId }, select: { type: true } });
    if (!material?.type) return null;
    const main = await this.prisma.slicerProfile.findFirst({
      where: { kind: SlicerProfileKind.FILAMENT, materialType: material.type },
      select: { json: true },
    });
    return (main?.json as PresetJson | undefined) ?? null;
  }

  private toDto(row: ProfileRow): SlicerProfileDto {
    const json = (row.json ?? {}) as Record<string, unknown>;
    const inherits = typeof json.inherits === 'string' && json.inherits.trim() ? json.inherits.trim() : null;
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      inherits,
      printerId: row.printerId ?? null,
      materialId: row.materialId ?? null,
      materialType: (row.materialType as MaterialType | null | undefined) ?? null,
      isDefault: !!row.isDefault,
      stock: isStockReference(row.json),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }
}
