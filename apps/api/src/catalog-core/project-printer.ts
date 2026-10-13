import { matchPrinter, type MatchablePrinter } from '../file-parser/printer-match';
import { sourceMetaOf, type SourceMeta } from '../products/product-sources';
import { isMultiColourComponent } from '../stock-ledger/colour-key';
import type { ComponentRow, ProductConfig } from './catalog-config';

/**
 * The printer lock of a multi-colour 3MF project (owner decision 2026-10-13):
 * such a part prints on the printer its project names and on no other, in an
 * order's print plan and in every job plan. A one-slot project is not locked:
 * only its shape is used.
 *
 * The lock is read when a product's configuration is loaded, so the planners
 * stay pure: `applyProjectPrinters` puts the printer on the component row and
 * the resolver gives it to every plate of the part that names none.
 */

type Db = { attachment?: { findMany: (args: any) => Promise<any[]> }; printer?: { findMany: (args: any) => Promise<any[]> } };

/** A project part that prints in several colours: two or more slots in the project, or a multi-colour part. */
export function isMultiColourProject(c: Pick<ComponentRow, 'sourceKind' | 'isMultiColor' | 'materialId' | 'materials'>, meta: SourceMeta | null): boolean {
  if (c.sourceKind !== 'THREEMF') return false;
  return (meta?.slots.length ?? 0) >= 2 || isMultiColourComponent(c);
}

/** The farm printer a project is set up for: matched by the model it names, else the one matched at upload. Active printers only. */
export function projectPrinterOf<P extends MatchablePrinter>(meta: Pick<SourceMeta, 'printerModel' | 'printerId'>, printers: ReadonlyArray<P>): P | null {
  const active = printers.filter((p) => p.isActive !== false);
  return matchPrinter(meta.printerModel, active) ?? active.find((p) => p.id === meta.printerId) ?? null;
}

/**
 * Sets `projectPrinter` on the multi-colour project parts of a configuration.
 * Two queries, and only for a product that has a 3MF source at all.
 */
export async function applyProjectPrinters(db: Db, config: ProductConfig): Promise<void> {
  const projects = config.components.filter((c) => c.sourceKind === 'THREEMF' && c.sourceAttachmentId);
  if (!projects.length || !db.attachment || !db.printer) return;
  const sources = await db.attachment.findMany({
    where: { id: { in: [...new Set(projects.map((c) => c.sourceAttachmentId!))] } },
    select: { id: true, parsedMetadata: true },
  });
  const metaOf = new Map<string, SourceMeta>(sources.map((a: any) => [a.id, sourceMetaOf(a.parsedMetadata)]));
  const locked = projects.filter((c) => isMultiColourProject(c, metaOf.get(c.sourceAttachmentId!) ?? null));
  if (!locked.length) return;
  const printers: MatchablePrinter[] = await db.printer.findMany({ where: { isActive: true }, select: { id: true, name: true, model: true, isActive: true } });
  for (const c of locked) {
    const meta = metaOf.get(c.sourceAttachmentId!);
    const p = meta ? projectPrinterOf(meta, printers) : null;
    c.projectPrinter = p ? { id: p.id, name: p.name } : null;
  }
}
