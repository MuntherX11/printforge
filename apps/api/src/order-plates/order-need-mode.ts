import type { OrderNeedMode } from '@printforge/types';

/**
 * How a plan row can be printed (owner decisions 2026-10-13). Pure: the needs
 * service gathers the facts, this decides.
 *
 *  - PROJECT: a 3MF project with two or more colours. It never shares a plate
 *    and prints on the printer the project names.
 *  - MIX: a model (an STL, or a one-slot project — only its shape is used) and
 *    one filament. It may share a plate with other parts of that filament.
 *  - LAYOUT: no model, but plates of its own.
 *  - BLOCKED: none of these works yet; `blockedReason` says what to do.
 */

export interface NeedFacts {
  description: string;
  pendingFirstSlice: boolean;
  /** The part prints in several colours (the product's own flag). */
  isMultiColor: boolean;
  source: { kind: 'STL' | 'THREEMF'; projectSlots: number; printerModel: string | null } | null;
  /** The farm printer the project names (active), and whether it has a machine profile. */
  projectPrinter: { id: string; name: string; hasMachine: boolean } | null;
  /** The filament of every slot the slicer needs: slot 0 for a MIX part, the project's slots for a PROJECT. */
  filaments: Array<{ slot: number; materialId: string | null; name: string; type: string; hasPreset: boolean }>;
  layoutCount: number;
}

export interface NeedMode {
  mode: OrderNeedMode;
  blockedReason: string | null;
  canOwnSettings: boolean;
  lockedPrinterId: string | null;
}

const blocked = (reason: string): NeedMode => ({ mode: 'BLOCKED', blockedReason: reason, canOwnSettings: false, lockedPrinterId: null });

function filamentProblem(f: NeedFacts): string | null {
  if (!f.filaments.length) return `"${f.description}" has no filament set`;
  for (const s of f.filaments) {
    if (!s.materialId) return `"${f.description}": colour ${s.slot + 1} has no filament`;
    if (!s.hasPreset) return `"${s.name}" has no slicer preset, and there is no main preset for ${s.type} — set one in Settings › Slicer`;
  }
  return null;
}

export function needModeOf(f: NeedFacts): NeedMode {
  if (f.pendingFirstSlice) return blocked(`"${f.description}" has not been sliced yet — slice one unit on the product page first`);
  if (!f.source) {
    if (f.layoutCount > 0) return { mode: 'LAYOUT', blockedReason: null, canOwnSettings: false, lockedPrinterId: null };
    return blocked(`"${f.description}" has no model and no plate file — add one on the product page`);
  }
  const project = f.source.kind === 'THREEMF';
  if (project && (f.source.projectSlots >= 2 || f.isMultiColor)) {
    if (!f.projectPrinter) {
      return blocked(f.source.printerModel
        ? `The project of "${f.description}" is set up for "${f.source.printerModel}", which matches none of your printers`
        : `The project of "${f.description}" does not name a printer`);
    }
    if (!f.projectPrinter.hasMachine) return blocked(`${f.projectPrinter.name} has no machine profile — import one in Settings › Slicer`);
    const bad = filamentProblem(f);
    if (bad) return blocked(bad);
    return { mode: 'PROJECT', blockedReason: null, canOwnSettings: false, lockedPrinterId: f.projectPrinter.id };
  }
  if (f.isMultiColor || f.filaments.length > 1) {
    return blocked(`"${f.description}" prints in several colours, but its model is a single shape — upload its project (.3mf) on the product page`);
  }
  const bad = filamentProblem(f);
  if (bad) return blocked(bad);
  return {
    mode: 'MIX', blockedReason: null, lockedPrinterId: null,
    // A one-slot project can also print alone with its own settings, where its project says.
    canOwnSettings: project && !!f.projectPrinter?.hasMachine,
  };
}
