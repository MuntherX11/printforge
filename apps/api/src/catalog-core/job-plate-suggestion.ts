import { BadRequestException } from '@nestjs/common';
import { PlanCache, PlanError, suggestPlan, unitsOf, type PlannedPlate, type PlannerLayout } from './plate-planner';

/**
 * The plates a new production job suggests (owner spec 2026-10-02 item 4).
 * Pure.
 *
 * Only plates that have a print file on record are suggested: a layout (or a
 * part's own single unit) without a G-code is never picked automatically. Among
 * those, the plan with the least printer time wins — full plate minutes (a
 * plate prints as sliced) plus PLATE_CHANGE_MINUTES for clearing the bed and
 * starting each plate — then the fewest plates, then the fewest extras. So 45
 * units with a ×20 file (300 min) and a single-unit file (20 min) are ×20, ×20
 * and 5 × ×1, not 3 × ×20; 40 units are 2 × ×20, never 40 singles, and a
 * small remainder that a big plate prints almost as fast goes on the big plate
 * (the planner's fewest-plates rule).
 *
 * When a part has no plate with a file at all, the old suggestion (fewest
 * plates, then least surplus, over every usable plate) is kept and the caller
 * warns "No G-code on file for <part> — upload one". The bulk-price floor never
 * uses this: it keeps suggestPlan.
 *
 * Printers (v2.18.2): a plate sliced in the app belongs to the printer it was
 * sliced for (`printerId`); every other plate prints on any printer. A job has
 * one printer, so a plan never mixes plates of two. With a printer, only its
 * plates and the printer-agnostic ones are used. Without one, one candidate
 * plan is built per printer (its plates plus the agnostic ones) and one from
 * the agnostic plates alone, and the best is kept. A product whose plates have
 * no printer plans exactly as before.
 */

export interface PrinterScope {
  id: string;
  name: string;
}

export interface JobPlateSuggestion {
  plates: PlannedPlate[];
  /** true when no usable plate has a file, so the plan came from plates without one */
  noFile: boolean;
  /** the printer that has no plate with a file for this part, while another printer has one */
  missingFor?: PrinterScope;
  /** true when nothing this printer can print exists for the part: `plates` is empty */
  blocked?: boolean;
}

const EPS = 1e-6;
/** Printer time counted per plate on top of its sliced minutes: clear the bed, heat up, first layer. */
export const PLATE_CHANGE_MINUTES = 10;
/** Above this many units the DP runs on the remainder after the most time-efficient plates. */
const DP_UNITS = 20_000;

export const hasFile = (l: PlannerLayout) => !!l.attachmentId;

/** One layout per plate size: the lower minutes per unit (then the earlier) wins. */
function bySize(layouts: ReadonlyArray<PlannerLayout>): PlannerLayout[] {
  const best = new Map<number, PlannerLayout>();
  for (const l of layouts) {
    if (!(l.unitsPerPlate >= 1)) continue;
    const prev = best.get(l.unitsPerPlate);
    if (!prev || l.plateMinutes / l.unitsPerPlate < prev.plateMinutes / prev.unitsPerPlate - EPS) best.set(l.unitsPerPlate, l);
  }
  return [...best.values()].sort((a, b) => b.unitsPerPlate - a.unitsPerPlate);
}

