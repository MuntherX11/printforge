import { ConflictException } from '@nestjs/common';
import { MaterialType, Prisma } from '@prisma/client';
import { filamentIdentityKey, filamentIdentityLabel, type FilamentIdentity } from '@printforge/types';

/**
 * The duplicate filament guard (safety spec §3): no two filaments with the
 * same brand + type + colour (filamentIdentityKey). A unique index is not an
 * option — production already holds duplicate rows — so every path that
 * creates a filament or changes its identity checks under one transaction-
 * scoped advisory lock instead.
 *
 * - One global key: filaments are created rarely, and a single key can't
 *   deadlock a bulk upload against a slicer import.
 * - Create, identity-changing update and bulk upload only TRY the lock, for at
 *   most ~10 s, then 409 MATERIAL_BUSY. Their 30 s transaction therefore can't
 *   time out (P2028, a 500) waiting for it.
 * - Slicer imports wait for it (their 60 s IMPORT_TX), because the other
 *   holders keep it for milliseconds.
 */

/** Interactive-transaction options for material writes under the lock. */
export const MATERIAL_TX = { timeout: 30_000, maxWait: 10_000 };

/** At most 50 × 200 ms ≈ 10 s of trying, well inside MATERIAL_TX.timeout. */
export const MATERIAL_LOCK_WAIT: LockWait = { attempts: 50, delayMs: 200 };

export const MATERIAL_BUSY_MESSAGE = 'Another filament is being saved or imported right now — try again in a few seconds';

export interface LockWait {
  attempts: number;
  /** Pause between attempts, in milliseconds. */
  delayMs: number;
}

/** The row a duplicate check returns: the oldest filament with the identity. */
export interface DuplicateMaterial {
  id: string;
  name: string;
  type: string;
  brand: string | null;
  color: string | null;
  colorHex: string | null;
  createdAt: Date;
}

type RawTx = Pick<Prisma.TransactionClient, '$queryRaw'>;
type MaterialReader = Pick<Prisma.TransactionClient, 'material'>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Take the identity lock for the rest of the transaction, trying `wait.attempts`
 * times `wait.delayMs` apart; then 409 MATERIAL_BUSY. Never blocks on the lock.
 */
export async function lockMaterialIdentity(tx: RawTx, wait: LockWait = MATERIAL_LOCK_WAIT): Promise<void> {
  for (let attempt = 1; attempt <= wait.attempts; attempt++) {
    const [row] = await tx.$queryRaw<Array<{ ok: boolean }>>(
      Prisma.sql`/* material:advisory */ SELECT pg_try_advisory_xact_lock(hashtext('material:identity')) AS "ok"`,
    );
    if (row?.ok === true) return;
    if (attempt < wait.attempts && wait.delayMs > 0) await sleep(wait.delayMs);
  }
  throw new ConflictException({ message: MATERIAL_BUSY_MESSAGE, code: 'MATERIAL_BUSY' });
}

/** Slicer imports only: wait for the identity lock (precedent: job-planning's plan:advisory). */
export async function waitForMaterialIdentity(tx: RawTx): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`/* material:advisory */ SELECT 1 AS "ok" FROM (SELECT pg_advisory_xact_lock(hashtext('material:identity'))) AS "l"`,
  );
}

/**
 * The oldest filament (createdAt, then id) with this identity, other than
 * `exceptId`; null when there is none. A colourless identity has no key and
 * returns null without querying.
 */
export async function findDuplicateMaterial(
  db: MaterialReader,
  identity: FilamentIdentity,
  exceptId?: string,
): Promise<DuplicateMaterial | null> {
  const key = filamentIdentityKey(identity);
  if (key === null) return null;
  const rows = await db.material.findMany({
    where: { type: identity.type as MaterialType, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { id: true, name: true, type: true, brand: true, color: true, colorHex: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.find((row) => filamentIdentityKey(row) === key) ?? null;
}

/**
 * 409 MATERIAL_DUPLICATE naming the incoming identity and the existing row:
 * 'eSUN · PLA · Red already exists as "eSUN PLA Red" — add a spool to it instead'
 * (create), or the same without the advice (update).
 */
export function duplicateMaterialConflict(
  existing: { id: string; name: string },
  identity: FilamentIdentity,
  mode: 'create' | 'update',
): ConflictException {
  const advice = mode === 'create' ? ' — add a spool to it instead' : '';
  return new ConflictException({
    message: `${filamentIdentityLabel(identity)} already exists as "${existing.name}"${advice}`,
    code: 'MATERIAL_DUPLICATE',
    existing: { id: existing.id, name: existing.name },
  });
}

/** True for the 409 MATERIAL_BUSY that lockMaterialIdentity throws. */
export function isMaterialBusy(err: unknown): err is ConflictException {
  if (!(err instanceof ConflictException)) return false;
  const body = err.getResponse();
  return typeof body === 'object' && body !== null && (body as { code?: unknown }).code === 'MATERIAL_BUSY';
}
