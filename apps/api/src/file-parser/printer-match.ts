/**
 * Match the printer model a G-code was sliced for (printer-model.ts) to one of
 * the farm's printers, by the printer's model field first and then its name.
 * Pure, no I/O.
 *
 * Words are compared after normalising case and punctuation, so "Creality
 * Ender-3 V3" matches a printer named "Ender 3 V3". A printer matches when all
 * of its words are in the sliced-for name (or the other way round), or when the
 * one written without spaces contains the other ("Ender3V3"). The most
 * specific match wins; an exact match beats everything.
 */

export interface MatchablePrinter {
  id: string;
  name: string;
  model?: string | null;
  isActive?: boolean;
}

export const words = (s: string): string[] =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

const compact = (s: string) => words(s).join('');

function scoreOf(field: string, detected: string): number {
  const t = words(field);
  const d = words(detected);
  if (!t.length || !d.length) return 0;
  if (compact(field) === compact(detected)) return 100;
  const dSet = new Set(d);
  const tSet = new Set(t);
  if (t.every((w) => dSet.has(w))) return 10 + t.length;
  if (d.every((w) => tSet.has(w))) return 5 + d.length;
  const cf = compact(field);
  const cd = compact(detected);
  if (cf.length >= 3 && cd.includes(cf)) return 3 + cf.length / 100;
  if (cd.length >= 3 && cf.includes(cd)) return 2 + cd.length / 100;
  return 0;
}

/** The best active printer for a sliced-for model, or null. */
export function matchPrinter<P extends MatchablePrinter>(slicedFor: string | null | undefined, printers: ReadonlyArray<P>): P | null {
  if (!slicedFor || !words(slicedFor).length) return null;
  let best: P | null = null;
  let bestScore = 0;
  for (const p of printers) {
    if (p.isActive === false) continue;
    // The model field is what the printer IS; the name is what the farm calls it.
    const byModel = p.model ? scoreOf(p.model, slicedFor) : 0;
    const s = Math.max(byModel > 0 ? byModel + 0.5 : 0, scoreOf(p.name, slicedFor));
    if (s > bestScore || (s === bestScore && s > 0 && best && p.name.localeCompare(best.name) < 0)) {
      best = p;
      bestScore = s;
    }
  }
  return bestScore > 0 ? best : null;
}

/** "Sliced for <model> — no matching printer" (owner wording). */
export const noMatchingPrinter = (slicedFor: string) => `Sliced for ${slicedFor} — no matching printer`;
