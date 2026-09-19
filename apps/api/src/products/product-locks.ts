import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Problem } from '@printforge/types';
import type { OpenLineImpact } from '../catalog-core/open-lines-impact.service';
import * as fs from 'fs/promises';
import * as path from 'path';
import { containedUploadPath, imagePathForKey } from './product-images.service';

/**
 * Row locks, history counts and after-commit file clean-up shared by the
 * products, variants and colour-slot services (spec §3.1 rule 3, §3.10).
 *
 * Every lock statement starts with a `/* lock:<Table>:<MODE> *\/` marker so the
 * specs' in-memory database can serve it by name.
 */

type RawTx = { $queryRaw: (q: Prisma.Sql) => Promise<unknown> };
type Mode = 'UPDATE' | 'SHARE';

const TABLES = { Product: 'Product', ProductVariant: 'ProductVariant' } as const;

export interface LockedOption {
  id: string;
  productId: string;
  kind: 'SIZE' | 'COLOUR';
  name: string;
  isActive: boolean;
  basePrice: number | null;
}

async function lock<T>(tx: RawTx, table: keyof typeof TABLES, ids: string[], mode: Mode, cols: string): Promise<T[]> {
  if (!ids.length) return [];
  const clause = mode === 'UPDATE' ? 'FOR UPDATE' : 'FOR SHARE';
  const sql = Prisma.sql`/* lock:${Prisma.raw(`${table}:${mode}`)} */ SELECT ${Prisma.raw(cols)} FROM ${Prisma.raw(`"${TABLES[table]}"`)} WHERE "id" = ANY(${ids}::text[]) ${Prisma.raw(clause)}`;
  return (await tx.$queryRaw(sql)) as T[];
}

/** `SELECT … FROM "ProductVariant" WHERE id = ANY($1) FOR UPDATE|FOR SHARE`: the kind read from the locked row. */
export function lockOptions(tx: RawTx, ids: string[], mode: Mode): Promise<LockedOption[]> {
  return lock<LockedOption>(tx, 'ProductVariant', ids, mode, '"id", "productId", "kind", "name", "isActive", "basePrice"');
}

export async function lockProduct(tx: RawTx, id: string, mode: Mode = 'UPDATE'): Promise<{ id: string; name: string } | null> {
  const rows = await lock<{ id: string; name: string }>(tx, 'Product', [id], mode, '"id", "name"');
  return rows[0] ?? null;
}

export const TX_OPTS = { timeout: 30_000, maxWait: 10_000 };

// ------------------------------------------------------------- shared checks

type Db = any;

/** SKUs are unique across products and options (P6, O1, O2): 409 naming the holder. */
export async function assertSkuFree(db: Db, sku: string | null | undefined, except: { productId?: string; variantId?: string } = {}) {
  if (!sku) return;
  const p = await db.product.findFirst({ where: { sku, ...(except.productId ? { NOT: { id: except.productId } } : {}) }, select: { name: true } });
  if (p) throw new ConflictException(`SKU "${sku}" is already used by "${p.name}"`);
  const v = await db.productVariant.findFirst({
    where: { sku, ...(except.variantId ? { NOT: { id: except.variantId } } : {}) },
    select: { name: true, product: { select: { name: true } } },
  });
  if (v) throw new ConflictException(`SKU "${sku}" is already used by "${v.product?.name ? `${v.product.name} — ` : ''}${v.name}"`);
}

/** Open-line impact of several in-memory changes, one entry per line (changes concatenated). */
export function mergeImpact(...lists: OpenLineImpact[][]): OpenLineImpact[] {
  const out = new Map<string, OpenLineImpact>();
  for (const list of lists) {
    for (const i of list) {
      const k = `${i.kind}:${i.lineId}`;
      const prev = out.get(k);
      if (!prev) out.set(k, { ...i, changes: [...i.changes] });
      else for (const c of i.changes) if (!prev.changes.includes(c)) prev.changes.push(c);
    }
  }
  return [...out.values()];
}

/** §3.3: a write whose impact is non-empty needs `confirm: true`. */
export function requireConfirm(impact: OpenLineImpact[], confirm: boolean) {
  if (impact.length && !confirm) {
    throw new BadRequestException(`This change affects ${impact.length} open order or quote lines — review them and confirm`);
  }
}

export function impactWarnings(impact: OpenLineImpact[]): Problem[] {
  if (!impact.length) return [];
  const list = impact.map((i) => `${i.number} ${i.description} ×${i.quantity}${i.partlyPlanned ? ' (partly planned)' : ''}`).join(', ');
  return [{ code: 'OPEN_LINES_AFFECTED', message: `${impact.length} open lines will print differently: ${list}` }];
}

// ------------------------------------------------------------------ history

