import type { OptionPair, Problem } from '@printforge/types';
import type { BomResolverService } from '../catalog-core/bom-resolver.service';
import type { CatalogRequestContext } from '../catalog-core/catalog-context';
import type { ProductionPlannerService } from '../catalog-core/production-planner.service';
import { colourLabel, parseColourKey } from '../stock-ledger/colour-key';

/**
 * Read-side views of an order's lines (spec §4.5 S3, S4, S9, S11): filament
 * availability, print files, printed-stock allocations and their labels. Every
 * existing line goes through resolveForLine (§3.2), which never throws: a line
 * that can't be resolved is skipped with a warning.
 */

type Db = any;

export interface MaterialAvailability {
  materialId: string;
  name: string;
  type: string;
  color: string | null;
  gramsNeeded: number;
  totalStock: number;
  reservedStock: number;
  freeStock: number;
  hasEnoughStock: boolean;
}

export interface PlannedLine extends OptionPair {
  productId: string;
  quantity: number;
}

/**
 * Filament a set of lines needs (pair-, multicolour- and plate-aware, via
 * planOption), netted against what other open orders and active jobs hold
 * (`freeFilament`, §3.7). Shape as before the release.
 */
export async function materialAvailability(
  planner: ProductionPlannerService,
  lines: ReadonlyArray<PlannedLine>,
  excludeOrderId: string | null,
  ctx: CatalogRequestContext,
): Promise<{ materials: MaterialAvailability[]; warnings: Problem[] }> {
  const warnings: Problem[] = [];
  const needs = new Map<string, { materialId: string; name: string; type: string; color: string | null; grams: number }>();
  for (const l of lines) {
    try {
      const plan = await planner.planOption({ productId: l.productId, sizeOptionId: l.sizeOptionId, colourOptionId: l.colourOptionId, quantity: l.quantity }, ctx);
      for (const n of plan.filamentNeeds) {
        const e = needs.get(n.materialId) ?? { materialId: n.materialId, name: n.material.name, type: n.material.type, color: n.material.color ?? null, grams: 0 };
        e.grams += n.grams;
        needs.set(n.materialId, e);
      }
    } catch (e) {
      warnings.push({ code: 'LINE_NOT_PLANNED', message: `A line couldn't be planned (${(e as Error).message}) — its filament isn't counted` });
    }
  }
  if (!needs.size) return { materials: [], warnings };
  const free = await planner.freeFilament([...needs.keys()], { excludeOrderId, ctx });
  warnings.push(...free.warnings);
  const materials = [...needs.values()].map((n) => {
    const f = free.materials.get(n.materialId) ?? { totalStock: 0, reserved: 0, free: 0 };
    return {
      materialId: n.materialId,
      name: n.name,
      type: n.type,
      color: n.color,
      gramsNeeded: Math.round(n.grams),
      totalStock: Math.round(f.totalStock),
      reservedStock: Math.round(f.reserved),
      freeStock: Math.round(f.free),
      hasEnoughStock: f.free >= n.grams,
    };
  });
  return { materials, warnings };
}

export interface ExistingOrderLine {
  id: string;
  productId: string | null;
  variantId: string | null;
  sizeOptionId: string | null;
  colourOptionId: string | null;
  description: string;
  quantity: number;
}

/** resolveForLine over an order's lines: the resolvable ones and the skip warnings. */
export async function resolveOrderLines(resolver: BomResolverService, orderNumber: string, items: ReadonlyArray<ExistingOrderLine>, ctx: CatalogRequestContext) {
  const resolved: Array<{ item: ExistingOrderLine; res: Extract<Awaited<ReturnType<BomResolverService['resolveForLine']>>, { skip: false }> }> = [];
  const warnings: Problem[] = [];
  for (const item of items) {
    if (!item.productId && !item.variantId && !item.sizeOptionId && !item.colourOptionId) continue; // custom line
    const res = await resolver.resolveForLine(item, `Order ${orderNumber}`, ctx);
    if (res.skip) warnings.push(res.warning);
    else resolved.push({ item, res });
  }
  return { resolved, warnings };
}

export interface PrintFile {
  orderItemId: string;
  productName: string;
  optionLabel: string;
  component: string;
  kind: 'COMPONENT' | 'PLATE_LAYOUT';
  unitsPerPlate: number | null;
  quantity: number;
  attachmentId: string;
  filename: string;
  sizeBytes: number;
  colorChanges: number;
  printIn: Array<{ colorIndex: number; materialLabel: string; slicedFor: string | null }>;
}

/**
 * S4 `printFiles`: the files of the line's SIZE (component files and plate-layout
 * files), with `printIn` saying which filament each colour of the file prints in
 * for the line's COLOUR. `quantity` is the component units the line needs.
 * Attachments that no longer exist are not offered.
 */
