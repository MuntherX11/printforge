/**
 * Pure view logic of the order's Print files card (v2.19.0): plates grouped by
 * printer, the summary line, the warning sentences, what "Create jobs" leaves
 * out, the plate drawing's colours and geometry. No React, no fetch.
 */
import {
  OrderNeedMode,
  OrderPlateKind,
  OrderPlateStatus,
  plateTotalMinutes,
  type OrderPlanNeedDto,
  type OrderPlateDto,
  type OrderPlateEvent,
  type OrderPlateItemDto,
  type OrderPrintPlanDto,
} from '@printforge/types';
import { formatMinutes, plural } from '@/lib/product-format';

// ---------- names ----------

type Named = Pick<OrderPlateItemDto, 'productName' | 'componentDescription' | 'optionLabel'>;

/** The part as a sentence names it: "dress (Large)". */
export function partPhrase(x: Named): string {
  const name = x.componentDescription || x.productName || 'part';
  return x.optionLabel ? `${name} (${x.optionLabel})` : name;
}

/** The part's bold line and the quiet line under it. */
export function partTitle(x: Named): string {
  return x.componentDescription || x.productName || 'Part';
}

export function partSub(x: Named & { colourLabel?: string }): string {
  const product = x.productName && x.productName !== x.componentDescription ? x.productName : '';
  return [product, x.optionLabel, x.colourLabel ?? ''].filter(Boolean).join(' · ');
}

// ---------- plates ----------

export function isSlicing(p: Pick<OrderPlateDto, 'status'>): boolean {
  return p.status === OrderPlateStatus.QUEUED || p.status === OrderPlateStatus.RUNNING;
}

export function anySlicing(plan: Pick<OrderPrintPlanDto, 'plates'> | null): boolean {
  return plan !== null && plan.plates.some(isSlicing);
}

/** A plate "Slice all" would queue: not sliced yet (or failed), sliced from models, no jobs. */
export function needsSlicing(p: Pick<OrderPlateDto, 'status' | 'kind' | 'locked'>): boolean {
  return !p.locked && p.kind !== OrderPlateKind.LAYOUT
    && (p.status === OrderPlateStatus.DRAFT || p.status === OrderPlateStatus.FAILED);
}

/** A plate "Create jobs" turns into jobs. */
export function readyForJobs(p: Pick<OrderPlateDto, 'status' | 'locked'>): boolean {
  return !p.locked && p.status === OrderPlateStatus.DONE;
}

export interface PlateChip {
  text: string;
  variant: 'default' | 'info' | 'success' | 'error';
}

export function plateChip(p: Pick<OrderPlateDto, 'status'>): PlateChip {
  switch (p.status) {
    case OrderPlateStatus.QUEUED: return { text: 'Queued', variant: 'default' };
    case OrderPlateStatus.RUNNING: return { text: 'Slicing…', variant: 'info' };
    case OrderPlateStatus.DONE: return { text: 'Ready', variant: 'success' };
    case OrderPlateStatus.FAILED: return { text: 'Failed', variant: 'error' };
    default: return { text: 'Not sliced', variant: 'default' };
  }
}

export const LOCKED_REASON = 'Jobs were made from this plate, so it can no longer be changed.';
export const SLICING_REASON = 'Being sliced right now — it can be changed once that is done.';

/** Why nothing on the plate can be changed; null when it can. */
export function editLock(p: Pick<OrderPlateDto, 'locked' | 'status'>): string | null {
  if (p.locked) return LOCKED_REASON;
  return p.status === OrderPlateStatus.RUNNING ? SLICING_REASON : null;
}

/** True for a plate of one multi-colour project (it never moves and never shares). */
export function isMultiColour(p: Pick<OrderPlateDto, 'kind' | 'filaments' | 'items'>, needs: ReadonlyArray<OrderPlanNeedDto>): boolean {
  if (p.kind !== OrderPlateKind.PROJECT) return false;
  if (p.filaments.length > 1) return true;
  const need = needs.find(n => n.rowKey === p.items[0]?.rowKey);
  return need?.mode === OrderNeedMode.PROJECT;
}

/** Why the plate's printer cannot be changed; null when it can. */
export function printerLock(p: OrderPlateDto, needs: ReadonlyArray<OrderPlanNeedDto>): string | null {
  const lock = editLock(p);
  if (lock) return lock;
  if (p.kind !== OrderPlateKind.PROJECT) return null;
  return isMultiColour(p, needs)
    ? 'A multi-colour project always prints on the printer it was made for.'
    : 'It prints with its own settings, which were made for this printer. To move it, delete this plate and add the part to a shared plate.';
}

