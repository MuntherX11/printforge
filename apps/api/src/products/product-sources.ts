import type { ComponentSourceModel, SourceModelKind } from '@printforge/types';
import { filamentsFromProjectSettings } from '../file-parser/slicer-filament';
import { printerModelFromProjectSettings } from '../file-parser/printer-model';
import { matchPrinter, type MatchablePrinter } from '../file-parser/printer-match';
import { matchMaterial, slotFilament, type MatchableMaterial } from './slicer-materials';

/**
 * The source model of a part (slicer plan WP4): the STL or OrcaSlicer project
 * the slicer container slices from. Pure helpers — file sniffing, the
 * project's slots and printer, the stored metadata — shared by the upload
 * service, the product page presenter and the slice service.
 *
 * What the upload learnt about a project is kept on the source Attachment's
 * `parsedMetadata` (SourceMeta), so slicing never re-reads a 200 MB zip.
 */

export const SOURCE_MIME: Record<SourceModelKind, string> = { STL: 'model/stl', THREEMF: 'model/3mf' };

/** The oldest OrcaSlicer project format the sidecar's `--load-filaments` path accepts. */
export const MIN_PROJECT_VERSION = [2, 3] as const;

export const OLD_PROJECT_FORMAT_MESSAGE =
  'OLD_PROJECT_FORMAT: This project was saved by an older OrcaSlicer. Open it in your current OrcaSlicer, Save Project As, and upload again.';

export const NOT_A_SOURCE_FILE = 'File must be a binary STL (.stl) or an OrcaSlicer project (.3mf)';

export interface SourceMetaSlot {
  colorIndex: number;
  profile: string | null;
  colorHex: string | null;
  materialId: string | null;
}

/** Attachment.parsedMetadata of a source file. */
export interface SourceMeta {
  printerModel: string | null;
  printerId: string | null;
  slots: SourceMetaSlot[];
}

const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const STL_HEADER = 80;
const STL_TRIANGLE = 50;

/**
 * STL or 3MF by content, confirmed by the extension: a zip is a project only
 * when named `.3mf`; a binary STL either does not start with "solid" or has
 * the triangle count its length says (some exporters write "solid" into the
 * binary header). ASCII STL and anything else → null.
 */
export function sniffSourceKind(buffer: Buffer, originalName: string): SourceModelKind | null {
  const name = String(originalName || '').toLowerCase();
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(ZIP_SIGNATURE)) return name.endsWith('.3mf') ? 'THREEMF' : null;
  if (!name.endsWith('.stl') || buffer.length < STL_HEADER + 4) return null;
  const triangles = buffer.readUInt32LE(STL_HEADER);
  const sized = buffer.length === STL_HEADER + 4 + triangles * STL_TRIANGLE;
  const ascii = buffer.subarray(0, 5).toString('ascii') === 'solid';
  return !ascii || sized ? 'STL' : null;
}

/** `version` of project_settings.config ("2.3.0.0") is at least MIN_PROJECT_VERSION. */
export function isCurrentProjectVersion(version: unknown): boolean {
  if (typeof version !== 'string') return false;
  const parts = version.trim().split('.').map((p) => Number(p));
  if (parts.length < 2 || parts.slice(0, 2).some((n) => !Number.isFinite(n))) return false;
  const [major, minor] = parts;
  const [wantMajor, wantMinor] = MIN_PROJECT_VERSION;
  return major > wantMajor || (major === wantMajor && minor >= wantMinor);
}

/** Current OrcaSlicer projects list their plates in model_settings.config. */
export function hasPlateSection(modelSettings: string | null): boolean {
  return !!modelSettings && /<plate>/.test(modelSettings);
}

/**
 * Slots and printer of a project, from its project_settings.config text: each
 * filament the project names matched to a shop filament (the import matcher),
 * the printer model matched to a printer row. Throws nothing; unreadable
 * settings give no slots and no printer.
 */
export function projectSourceMeta(projectSettings: string, materials: MatchableMaterial[], printers: ReadonlyArray<MatchablePrinter>): SourceMeta {
  const printerModel = printerModelFromProjectSettings(projectSettings);
  const printer = matchPrinter(printerModel, printers);
  const slots = filamentsFromProjectSettings(projectSettings).map((f, i) => {
    const hit = matchMaterial(materials, slotFilament(f.type, f.colorHex, f));
    return { colorIndex: i, profile: f.profile, colorHex: f.colorHex, materialId: hit?.material.id ?? null };
  });
  return { printerModel, printerId: printer?.id ?? null, slots };
}

/** Attachment.parsedMetadata read back defensively (null → an STL's empty meta). */
export function sourceMetaOf(parsed: unknown): SourceMeta {
  const m = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const slots = Array.isArray(m.slots)
    ? m.slots.map((s: any, i: number) => ({
        colorIndex: Number.isInteger(s?.colorIndex) ? s.colorIndex : i,
        profile: typeof s?.profile === 'string' ? s.profile : null,
        colorHex: typeof s?.colorHex === 'string' ? s.colorHex : null,
        materialId: typeof s?.materialId === 'string' ? s.materialId : null,
      }))
    : [];
  return {
    printerModel: typeof m.printerModel === 'string' ? m.printerModel : null,
    printerId: typeof m.printerId === 'string' ? m.printerId : null,
    slots,
  };
}

export interface SourceAttachmentLite {
  id: string;
  originalName: string | null;
  filename: string;
  sizeBytes: number;
  parsedMetadata?: unknown;
}

/** The part's source as the product page sees it, or null when it has none (or its attachment is gone). */
export function sourceModelOf(
  component: { sourceAttachmentId?: string | null; sourceKind?: string | null },
  attachment: SourceAttachmentLite | null | undefined,
): ComponentSourceModel | null {
  if (!component.sourceAttachmentId || !attachment) return null;
  const kind: SourceModelKind = component.sourceKind === 'THREEMF' ? 'THREEMF' : 'STL';
  const meta = sourceMetaOf(attachment.parsedMetadata);
  return {
    attachmentId: attachment.id,
    kind,
    filename: attachment.originalName || attachment.filename,
    sizeBytes: attachment.sizeBytes,
    slots: kind === 'THREEMF' ? meta.slots : [],
    printerId: kind === 'THREEMF' ? meta.printerId : null,
    printerModel: kind === 'THREEMF' ? meta.printerModel : null,
  };
}
