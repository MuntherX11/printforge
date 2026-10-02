/**
 * Merge one filament into another (POST /materials/:id/merge, ADMIN). Every
 * reference to the source filament moves to the target, then the source is
 * deleted. Without `confirm` it is a dry run that only counts.
 *
 * Pure: the api returns these shapes, and the filament page's Merge dialog
 * reads them through materialMergeSummary.
 */

/** The only keys the merge body may carry. */
export const MATERIAL_MERGE_KEYS = ['targetMaterialId', 'confirm'] as const;

export interface MaterialMergeInput {
  targetMaterialId: string;
  /** true = do it; absent or false = dry run (counts only). */
  confirm?: boolean;
}

/** Everything that points at the source filament and would move (or has moved) to the target. */
export interface MaterialMergeCounts {
  /** ProductComponent.materialId: a single-filament part's own filament. */
  componentFilaments: number;
  /** ComponentMaterial: the per-colour slots of multicolour parts. */
  componentColourSlots: number;
  /** ColourOptionSlot: the filament a colour option prints a colour slot in. */
  colourAssignments: number;
  /** JobMaterial lines naming the source in any column (actual, sliced, planned, planned-sliced). */
  jobLines: number;
  /** Of jobLines, the ones on queued, printing or paused jobs. */
  openJobLines: number;
  /** JobPlate snapshots whose colour key or slots name the source. */
  jobPlates: number;
  /** ComponentColourStock rows whose colour key names the source. */
  printedStockRows: number;
  /** Printed units held in those rows. */
  printedStockUnits: number;
  /** Printed stock buckets that join another bucket of the same colour (their units are added together). */
  printedStockCombined: number;
  /** ComponentStockMovement ledger rows whose colour key names the source (relabelled, never deleted). */
  stockMovements: number;
  /** Inactive spools of the source: they move to the target (an active spool blocks the merge). */
  retiredSpools: number;
  /** Products whose parts or colours use the source (they are repriced after the merge). */
  products: number;
}

export interface MaterialMergeSide {
  id: string;
  name: string;
  type: string;
  color: string | null;
  colorHex: string | null;
  brand: string | null;
}

export interface MaterialMergeWarning {
  code: string;
  message: string;
}

export interface MaterialMergeResult {
  /** false = dry run: nothing changed. */
  merged: boolean;
  source: MaterialMergeSide;
  target: MaterialMergeSide;
  counts: MaterialMergeCounts;
  warnings: MaterialMergeWarning[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The dry run in plain words, one line per kind of reference that is not
 * zero, in the order the owner thinks about them. Empty when nothing uses
 * the source (the merge then just deletes it).
 */
export function materialMergeSummary(c: MaterialMergeCounts): string[] {
  const out: string[] = [];
  const parts = c.componentFilaments + c.componentColourSlots;
  if (parts > 0) {
    out.push(`${plural(parts, 'part filament', 'part filaments')} in ${plural(c.products, 'product', 'products')}`);
  }
  if (c.colourAssignments > 0) out.push(plural(c.colourAssignments, 'colour option filament', 'colour option filaments'));
  if (c.jobLines > 0) {
    const open = c.openJobLines > 0 ? ` (${c.openJobLines} on open jobs)` : '';
    out.push(`${plural(c.jobLines, 'job filament line', 'job filament lines')}${open}`);
  }
  if (c.jobPlates > 0) out.push(plural(c.jobPlates, 'job plate', 'job plates'));
  if (c.printedStockRows > 0) {
    out.push(`${plural(c.printedStockUnits, 'printed unit', 'printed units')} in stock (${plural(c.printedStockRows, 'colour bucket', 'colour buckets')})`);
  }
  if (c.stockMovements > 0) out.push(plural(c.stockMovements, 'printed stock history entry', 'printed stock history entries'));
  if (c.retiredSpools > 0) out.push(plural(c.retiredSpools, 'retired spool', 'retired spools'));
  return out;
}
