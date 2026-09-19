import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

/**
 * Every write to a printed-stock balance is one atomic SQL statement (spec §0.2
 * "Counters"): never read-then-write, and the balance recorded on the ledger is
 * read from the same statement's RETURNING.
 *
 * Each statement starts with a `/* stock:<name> *\/` marker so specs can drive
 * an in-memory fake by name instead of parsing SQL.
 */

export type StockTx = Pick<Prisma.TransactionClient, '$queryRaw'>;

type BalanceRow = { stockOnHand: number };

async function one(tx: StockTx, sql: Prisma.Sql): Promise<number | null> {
  const rows = (await tx.$queryRaw(sql)) as BalanceRow[];
  return rows.length ? Number(rows[0].stockOnHand) : null;
}

/** Column += n (n may be negative). Returns the new balance, null if the component is gone. */
export function addColumn(tx: StockTx, componentId: string, n: number) {
  return one(tx, Prisma.sql`/* stock:addColumn */ UPDATE "ProductComponent"
    SET "stockOnHand" = "stockOnHand" + ${n} WHERE "id" = ${componentId} RETURNING "stockOnHand"`);
}

/** Column -= n only when at least n are there. null = not enough (or gone). */
export function takeColumn(tx: StockTx, componentId: string, n: number) {
  return one(tx, Prisma.sql`/* stock:takeColumn */ UPDATE "ProductComponent"
    SET "stockOnHand" = "stockOnHand" - ${n}
    WHERE "id" = ${componentId} AND "stockOnHand" >= ${n} RETURNING "stockOnHand"`);
}

/** Row (componentId, key) += n, creating the row when missing. */
export function addRow(tx: StockTx, componentId: string, colourKey: string, n: number) {
  return one(tx, Prisma.sql`/* stock:addRow */ INSERT INTO "ComponentColourStock"
    ("id", "componentId", "colourKey", "stockOnHand", "updatedAt")
    VALUES (${randomUUID()}, ${componentId}, ${colourKey}, ${n}, NOW())
    ON CONFLICT ("componentId", "colourKey") DO UPDATE
    SET "stockOnHand" = "ComponentColourStock"."stockOnHand" + ${n}, "updatedAt" = NOW()
    RETURNING "stockOnHand"`);
}

/** Row -= n only when at least n are there. null = not enough (or no row). */
export function takeRow(tx: StockTx, componentId: string, colourKey: string, n: number) {
  return one(tx, Prisma.sql`/* stock:takeRow */ UPDATE "ComponentColourStock"
    SET "stockOnHand" = "stockOnHand" - ${n}, "updatedAt" = NOW()
    WHERE "componentId" = ${componentId} AND "colourKey" = ${colourKey} AND "stockOnHand" >= ${n}
    RETURNING "stockOnHand"`);
}

/** Lock the column and read it (FOR UPDATE, inside the caller's transaction). */
export function lockColumn(tx: StockTx, componentId: string) {
  return one(tx, Prisma.sql`/* stock:lockColumn */ SELECT "stockOnHand" FROM "ProductComponent"
    WHERE "id" = ${componentId} FOR UPDATE`);
}

/** Lock a colour row and read it. null = no row (a balance of 0). */
export function lockRow(tx: StockTx, componentId: string, colourKey: string) {
  return one(tx, Prisma.sql`/* stock:lockRow */ SELECT "stockOnHand" FROM "ComponentColourStock"
    WHERE "componentId" = ${componentId} AND "colourKey" = ${colourKey} FOR UPDATE`);
}

/** Manual set of the column, only if it still holds `expected`; also confirms it. */
export function setColumnIf(tx: StockTx, componentId: string, expected: number, value: number) {
  return one(tx, Prisma.sql`/* stock:setColumnIf */ UPDATE "ProductComponent"
    SET "stockOnHand" = ${value}, "stockConfirmedAt" = NOW()
    WHERE "id" = ${componentId} AND "stockOnHand" = ${expected} RETURNING "stockOnHand"`);
}

/** Create a zero row when missing (for a manual set whose expected value is 0). */
export async function ensureRow(tx: StockTx, componentId: string, colourKey: string) {
  await tx.$queryRaw(Prisma.sql`/* stock:ensureRow */ INSERT INTO "ComponentColourStock"
    ("id", "componentId", "colourKey", "stockOnHand", "updatedAt")
    VALUES (${randomUUID()}, ${componentId}, ${colourKey}, 0, NOW())
    ON CONFLICT ("componentId", "colourKey") DO NOTHING RETURNING "stockOnHand"`);
}

/** Manual set of a colour row, only if it still holds `expected`. */
export function setRowIf(tx: StockTx, componentId: string, colourKey: string, expected: number, value: number) {
  return one(tx, Prisma.sql`/* stock:setRowIf */ UPDATE "ComponentColourStock"
    SET "stockOnHand" = ${value}, "updatedAt" = NOW()
    WHERE "componentId" = ${componentId} AND "colourKey" = ${colourKey} AND "stockOnHand" = ${expected}
    RETURNING "stockOnHand"`);
}

/** Plain read of a row (for 409 messages). */
export function readRow(tx: StockTx, componentId: string, colourKey: string) {
  return one(tx, Prisma.sql`/* stock:readRow */ SELECT "stockOnHand" FROM "ComponentColourStock"
    WHERE "componentId" = ${componentId} AND "colourKey" = ${colourKey}`);
}

/** Plain read of the column (for 409 messages). */
export function readColumn(tx: StockTx, componentId: string) {
  return one(tx, Prisma.sql`/* stock:readColumn */ SELECT "stockOnHand" FROM "ProductComponent"
    WHERE "id" = ${componentId}`);
}
