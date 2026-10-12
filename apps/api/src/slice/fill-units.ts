/**
 * "Fill the plate" for an OrcaSlicer project (slicer plan D12). A project has
 * no bounding box PrintForge can read, so the first fill asks for 100 copies
 * and the slicer drops what does not fit — slow when only 15 do. Once a run on
 * the same printer has come back with fewer units than it was asked for, the
 * plate's capacity is known: ask for that many plus a small margin instead.
 *
 * Pure: the caller passes the part's DONE runs on the printer, newest first.
 */

export const PROJECT_FILL_UNITS = 100;
/** Extra copies over the known capacity, in case another filament packs tighter. */
export const PROJECT_FILL_MARGIN = 2;

export interface PastRun {
  unitsRequested: number;
  unitsSliced: number | null;
}

/** A run that hit the plate's capacity: more than one unit asked for, fewer placed. */
function hitCapacity(r: PastRun): r is { unitsRequested: number; unitsSliced: number } {
  const sliced = r.unitsSliced;
  return typeof sliced === 'number' && Number.isInteger(sliced) && sliced > 0 && r.unitsRequested > 1 && sliced < r.unitsRequested;
}

export function projectFillUnits(doneRuns: ReadonlyArray<PastRun>): number {
  const full = doneRuns.find(hitCapacity);
  return full ? Math.min(PROJECT_FILL_UNITS, full.unitsSliced + PROJECT_FILL_MARGIN) : PROJECT_FILL_UNITS;
}