const ACTIVE_JOBS = ['QUEUED', 'IN_PROGRESS', 'PAUSED'];
export { ACTIVE_JOBS };

export interface History { orderLines: number; quoteLines: number; jobs: number }

/** §3.10 "Product has history": lines and jobs by product, any option column, component or JobPlate. */
export async function productHistory(db: Db, productId: string): Promise<History> {
  const [options, components] = await Promise.all([
    db.productVariant.findMany({ where: { productId }, select: { id: true } }),
    db.productComponent.findMany({ where: { productId }, select: { id: true } }),
  ]);
  const V = options.map((o: { id: string }) => o.id);
  const C = components.map((c: { id: string }) => c.id);
  const [orderLines, quoteLines, jobs] = await Promise.all([
    db.orderItem.count({ where: { OR: [{ productId }, { variantId: { in: V } }, { sizeOptionId: { in: V } }, { colourOptionId: { in: V } }] } }),
    db.quoteItem.count({ where: { OR: [{ productId }, { sizeOptionId: { in: V } }, { colourOptionId: { in: V } }] } }),
    db.productionJob.count({
      where: {
        OR: [
          { productId }, { variantId: { in: V } }, { sizeOptionId: { in: V } }, { colourOptionId: { in: V } },
          { componentId: { in: C } }, { plates: { some: { componentId: { in: C } } } },
        ],
      },
    }),
  ]);
  return { orderLines, quoteLines, jobs };
}

/**
 * §3.10 "Option has history", counted over every option-reference column
 * whatever the option's kind, plus jobs of the components it owns; and its
 * printed-stock records (owned components' balances and movements).
 */
export async function optionHistory(db: Db, optionId: string): Promise<History & { stockRecords: number }> {
  const owned = await db.productComponent.findMany({ where: { variantId: optionId }, select: { id: true, stockOnHand: true } });
  const C = owned.map((c: { id: string }) => c.id);
  const [orderLines, quoteLines, jobs, rows, moves] = await Promise.all([
    db.orderItem.count({ where: { OR: [{ variantId: optionId }, { sizeOptionId: optionId }, { colourOptionId: optionId }] } }),
    db.quoteItem.count({ where: { OR: [{ sizeOptionId: optionId }, { colourOptionId: optionId }] } }),
    db.productionJob.count({
      where: {
        OR: [
          { variantId: optionId }, { sizeOptionId: optionId }, { colourOptionId: optionId },
          { componentId: { in: C } }, { plates: { some: { componentId: { in: C } } } },
        ],
      },
    }),
    C.length ? db.componentColourStock.count({ where: { componentId: { in: C }, stockOnHand: { gt: 0 } } }) : 0,
    C.length ? db.componentStockMovement.count({ where: { componentId: { in: C } } }) : 0,
  ]);
  const columns = owned.filter((c: { stockOnHand: number }) => c.stockOnHand > 0).length;
  return { orderLines, quoteLines, jobs, stockRecords: columns + rows + moves };
}

// -------------------------------------------------------------------- files

const logger = new Logger('ProductFiles');

/**
 * Attachments no longer referenced by any component (file or thumbnail), plate
 * layout or job plate, among `ids`. Call inside the transaction after the
 * deletes; returns the rows to delete and their contained paths to unlink.
 */
export async function unreferencedAttachments(db: Db, ids: Array<string | null | undefined>): Promise<Array<{ id: string; abs: string | null }>> {
  const out: Array<{ id: string; abs: string | null }> = [];
  for (const id of [...new Set(ids.filter((x): x is string => !!x))]) {
    const [comp, thumb, layout, plate] = await Promise.all([
      db.productComponent.count({ where: { attachmentId: id } }),
      db.productComponent.count({ where: { thumbnailAttachmentId: id } }),
      db.plateLayout.count({ where: { attachmentId: id } }),
      db.jobPlate.count({ where: { attachmentId: id } }),
    ]);
    if (comp + thumb + layout + plate > 0) continue;
    const att = await db.attachment.findUnique({ where: { id }, select: { id: true, storagePath: true } });
    if (!att) continue;
    out.push({ id, abs: containedUploadPath(att.storagePath) });
  }
  return out;
}

/** Contained paths of a product's photos and attachments (for P8 after commit). */
export function photoPaths(images: Array<{ storageKey: string }>): string[] {
  return images.map((i) => imagePathForKey(i.storageKey)).filter((p): p is string => !!p);
}

/** After commit: unlink files, logging (never throwing) on failure. */
export async function unlinkAfterCommit(paths: Array<string | null | undefined>): Promise<void> {
  for (const p of paths) {
    if (!p) continue;
    try {
      await fs.unlink(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') logger.warn(`Could not delete ${path.basename(p)}: ${(e as Error)?.message}`);
    }
  }
}