/** Least total plate minutes covering N units; then fewest plates; then least surplus. Grouped, largest plates first. */
export function quickestPlan(N: number, layouts: ReadonlyArray<PlannerLayout>): PlannedPlate[] {
  if (N <= 0) return [];
  const L = bySize(layouts);
  if (!L.length) return [];
  const counts = new Map<PlannerLayout, number>();

  // Very large runs: pre-assign the most time-efficient plate so the table stays small.
  let n = N;
  if (n > DP_UNITS) {
    const bulk = [...L].sort((a, b) => a.plateMinutes / a.unitsPerPlate - b.plateMinutes / b.unitsPerPlate || b.unitsPerPlate - a.unitsPerPlate)[0];
    const k = Math.floor((n - DP_UNITS) / bulk.unitsPerPlate);
    counts.set(bulk, k);
    n -= k * bulk.unitsPerPlate;
  }

  const umax = L[0].unitsPerPlate;
  const M = n + umax - 1;
  const minutes = new Float64Array(M + 1).fill(Infinity);
  const plates = new Int32Array(M + 1);
  const choice = new Int32Array(M + 1).fill(-1);
  minutes[0] = 0;
  for (let x = 1; x <= M; x++) {
    for (let i = 0; i < L.length; i++) {
      const u = L[i].unitsPerPlate;
      if (u > x || minutes[x - u] === Infinity) continue;
      const m = minutes[x - u] + L[i].plateMinutes + PLATE_CHANGE_MINUTES;
      const p = plates[x - u] + 1;
      const better = m < minutes[x] - EPS || (Math.abs(m - minutes[x]) <= EPS && p < plates[x]);
      if (better) {
        minutes[x] = m;
        plates[x] = p;
        choice[x] = i;
      }
    }
  }
  let best = -1;
  for (let x = n; x <= M; x++) {
    if (minutes[x] === Infinity) continue;
    if (best < 0 || minutes[x] < minutes[best] - EPS || (Math.abs(minutes[x] - minutes[best]) <= EPS && plates[x] < plates[best])) best = x;
  }
  if (best < 0) return [];
  for (let x = best; x > 0; x -= L[choice[x]].unitsPerPlate) {
    const l = L[choice[x]];
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[0].unitsPerPlate - a[0].unitsPerPlate)
    .map(([layout, plateCount]) => ({ layout, plateCount }));
}

/** `No plate sliced for Hi for "Box"`: the no-G-code warning when the job's printer is the reason. */
export const noPlateSlicedFor = (printer: string, description: string) => `No plate sliced for ${printer} for "${description}"`;

/** "No G-code on file for "Box" — upload one" (owner wording). */
export const noGcodeOnFile = (description: string) => `No G-code on file for "${description}" — upload one`;

export interface JobPart {
  key: string;
  units: number;
  layouts: ReadonlyArray<PlannerLayout>;
}

export interface JobPlanOptions {
  /** The job's printer: only its plates and the printer-agnostic ones are used. null or absent = none chosen. */
  printer?: PrinterScope | null;
  /**
   * With no printer chosen: the printer to plan for when it has a plate with a
   * file for every part that some printer has one for (the product's default
   * printer). Otherwise the best printer is chosen as if it were not given.
   */
  prefer?: PrinterScope | null;
}

export interface JobPlanSuggestion {
  /** per part key; a part with no plate at all has no entry (NO_USABLE_LAYOUT) */
  parts: Map<string, JobPlateSuggestion>;
  /** the printer the suggested plates were sliced for; null when every one prints on any printer */
  planPrinter: PrinterScope | null;
}

/** The printer of a set of plates (they never mix two), or null when all print on any printer. */
export function printerOfPlates(plates: Iterable<PlannedPlate>): PrinterScope | null {
  for (const p of plates) if (p.layout.printerId) return { id: p.layout.printerId, name: p.layout.printerName ?? 'that printer' };
  return null;
}

/** One part on one printer; `printer` null = the printer-agnostic plates only. null = the part has no plate at all. */
function suggestFor(R: number, layouts: ReadonlyArray<PlannerLayout>, cache: PlanCache | undefined, printer: PrinterScope | null): JobPlateSuggestion | null {
  if (R <= 0) return { plates: [], noFile: false };
  if (!layouts.length) return null;
  const fits = (l: PlannerLayout) => !l.printerId || l.printerId === printer?.id;
  // The same array when nothing is left out, so the planner's per-array memo still hits.
  const usable = layouts.every(fits) ? layouts : layouts.filter(fits);
  const withFile = usable.filter(hasFile);
  if (withFile.length) return { plates: quickestPlan(R, withFile), noFile: false };
  if (!usable.length) return { plates: [], noFile: true, blocked: true, ...(printer ? { missingFor: printer } : {}) };
  const elsewhere = printer !== null && layouts.some((l) => hasFile(l) && !fits(l));
  return { plates: suggestPlan(R, usable, cache), noFile: true, ...(elsewhere ? { missingFor: printer! } : {}) };
}

interface Candidate {
  parts: Map<string, JobPlateSuggestion>;
  /** blocked parts, parts planned without a file, printer minutes incl. changeovers, plates, extras */
  score: [number, number, number, number, number];
}