/** One quiet line saying what kind of plate it is, in shop words; null for an ordinary shared plate. */
export function plateKindNote(p: OrderPlateDto, needs: ReadonlyArray<OrderPlanNeedDto>): string | null {
  if (p.kind === OrderPlateKind.LAYOUT) {
    const count = Math.max(1, p.plateCount || 1);
    return count > 1 ? `An existing file, printed ${count} times` : 'An existing file';
  }
  if (p.kind === OrderPlateKind.PROJECT) return isMultiColour(p, needs) ? 'Multi-colour project' : 'Printed alone with its own settings';
  return null;
}

/** Parts the slicer could not fit: DONE with fewer units than asked. */
export function tooFullItems(p: Pick<OrderPlateDto, 'status' | 'items'>): OrderPlateItemDto[] {
  if (p.status !== OrderPlateStatus.DONE) return [];
  return p.items.filter(it => it.unitsSliced !== null && it.unitsSliced < it.units);
}

export function tooFullSentence(p: Pick<OrderPlateDto, 'label'>, it: OrderPlateItemDto, tail = 'still need a plate'): string {
  const missing = it.units - (it.unitsSliced ?? 0);
  return `${p.label} holds ${it.unitsSliced ?? 0} of ${it.units} ${partPhrase(it)} — ${missing} ${tail}.`;
}

/** Apply an `order-plate` websocket event; an unknown plate means the plan must be refetched. */
export function applyPlateEvent(plan: OrderPrintPlanDto, ev: OrderPlateEvent): { plan: OrderPrintPlanDto; known: boolean } {
  let known = false;
  const plates = plan.plates.map(p => {
    if (p.id !== ev.id) return p;
    known = true;
    return { ...p, status: ev.status, error: ev.error };
  });
  return { plan: known ? { ...plan, plates } : plan, known };
}

// ---------- grouping and the summary line ----------

export interface PrinterGroup {
  key: string;
  printerId: string | null;
  name: string;
  /** Physical plates (an existing file printed 3 times counts 3). */
  plateCount: number;
  minutes: number;
  plates: OrderPlateDto[];
}

const physicalPlates = (p: Pick<OrderPlateDto, 'plateCount'>) => Math.max(1, p.plateCount || 1);

