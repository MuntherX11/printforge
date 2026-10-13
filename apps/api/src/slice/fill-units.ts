/**
 * "Fill the plate" for an OrcaSlicer project (slicer plan D12). A project has
 * no bounding box PrintForge can read, so the first fill asks for 100 copies
 * and the slicer drops what does not fit — slow when only 15 do. Once a run on
 * the same printer has come back with fewer units than it was asked for, the
 * plate's capacity is known: ask for that many plus a small margin instead.
 * Before any such run, the footprint of the part's own sliced x1 file gives an
 * estimate (file-parser/plate-footprint.ts), so the first fill is not 100 either.
 *
 * Order: previous fill count (+2), else the footprint estimate, else 100.
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

/** Units the newest run that hit the plate's capacity placed (what fits); null when none has. */
export function pastCapacity(doneRuns: ReadonlyArray<PastRun>): number | null {
  return doneRuns.find(hitCapacity)?.unitsSliced ?? null;
}

/** What an earlier run showed fits, plus the margin; null when no run has hit the plate's capacity. */
export function pastFillUnits(doneRuns: ReadonlyArray<PastRun>): number | null {
  const full = pastCapacity(doneRuns);
  return full !== null ? Math.min(PROJECT_FILL_UNITS, full + PROJECT_FILL_MARGIN) : null;
}

/** `estimate`: copies from the x1 file's footprint; null (or not a whole number from 1) when there is none. */
export function projectFillUnits(doneRuns: ReadonlyArray<PastRun>, estimate: number | null = null): number {
  const past = pastFillUnits(doneRuns);
  if (past !== null) return past;
  if (typeof estimate === 'number' && Number.isInteger(estimate) && estimate >= 1) return Math.min(PROJECT_FILL_UNITS, estimate);
  return PROJECT_FILL_UNITS;
}
