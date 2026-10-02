/**
 * Production readiness, said briefly (v2.17.3): one status line, the plan
 * lines that say something, and how a filament's spool reads. Pure.
 */
import { formatGrams, formatMinutes, plural } from '@/lib/product-format';
import type { Readiness } from '@/lib/types/api';

type Filament = Readiness['filament'][number];
type Component = Readiness['components'][number];

/** "After open orders" is judged per material: one filament can be split over several lines. */
export const materialGrams = (f: Filament) => f.materialGramsNeeded ?? f.gramsNeeded;
export const shortBy = (f: Filament) => Math.max(0, materialGrams(f) - f.free);

/** Whole grams with a thousands separator: "0 g", "1,419 g". */
export const wholeGrams = (g: number) => `${Math.round(g).toLocaleString('en-US')} g`;

export interface ReadinessStatus {
  tone: 'ok' | 'short' | 'blocked';
  text: string;
}

/** The one line the card shows before "Show details". */
export function readinessStatus(r: Readiness): ReadinessStatus {
  if (r.problems.length > 0) return { tone: 'blocked', text: 'Not ready' };

  // One entry per material, even when the filament is split over several lines.
  const shortF = r.filament.filter((f, i, all) => !f.hasEnough && all.findIndex(g => g.materialId === f.materialId) === i);
  const names = shortF.map(f => f.color?.trim() || f.label);
  const unique = new Set(names.map(n => n.toLowerCase())).size === names.length;
  const shortP = r.parts.filter(p => !p.hasEnough);
  const shorts: string[] = [];
  if (shortF.length > 0) {
    shorts.push(`Short on ${plural(shortF.length, 'filament')}: ${shortF.map((f, i) => `${unique ? names[i] : f.label} ${formatGrams(shortBy(f))}`).join(', ')}`);
  }
  if (shortP.length > 0) {
    shorts.push(`Short on ${plural(shortP.length, 'part')}: ${shortP.map(p => `${p.name} ${Math.max(0, p.needed - p.free)} pcs`).join(', ')}`);
  }
  if (shorts.length > 0) return { tone: 'short', text: shorts.join('; ') };
  if (!r.ready) return { tone: 'blocked', text: 'Not ready' };

  const plates = r.components.reduce((n, c) => n + c.plates.reduce((m, p) => m + p.plateCount, 0), 0);
  if (plates === 0) return { tone: 'ok', text: '✓ Ready — covered by printed stock' };
  const grams = r.filament.reduce((n, f) => n + f.gramsNeeded, 0);
  const minutes = r.components.reduce((n, c) => n + c.printMinutes, 0);
  return { tone: 'ok', text: `✓ Ready — ${plural(plates, 'plate')} · ${formatGrams(grams)} · ${formatMinutes(minutes)}` };
}

/** "12 + 12 + 8", or "5 × 12 + 8" when there are many plates. */
export function platesText(plates: Component['plates']): string {
  const total = plates.reduce((n, p) => n + p.plateCount, 0);
  if (total <= 6) return plates.flatMap(p => Array.from({ length: p.plateCount }, () => String(p.unitsPerPlate))).join(' + ');
  return plates.map(p => (p.plateCount > 1 ? `${p.plateCount} × ${p.unitsPerPlate}` : String(p.unitsPerPlate))).join(' + ');
}

/**
 * Plan lines only for the parts where they say something: more than one
 * plate, a layout of several, extras, or nothing to print. `restOnce` = some
 * other parts simply print once.
 */
export function planLines(components: Component[]): { lines: string[]; restOnce: boolean } {
  const lines: string[] = [];
  let restOnce = false;
  for (const c of components) {
    const plates = c.plates.reduce((n, p) => n + p.plateCount, 0);
    if (c.unitsRequired === 0) {
      lines.push(`${c.description}: covered by printed stock`);
    } else if (plates > 1 || c.plates.some(p => p.unitsPerPlate > 1) || c.surplus > 0) {
      const extra = c.surplus > 0 ? ` (${c.surplus} extra)` : '';
      lines.push(`${c.description}: ${c.unitsRequired} needed → ${plural(plates, 'plate')}, ${platesText(c.plates)}${extra}`);
    } else {
      restOnce = true;
    }
  }
  return { lines, restOnce };
}

export type SpoolNote =
  | { kind: 'none' }
  | { kind: 'ok'; text: string }
  | { kind: 'low'; text: string; left: string }
  | { kind: 'other'; text: string };

/** How the suggested spool reads: never "short" and "enough" together. */
export function spoolNote(f: Filament): SpoolNote {
  const s = f.suggestedSpool;
  if (!s) return { kind: 'none' };
  const id = s.pfid ?? 'Spool';
  // A spool of another filament (same type, nearest colour) is a substitute.
  if (s.materialId && s.materialId !== f.materialId) {
    return { kind: 'other', text: `${id} (${s.materialName ?? 'another filament'}) — different colour` };
  }
  const text = [id, s.location].filter(Boolean).join(' · ');
  return f.spoolHasEnough ? { kind: 'ok', text } : { kind: 'low', text, left: `only ${formatGrams(Math.max(0, s.effectiveRemaining))} left` };
}