/** Plates by printer, printers in the plan's order, plates with no printer last. */
export function groupByPrinter(plan: Pick<OrderPrintPlanDto, 'plates' | 'printers'>): PrinterGroup[] {
  const groups = new Map<string, PrinterGroup>();
  const sorted = [...plan.plates].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
  for (const p of sorted) {
    const key = p.printerId ?? '';
    let g = groups.get(key);
    if (!g) {
      const name = key ? p.printerName ?? plan.printers.find(x => x.id === key)?.name ?? 'Printer' : 'No printer chosen';
      g = { key, printerId: p.printerId, name, plateCount: 0, minutes: 0, plates: [] };
      groups.set(key, g);
    }
    g.plates.push(p);
    g.plateCount += physicalPlates(p);
    g.minutes += plateTotalMinutes(p);
  }
  const rank = (g: PrinterGroup) => {
    if (!g.printerId) return Number.MAX_SAFE_INTEGER;
    const i = plan.printers.findIndex(x => x.id === g.printerId);
    return i < 0 ? plan.printers.length : i;
  };
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** "5 plates · Hi 3 h 10 min · Ender 2 h 40 min · done in about 3 h 10 min" */
export function summaryLine(plan: Pick<OrderPrintPlanDto, 'finishMinutes'>, groups: ReadonlyArray<PrinterGroup>): string {
  const total = groups.reduce((n, g) => n + g.plateCount, 0);
  const parts = [plural(total, 'plate')];
  for (const g of groups) {
    if (g.minutes > 0) parts.push(`${g.printerId ? g.name : 'no printer'} ${formatMinutes(g.minutes)}`);
  }
  const longest = groups.reduce((m, g) => (g.printerId ? Math.max(m, g.minutes) : m), 0);
  const finish = Number.isFinite(plan.finishMinutes) && plan.finishMinutes > 0 ? plan.finishMinutes : longest;
  if (finish > 0) parts.push(`done in about ${formatMinutes(finish)}`);
  return parts.join(' · ');
}

// ---------- needs ----------

export interface NeedCoverage {
  need: OrderPlanNeedDto;
  planned: number;
  /** Units still on no plate (0 when covered). */
  short: number;
  /** Units more than the order needs (0 when not over). */
  over: number;
  /** It cannot be prepared and is not covered by a plate either. */
  blocked: boolean;
}

/**
 * What each need has on plates, exactly as the API counts it (`planned` counts
 * the units really sliced once a plate is sliced); nothing is recomputed here.
 */
export function coverage(plan: Pick<OrderPrintPlanDto, 'needs'>): NeedCoverage[] {
  return plan.needs.map(need => {
    const planned = Number.isFinite(need.planned) ? need.planned : 0;
    const short = Math.max(0, need.toProduce - planned);
    const over = Math.max(0, planned - need.toProduce);
    return { need, planned, short, over, blocked: need.mode === OrderNeedMode.BLOCKED && short > 0 };
  });
}

export function coverageText(c: NeedCoverage): { text: string; tone: 'ok' | 'warn' | 'quiet' } {
  if (c.short > 0) return { text: `${c.short} short`, tone: 'warn' };
  if (c.over > 0) return { text: `${c.over} extra`, tone: 'warn' };
  return c.need.toProduce > 0 ? { text: 'Covered', tone: 'ok' } : { text: '—', tone: 'quiet' };
}

const stillHave = (n: number) => (n === 1 ? 'still has' : 'still have');

// ---------- warnings ----------

/**
 * The plan's warnings as plain sentences. The API's own sentences come first;
 * for anything it did not report (short, over, cannot be prepared, plate too
 * full, slicer down) the card writes the sentence itself, so a warning is
 * never lost and never said twice.
 */
export function warningSentences(plan: OrderPrintPlanDto): string[] {
  const out: string[] = [];
  const push = (m: string | null | undefined) => {
    const t = (m ?? '').trim();
    if (t && !out.includes(t)) out.push(t);
  };
  for (const w of plan.warnings) push(w.message);
  const has = (code: string) => plan.warnings.some(w => w.code === code);
  const rows = coverage(plan);

  if (!plan.slicerReachable && !has('SLICER_DOWN')) push('The slicer is not reachable right now. Plates can be changed, but not sliced.');
  if (!has('BLOCKED')) {
    for (const c of rows) if (c.blocked) push(`${partPhrase(c.need)} cannot be prepared here: ${c.need.blockedReason ?? 'it has nothing to print from'}`);
  }
  if (!has('PLATE_TOO_FULL')) {
    for (const p of plan.plates) for (const it of tooFullItems(p)) push(tooFullSentence(p, it));
  }
  if (!has('SHORT')) {
    for (const c of rows) if (c.short > 0 && !c.blocked) push(`${partPhrase(c.need)}: ${c.short} of ${c.need.toProduce} ${stillHave(c.short)} no plate.`);
  }
  if (!has('OVER')) {
    for (const c of rows) if (c.over > 0) push(`${partPhrase(c.need)}: the plates hold ${c.over} more than the order needs.`);
  }
  return out;
}

// ---------- Create jobs ----------

export interface JobsPreview {
  /** Plates that become jobs. */
  ready: OrderPlateDto[];
  /** Exactly what gets no job, one sentence each; empty when nothing is left out. */
  leftOut: string[];
}

export function jobsPreview(plan: OrderPrintPlanDto): JobsPreview {
  const ready = plan.plates.filter(readyForJobs);
  const leftOut: string[] = [];
  for (const p of plan.plates) {
    if (p.locked || p.status === OrderPlateStatus.DONE) continue;
    const why = isSlicing(p) ? 'is still being sliced' : p.status === OrderPlateStatus.FAILED ? 'failed to slice' : 'is not sliced yet';
    leftOut.push(`${p.label} ${why}, so no job is made for it.`);
  }
  for (const p of ready) for (const it of tooFullItems(p)) leftOut.push(tooFullSentence(p, it, 'get no job'));
  for (const c of coverage(plan)) {
    if (c.short <= 0) continue;
    leftOut.push(c.blocked
      ? `${partPhrase(c.need)}: ${c.short} cannot be prepared here (${c.need.blockedReason ?? 'nothing to print from'}).`
      : `${partPhrase(c.need)}: ${c.short} of ${c.need.toProduce} are on no plate.`);
  }
  return { ready, leftOut };
}

// ---------- the plate drawing ----------

export interface PlateFill {
  /** SVG classes of an outline. */
  shape: string;
  /** The legend dot. */
  swatch: string;
}

/**
 * Ten fills from colours the app already uses (brand blue, green, amber,
 * purple, grey), each in a light and a strong step; outlines switch to the
 * light shade in dark mode.
 */
export const PLATE_FILLS: ReadonlyArray<PlateFill> = [
  { shape: 'fill-brand-500/40 stroke-brand-700 dark:stroke-brand-300', swatch: 'bg-brand-500/40 border-brand-700 dark:border-brand-300' },
  { shape: 'fill-green-500/40 stroke-green-700 dark:stroke-green-300', swatch: 'bg-green-500/40 border-green-700 dark:border-green-300' },
  { shape: 'fill-amber-500/40 stroke-amber-700 dark:stroke-amber-300', swatch: 'bg-amber-500/40 border-amber-700 dark:border-amber-300' },
  { shape: 'fill-purple-500/40 stroke-purple-700 dark:stroke-purple-300', swatch: 'bg-purple-500/40 border-purple-700 dark:border-purple-300' },
  { shape: 'fill-gray-500/40 stroke-gray-700 dark:stroke-gray-300', swatch: 'bg-gray-500/40 border-gray-700 dark:border-gray-300' },
  { shape: 'fill-brand-600/80 stroke-brand-800 dark:stroke-brand-200', swatch: 'bg-brand-600/80 border-brand-800 dark:border-brand-200' },
  { shape: 'fill-green-600/80 stroke-green-800 dark:stroke-green-200', swatch: 'bg-green-600/80 border-green-800 dark:border-green-200' },
  { shape: 'fill-amber-600/80 stroke-amber-800 dark:stroke-amber-200', swatch: 'bg-amber-600/80 border-amber-800 dark:border-amber-200' },
  { shape: 'fill-purple-600/80 stroke-purple-800 dark:stroke-purple-200', swatch: 'bg-purple-600/80 border-purple-800 dark:border-purple-200' },
  { shape: 'fill-gray-600/80 stroke-gray-800 dark:stroke-gray-200', swatch: 'bg-gray-600/80 border-gray-800 dark:border-gray-200' },
];

/** An outline whose label matched no part. */
export const OTHER_FILL: PlateFill = {
  shape: 'fill-gray-300/50 stroke-gray-500 dark:fill-gray-600/50 dark:stroke-gray-400',
  swatch: 'bg-gray-300/50 border-gray-500 dark:bg-gray-600/50 dark:border-gray-400',
};

/**
 * A fill for each row on one plate. A row keeps the colour of its place in
 * the order's list wherever that colour is free on the plate, so a part looks
 * the same on every plate; rows on one plate never share a colour until all
 * ten are used.
 */
export function assignFills(rowKeys: ReadonlyArray<string>, orderRows: ReadonlyArray<string>): Map<string, number> {
  const n = PLATE_FILLS.length;
  const out = new Map<string, number>();
  const taken = new Set<number>();
  rowKeys.forEach((key, i) => {
    if (out.has(key)) return;
    const at = orderRows.indexOf(key);
    let slot = (at >= 0 ? at : i) % n;
    if (taken.has(slot) && taken.size < n) {
      while (taken.has(slot)) slot = (slot + 1) % n;
    }
    taken.add(slot);
    out.set(key, slot);
  });
  return out;
}

export interface LegendEntry {
  rowKey: string;
  title: string;
  sub: string;
  /** "×12", "×12 of 15" when the plate was too full. */
  units: string;
  fill: PlateFill;
}

export function plateLegend(p: Pick<OrderPlateDto, 'items' | 'status'>, orderRows: ReadonlyArray<string>): LegendEntry[] {
  const fills = assignFills(p.items.map(it => it.rowKey), orderRows);
  return p.items.map(it => {
    const sliced = p.status === OrderPlateStatus.DONE && it.unitsSliced !== null && it.unitsSliced !== it.units;
    return {
      rowKey: it.rowKey,
      title: partTitle(it),
      sub: partSub(it),
      units: sliced ? `×${it.unitsSliced} of ${it.units}` : `×${it.units}`,
      fill: PLATE_FILLS[fills.get(it.rowKey) ?? 0],
    };
  });
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** SVG points of an outline, y flipped so the front of the bed is at the bottom; '' when it is not drawable. */
export function outlinePoints(polygon: ReadonlyArray<readonly [number, number]>, bedY: number): string {
  const pts = polygon.filter(pt => Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1]));
  if (pts.length < 3) return '';
  return pts.map(([x, y]) => `${r2(x)},${r2(bedY - y)}`).join(' ');
}

/** Grid line positions inside the bed, every `step` mm. */
export function gridLines(size: number, step = 50): number[] {
  const out: number[] = [];
  if (!(size > 0) || !(step > 0) || size / step > 40) return out;
  for (let v = step; v < size - 0.5; v += step) out.push(v);
  return out;
}

/** The bed is usable for a drawing. */
export function drawableBed(bed: { x: number; y: number } | null | undefined): bed is { x: number; y: number } {
  return !!bed && Number.isFinite(bed.x) && Number.isFinite(bed.y) && bed.x > 0 && bed.y > 0;
}
