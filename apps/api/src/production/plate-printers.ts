import type { PlatePrinterSuggestion, PrinterRef, Problem } from '@printforge/types';
import { matchPrinter, noMatchingPrinter, type MatchablePrinter } from '../file-parser/printer-match';

/**
 * The printer a job or plan row defaults to (owner spec 2026-10-02 item 6):
 * the farm printer matched to the printer its plates' files were sliced for —
 * the plate printed most often first — else the product's pricing printer.
 * When a file names a printer nobody matches, a warning says so.
 */

type Db = any;

export interface PlateFileRef {
  attachmentId?: string | null;
  plateCount: number;
}

export class PlatePrinterLookup {
  private constructor(
    private readonly slicedFor: ReadonlyMap<string, string | null>,
    private readonly printers: ReadonlyArray<MatchablePrinter>,
  ) {}

  /** One query for the files' sliced-for printers, one for the active printers. */
  static async load(db: Db, attachmentIds: Array<string | null | undefined>): Promise<PlatePrinterLookup> {
    const ids = [...new Set(attachmentIds.filter((x): x is string => !!x))];
    const rows: Array<{ id: string; slicedForPrinter: string | null }> = ids.length
      ? await db.attachment.findMany({ where: { id: { in: ids } }, select: { id: true, slicedForPrinter: true } })
      : [];
    const printers: MatchablePrinter[] = ids.length
      ? await db.printer.findMany({ where: { isActive: true }, select: { id: true, name: true, model: true, isActive: true } })
      : [];
    return new PlatePrinterLookup(new Map(rows.map((r) => [r.id, r.slicedForPrinter ?? null])), printers);
  }

  suggest(plates: ReadonlyArray<PlateFileRef>, fallback: PrinterRef | null): PlatePrinterSuggestion & { warning: Problem | null } {
    let unmatched: string | null = null;
    for (const p of [...plates].sort((a, b) => b.plateCount - a.plateCount)) {
      const model = p.attachmentId ? this.slicedFor.get(p.attachmentId) ?? null : null;
      if (!model) continue;
      const printer = matchPrinter(model, this.printers);
      if (printer) return { printerId: printer.id, printerName: printer.name, slicedFor: model, fromFile: true, warning: null };
      unmatched ??= model;
    }
    return {
      printerId: fallback?.id ?? null,
      printerName: fallback?.name ?? null,
      slicedFor: unmatched,
      fromFile: false,
      warning: unmatched ? { code: 'PRINTER_NOT_MATCHED', message: noMatchingPrinter(unmatched) } : null,
    };
  }
}

/** J1 without a printerId: the printer the plates' files were sliced for, else the pricing printer. */
export async function defaultJobPrinter(db: Db, plates: ReadonlyArray<PlateFileRef>, fallbackId: string | null): Promise<string | null> {
  if (!plates.length) return fallbackId;
  const s = (await PlatePrinterLookup.load(db, plates.map((p) => p.attachmentId))).suggest(plates, null);
  return s.fromFile ? s.printerId : fallbackId;
}
