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
    return { kind: 'other', text: `${id} (${s.materialName ?? 'another filament'}), different colour` };
  }
  const text = [id, s.location].filter(Boolean).join(' · ');
  return f.spoolHasEnough ? { kind: 'ok', text } : { kind: 'low', text, left: `only ${formatGrams(Math.max(0, s.effectiveRemaining))} left` };
}

// ---------- Make it (the product page's verdict and plan line) ----------

export interface Verdict {
  tone: 'ok' | 'short' | 'blocked';
  /** The pill: "Ready to print", or "Short on Pine Green: need 22 g, 12 g left". */
  text: string;
  /** The folded row's summary: "Ready to print", "Short on Pine Green". */
  brief: string;
}

/** One verdict for the whole quantity. Blocking problems are listed under the pill by the caller. */
export function verdictOf(r: Readiness): Verdict {
  if (r.problems.length > 0) return { tone: 'blocked', text: 'Not ready', brief: 'Not ready' };

  // One entry per material, even when the filament is split over several lines.
  const shortF = r.filament.filter((f, i, all) => !f.hasEnough && all.findIndex(g => g.materialId === f.materialId) === i);
  const colours = shortF.map(f => f.color?.trim() || f.label);
  const unique = new Set(colours.map(n => n.toLowerCase())).size === colours.length;
  const names = shortF.map((f, i) => (unique ? colours[i] : f.label));
  const shortP = r.parts.filter(p => !p.hasEnough);
  if (shortF.length > 0 || shortP.length > 0) {
    const lines = [
      ...shortF.map((f, i) => `${names[i]}: need ${formatGrams(materialGrams(f))}, ${wholeGrams(Math.max(0, f.free))} left`),
      ...shortP.map(p => `${p.name}: need ${p.needed} pcs, ${Math.max(0, p.free)} left`),
    ];
    return {
      tone: 'short',
      text: `Short on ${lines.join('; ')}`,
      brief: `Short on ${[...names, ...shortP.map(p => p.name)].join(', ')}`,
    };
  }
  if (!r.ready) return { tone: 'blocked', text: 'Not ready', brief: 'Not ready' };
  return { tone: 'ok', text: 'Ready to print', brief: 'Ready to print' };
}

/**
 * The single plan line: "1 plate of 8 on Hi · 1 h 56 min · 7 extra go to stock".
 * A plan whose plates were sliced for one printer says "on <printer>" (it never
 * mixes two); otherwise `printerOf` names the printer of a part's plate when
 * the page knows it.
 */
export function planLine(r: Readiness, printerOf: (componentId: string, layoutId: string | null) => string | null): string {
  const groupsOf = (c: Component) => c.plates.filter(p => p.plateCount > 0);
  const printing = r.components.filter(c => groupsOf(c).length > 0);
  if (printing.length === 0) return 'Covered by printed stock, nothing to print';

  const plates = printing.reduce((n, c) => n + groupsOf(c).reduce((m, p) => m + p.plateCount, 0), 0);
  const minutes = r.components.reduce((n, c) => n + c.printMinutes, 0);
  const extra = r.components.reduce((n, c) => n + c.surplus, 0);

  const on = r.planPrinterName ? ` on ${r.planPrinterName}` : '';
  let head: string;
  if (printing.length === 1) {
    const c = printing[0];
    const groups = groupsOf(c);
    if (groups.length === 1) {
      const printer = r.planPrinterName ?? printerOf(c.componentId, groups[0].layoutId);
      head = `${plural(plates, 'plate')} of ${groups[0].unitsPerPlate}${printer ? ` on ${printer}` : ''}`;
    } else {
      head = `${plural(plates, 'plate')} (${platesText(groups)})${on}`;
    }
  } else {
    head = `${plural(plates, 'plate')} for ${plural(printing.length, 'part')}${on}`;
  }

  const out = [head, formatMinutes(minutes)];
  if (extra > 0) {
    out.push(r.surplusPolicy === 'CANCEL_ON_PRINTER'
      ? `${extra} extra cancelled on the printer`
      : `${extra} extra ${extra === 1 ? 'goes' : 'go'} to stock`);
  }
  return out.join(' · ');
}