function candidate(parts: ReadonlyArray<JobPart>, cache: PlanCache | undefined, printer: PrinterScope | null): Candidate {
  const out = new Map<string, JobPlateSuggestion>();
  const score: Candidate['score'] = [0, 0, 0, 0, 0];
  for (const part of parts) {
    const s = suggestFor(part.units, part.layouts, cache, printer);
    if (!s) continue;
    out.set(part.key, s);
    if (s.blocked) score[0]++;
    else if (s.noFile) score[1]++;
    for (const p of s.plates) {
      score[2] += p.plateCount * (p.layout.plateMinutes + PLATE_CHANGE_MINUTES);
      score[3] += p.plateCount;
    }
    if (s.plates.length) score[4] += unitsOf(s.plates) - part.units;
  }
  return { parts: out, score };
}

/** Fewest blocked parts, fewest parts without a file, quickest, fewest plates, fewest extras. */
function better(a: Candidate['score'], b: Candidate['score']): boolean {
  for (let i = 0; i < a.length; i++) {
    const eps = i === 2 ? EPS : 0;
    if (a[i] < b[i] - eps) return true;
    if (a[i] > b[i] + eps) return false;
  }
  return false;
}

/**
 * The plates of a whole job (every part that needs a suggestion), for one
 * printer: see the header. Never mixes plates sliced for two printers.
 */
export function suggestJobPlan(parts: ReadonlyArray<JobPart>, opts: JobPlanOptions = {}, cache?: PlanCache): JobPlanSuggestion {
  const done = (c: Candidate): JobPlanSuggestion => ({
    parts: c.parts,
    planPrinter: printerOfPlates([...c.parts.values()].flatMap((s) => s.plates)),
  });
  if (opts.printer) return done(candidate(parts, cache, opts.printer));

  const printers = new Map<string, PrinterScope>();
  for (const part of parts) {
    if (part.units <= 0) continue;
    for (const l of part.layouts) if (l.printerId && !printers.has(l.printerId)) printers.set(l.printerId, { id: l.printerId, name: l.printerName ?? 'that printer' });
  }
  // No plate belongs to a printer: the plan of before.
  if (!printers.size) return done(candidate(parts, cache, null));

  if (opts.prefer) {
    const c = candidate(parts, cache, opts.prefer);
    if (![...c.parts.values()].some((s) => s.blocked || s.missingFor)) return done(c);
  }
  // Printer-agnostic plates alone first, so a tie never ties the job to a printer.
  let best = candidate(parts, cache, null);
  const ordered = [...printers.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  for (const printer of ordered) {
    const c = candidate(parts, cache, printer);
    if (better(c.score, best.score)) best = c;
  }
  return done(best);
}

/**
 * The job suggestion for R units of one part. Throws PlanError (as suggestPlan
 * does) when the part has no usable plate at all.
 */
export function suggestJobPlates(R: number, layouts: ReadonlyArray<PlannerLayout>, cache?: PlanCache, opts: JobPlanOptions = {}): JobPlateSuggestion {
  if (R <= 0) return { plates: [], noFile: false };
  const s = suggestJobPlan([{ key: '', units: R, layouts }], opts, cache).parts.get('');
  if (!s) throw new PlanError('NO_USABLE_LAYOUT');
  return s;
}

const listOf = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * A job has one printer (v2.18.2). Throws 400 when chosen plates do not fit
 * it: a plate sliced for another printer than the job's, or, with no printer
 * chosen, plates sliced for two different printers. Returns the printer the
 * plates were sliced for (null = they print on any printer).
 */
export function assertOnePrinter(
  chosen: ReadonlyArray<{ description: string; plates: ReadonlyArray<PlannedPlate> }>,
  printer?: PrinterScope | null,
): PrinterScope | null {
  const seen = new Map<string, string>();
  for (const c of chosen) {
    for (const p of c.plates) {
      const l = p.layout;
      if (!l.printerId) continue;
      const name = l.printerName ?? 'another printer';
      if (printer && l.printerId !== printer.id) {
        throw new BadRequestException(`"${c.description}": plate ×${l.unitsPerPlate} is sliced for ${name}, not ${printer.name}`);
      }
      seen.set(l.printerId, name);
    }
  }
  if (seen.size > 1) {
    const names = [...seen.values()].sort((a, b) => a.localeCompare(b));
    throw new BadRequestException(`These plates are sliced for different printers (${listOf(names)}). Choose one printer.`);
  }
  const [first] = seen.entries();
  return first ? { id: first[0], name: first[1] } : null;
}
