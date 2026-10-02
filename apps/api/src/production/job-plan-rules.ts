import { ConflictException } from '@nestjs/common';
import { PLANNABLE_ORDER_STATUSES, type PlanRow, type Problem, type SurplusPolicy } from '@printforge/types';
import { createHash } from 'crypto';
import type { ResolvedBom, ResolvedComponent } from '../catalog-core/bom-resolver.service';
import type { CatalogRequestContext } from '../catalog-core/catalog-context';
import { planFromBom, type OptionPlan } from '../catalog-core/production-planner.service';
import { colourLabel } from '../stock-ledger/colour-key';
import { PlatePrinterLookup } from './plate-printers';

/**
 * Pure rules of order production planning (J4/J5), split out of
 * JobPlanningService: plannable statuses, stock buckets, one-component plans,
 * the plan version and the rows' default printer.
 */

export const NO_SLICED_DATA = (desc: string) => `"${desc}" has no sliced data — add its grams and minutes or a plate layout`;

/**
 * Orders production can be planned for (J4/J5): PLANNABLE_ORDER_STATUSES, the
 * same list the order page shows Plan Production for. A cancelled order holds
 * no allocation (§3.6 "Release on order cancellation"), and a finished one has
 * nothing left to plan.
 */
export function assertPlannable(status: string) {
  if (!(PLANNABLE_ORDER_STATUSES as ReadonlyArray<string>).includes(status)) {
    throw new ConflictException(`This order is ${String(status).toLowerCase().replace(/_/g, ' ')} — production can't be planned for it`);
  }
}

/** One printed-stock balance: rows of different lines that resolve to it share it. */
export const bucketOf = (componentId: string, colourKey: string) => `${componentId}|${colourKey}`;

export function planComponent(component: ResolvedComponent, R: number, cacheBom: ResolvedBom, config: any, ctx: CatalogRequestContext, policy: SurplusPolicy, plates?: Array<{ layoutId: string | null; plateCount: number }>): OptionPlan {
  const bom = { ...cacheBom, components: [component] };
  return planFromBom(
    bom,
    {
      quantity: 1,
      unitsRequired: { [component.componentId]: R },
      surplusPolicy: policy,
      plates: plates?.map((p) => ({ componentId: component.componentId, layoutId: p.layoutId, plateCount: p.plateCount })),
    },
    config.materials,
    ctx.planCache,
  );
}

/** First 16 hex of SHA-1 over the sorted row tuples (§4.4 J4). */
export function planVersionOf(rows: ReadonlyArray<{ row: PlanRow; component: ResolvedComponent }>): string {
  const tuples = rows
    .map(({ row, component }) => JSON.stringify([
      row.rowKey, row.remaining, row.onHand, row.alreadyPlanned, row.sizeOptionId, row.colourOptionId, row.colourKey,
      component.slots.map((s) => [s.materialId, s.baseMaterialId !== s.materialId ? s.baseMaterialId : null]),
    ]))
    .sort();
  return createHash('sha1').update(tuples.join('\n')).digest('hex').slice(0, 16);
}

/** The file a planned plate prints: its layout's, or the part's own for the single unit. */
export const plateFileOf = (component: ResolvedComponent, layoutId: string | null) =>
  component.layouts.find((l) => l.layoutId === layoutId)?.attachmentId ?? null;

/**
 * Owner spec 2026-10-02 item 6: each row defaults to the printer its suggested
 * plates' files were sliced for (else the pricing printer, as before), and says
 * so when a file's printer matches no farm printer.
 */
export async function applyPlatePrinters(db: any, rows: ReadonlyArray<{ row: PlanRow; component: ResolvedComponent }>) {
  const lookup = await PlatePrinterLookup.load(db, rows.flatMap((r) => r.row.suggestedPlates.map((p) => plateFileOf(r.component, p.layoutId))));
  for (const { row, component } of rows) {
    const plates = row.suggestedPlates.map((p) => ({ attachmentId: plateFileOf(component, p.layoutId), plateCount: p.plateCount }));
    const s = lookup.suggest(plates, null);
    if (s.fromFile) {
      row.printerId = s.printerId;
      row.printerName = s.printerName;
    }
    if (s.warning) row.warnings.push({ ...s.warning, componentId: component.componentId });
  }
}

/** §4.4.1 "Line colour changed": planned plates or net allocations in another colour key. */
export async function colourChangedWarning(
  db: any,
  c: ResolvedComponent,
  plates: Array<{ componentId: string | null; colourKey: string; unitsRequired: number }>,
  moves: Array<{ componentId: string; colourKey: string; delta: number; reason: string }>,
  materials: ReadonlyMap<string, { name: string }>,
  extra: Map<string, { name: string }>,
): Promise<Problem | null> {
  const byKey = new Map<string, number>();
  for (const p of plates) if (p.componentId === c.componentId && p.colourKey !== c.colourKey) byKey.set(p.colourKey, (byKey.get(p.colourKey) ?? 0) + p.unitsRequired);
  const net = new Map<string, number>();
  for (const m of moves) if (m.componentId === c.componentId) net.set(m.colourKey, (net.get(m.colourKey) ?? 0) - m.delta);
  for (const [k, n] of net) if (n > 0 && k !== c.colourKey) byKey.set(k, (byKey.get(k) ?? 0) + n);
  if (!byKey.size) return null;
  const [oldKey] = [...byKey.entries()].sort((a, b) => b[1] - a[1])[0];
  const missing = oldKey.split('|').map((s) => s.slice(s.indexOf(':') + 1)).filter((id) => !materials.has(id) && !extra.has(id));
  if (missing.length) {
    const rows = await db.material.findMany({ where: { id: { in: missing } }, select: { id: true, name: true } });
    for (const r of rows) extra.set(r.id, { name: r.name });
  }
  const lookup = (id: string) => materials.get(id) ?? extra.get(id);
  let oldLabel = oldKey;
  try { oldLabel = colourLabel(oldKey, lookup); } catch { /* keep the key */ }
  const newLabel = c.colourKey ? colourLabel(c.colourKey, materials) : 'no filament';
  const total = [...byKey.values()].reduce((s, n) => s + n, 0);
  return {
    code: 'LINE_COLOUR_CHANGED',
    componentId: c.componentId,
    message: `${total} units of "${c.description}" were planned in ${oldLabel} — the rest would print in ${newLabel}`,
  };
}