export async function printFilesFor(
  db: Db,
  resolver: BomResolverService,
  resolved: Awaited<ReturnType<typeof resolveOrderLines>>['resolved'],
  ctx: CatalogRequestContext,
): Promise<PrintFile[]> {
  type Pending = Omit<PrintFile, 'filename' | 'sizeBytes'> & { gcodeFilename: string | null };
  const pending: Pending[] = [];
  for (const { item, res } of resolved) {
    const config = await resolver.loadConfig(res.bom.productId, ctx);
    const productName = config?.product.name ?? 'Product';
    for (const c of res.bom.components) {
      const printIn = c.slots.map((s) => ({
        colorIndex: s.colorIndex,
        materialLabel: s.material.name,
        slicedFor: s.baseMaterialId !== s.materialId ? config?.materials.get(s.baseMaterialId)?.name ?? null : null,
      }));
      const base = { orderItemId: item.id, productName, optionLabel: res.bom.label, component: c.description, quantity: c.quantity * item.quantity, printIn };
      if (c.attachmentId) {
        pending.push({ ...base, kind: 'COMPONENT', unitsPerPlate: null, attachmentId: c.attachmentId, gcodeFilename: c.gcodeFilename, colorChanges: c.colorChanges });
      }
      for (const l of c.layouts) {
        if (!l.layoutId || !l.attachmentId) continue;
        pending.push({ ...base, kind: 'PLATE_LAYOUT', unitsPerPlate: l.unitsPerPlate, attachmentId: l.attachmentId, gcodeFilename: l.gcodeFilename, colorChanges: l.colorChanges });
      }
    }
  }
  if (!pending.length) return [];
  const attachments: Array<{ id: string; originalName: string; sizeBytes: number }> = await db.attachment.findMany({
    where: { id: { in: [...new Set(pending.map((p) => p.attachmentId))] } },
    select: { id: true, originalName: true, sizeBytes: true },
  });
  const byId = new Map(attachments.map((a) => [a.id, a]));
  return pending.flatMap(({ gcodeFilename, ...p }) => {
    const file = byId.get(p.attachmentId);
    if (!file) return [];
    return [{ ...p, filename: gcodeFilename || file.originalName, sizeBytes: file.sizeBytes }];
  });
}

export interface NetAllocation {
  orderItemId: string;
  componentId: string;
  colourKey: string;
  units: number;
}

/** Net printed-stock allocation per (line, component, physical key): −Σ PLAN_ALLOCATE − Σ PLAN_RELEASE > 0 (§3.6). */
export async function netAllocations(db: Db, orderItemIds: string[]): Promise<NetAllocation[]> {
  if (!orderItemIds.length) return [];
  const moves: Array<{ orderItemId: string; componentId: string; colourKey: string; delta: number }> = await db.componentStockMovement.findMany({
    where: { orderItemId: { in: orderItemIds }, reason: { in: ['PLAN_ALLOCATE', 'PLAN_RELEASE'] } },
    select: { orderItemId: true, componentId: true, colourKey: true, delta: true },
  });
  const net = new Map<string, NetAllocation>();
  for (const m of moves) {
    const k = `${m.orderItemId} ${m.componentId} ${m.colourKey}`;
    const e = net.get(k) ?? { orderItemId: m.orderItemId, componentId: m.componentId, colourKey: m.colourKey, units: 0 };
    e.units -= m.delta;
    net.set(k, e);
  }
  return [...net.values()].filter((e) => e.units > 0);
}

/** `{ componentDescription, colourLabel, units }` for stock rows (S9 `stockReleased`, S11, S4). */
export async function labelStock<T extends { componentId: string; colourKey: string; units: number }>(
  db: Db,
  rows: ReadonlyArray<T>,
): Promise<Array<T & { componentDescription: string; colourLabel: string }>> {
  if (!rows.length) return [];
  const components: Array<{ id: string; description: string }> = await db.productComponent.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.componentId))] } },
    select: { id: true, description: true },
  });
  const materialIds = new Set<string>();
  for (const r of rows) {
    try {
      for (const s of parseColourKey(r.colourKey)) materialIds.add(s.materialId);
    } catch {
      /* malformed key: labelled as unknown */
    }
  }
  const materials: Array<{ id: string; name: string }> = materialIds.size
    ? await db.material.findMany({ where: { id: { in: [...materialIds] } }, select: { id: true, name: true } })
    : [];
  const matMap = new Map(materials.map((m) => [m.id, m]));
  const compMap = new Map(components.map((c) => [c.id, c.description]));
  return rows.map((r) => {
    let label = 'Unknown colour';
    try {
      label = colourLabel(r.colourKey, matMap);
    } catch {
      /* keep the fallback */
    }
    return { ...r, componentDescription: compMap.get(r.componentId) ?? 'Component', colourLabel: label };
  });
}
