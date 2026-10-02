import { ConflictException } from '@nestjs/common';
import { matchPrinter, noMatchingPrinter } from '../file-parser/printer-match';
import { ACTIVE_JOBS } from './product-locks';

/**
 * Rules shared by every place a product G-code is stored or deleted (owner
 * spec 2026-10-02 items 3, 5, 6):
 *
 * - a file that a QUEUED, IN_PROGRESS or PAUSED job prints can't be deleted —
 *   409 naming the job. Finished, failed and cancelled jobs keep their plate
 *   rows; their download then says the file was deleted;
 * - the printer a file was sliced for becomes the product's pricing printer
 *   when it has none and a printer matches.
 */

type Db = any;

export interface JobRef { id: string; name: string; status: string }

const statusWord = (s: string) => s.toLowerCase().replace(/_/g, ' ');

/** 409 naming the open job that prints a file the user wants gone. */
export function fileInUseError(job: JobRef, what = 'This file') {
  return new ConflictException(`${what} is printed by job "${job.name}" (${statusWord(job.status)}) — finish or cancel that job first`);
}

/** The first open job whose plates print one of these files, or null. */
export async function openJobUsingFiles(db: Db, attachmentIds: Array<string | null | undefined>): Promise<JobRef | null> {
  const ids = [...new Set(attachmentIds.filter((x): x is string => !!x))];
  if (!ids.length) return null;
  const plate = await db.jobPlate.findFirst({
    where: { attachmentId: { in: ids }, job: { status: { in: ACTIVE_JOBS } } },
    select: { job: { select: { id: true, name: true, status: true } } },
  });
  return plate?.job ?? null;
}

/** The first open job that plans a plate of this layout or component, or null. */
export async function openJobUsingPlates(db: Db, where: { layoutId?: string; componentId?: string }): Promise<JobRef | null> {
  const job = await db.productionJob.findFirst({
    where: {
      status: { in: ACTIVE_JOBS },
      ...(where.layoutId ? { plates: { some: { layoutId: where.layoutId } } } : {}),
      ...(where.componentId ? { OR: [{ componentId: where.componentId }, { plates: { some: { componentId: where.componentId } } }] } : {}),
    },
    select: { id: true, name: true, status: true },
  });
  return job ?? null;
}

/**
 * Sets Product.defaultPrinterId from the first sliced-for model that matches
 * an active printer, only while the product has none. Returns the printer set,
 * or null (nothing to do, or nothing matched).
 */
export async function adoptDefaultPrinter(db: Db, productId: string, models: Array<string | null | undefined>): Promise<{ id: string; name: string } | null> {
  const wanted = models.filter((m): m is string => !!m);
  if (!wanted.length) return null;
  const product = await db.product.findUnique({ where: { id: productId }, select: { defaultPrinterId: true } });
  if (!product || product.defaultPrinterId) return null;
  const printers: Array<{ id: string; name: string; model: string | null; isActive: boolean }> = await db.printer.findMany({
    where: { isActive: true },
    select: { id: true, name: true, model: true, isActive: true },
  });
  for (const m of wanted) {
    const p = matchPrinter(m, printers);
    if (p) {
      await db.product.update({ where: { id: productId }, data: { defaultPrinterId: p.id } });
      return { id: p.id, name: p.name };
    }
  }
  return null;
}

/** PRINTER_NOT_MATCHED warnings for sliced-for models no active printer matches (one per model). */
export async function unmatchedPrinterWarnings(db: Db, models: Array<string | null | undefined>) {
  const wanted = [...new Set(models.filter((m): m is string => !!m))];
  if (!wanted.length) return [];
  const printers = await db.printer.findMany({ where: { isActive: true }, select: { id: true, name: true, model: true, isActive: true } });
  return wanted.filter((m) => !matchPrinter(m, printers)).map((m) => ({ code: 'PRINTER_NOT_MATCHED', message: noMatchingPrinter(m) }));
}
