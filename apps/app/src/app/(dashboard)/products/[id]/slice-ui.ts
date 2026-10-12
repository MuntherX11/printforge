/**
 * Pure helpers of the in-app slicing UI (v2.18.0): error codes → sentences,
 * run status chips, the slots a part slices with, the retry body of a failed
 * run. No React, no fetch, so it can move to packages/types and be tested there.
 */
import {
  MAX_UNITS_PER_PLATE,
  SLOT_KEYS,
  SliceErrorCode,
  SliceRunStatus,
  SourceModelKind,
  type ComponentSourceModel,
  type SliceRequestDto,
  type SliceRunDto,
  type SliceRunEvent,
  type SlotKey,
} from '@printforge/types';

/** The sentence the staff reads for each code the slice endpoints return in `message`. */
export const SLICE_ERROR_TEXT: Record<SliceErrorCode, string> = {
  NO_SOURCE: 'This part has no source model yet. Upload an STL or a 3MF project first.',
  NO_MACHINE_PROFILE: 'This printer has no slicer profile yet. Ask the owner to import one in Settings → Slicer.',
  NO_PROCESS_PROFILE: 'This printer has no default process profile yet. Ask the owner to set one in Settings → Slicer.',
  NO_FILAMENT_PROFILE: 'This filament has no slicer profile yet. Ask the owner to map one in Settings → Slicer.',
  SLOT_UNMAPPED: 'Every slot the project uses needs a filament.',
  IDENTICAL_PENDING: 'The same plate is already queued or slicing. Wait for it to finish.',
  OLD_PROJECT_FORMAT: 'This project was saved by an older slicer. Open it in OrcaSlicer 2.3 or newer, save it again and upload that file.',
  SLICER_UNAVAILABLE: 'The slicer is not reachable right now. Try again in a minute.',
  TIMED_OUT: 'Slicing took longer than 5 minutes and was stopped. Try fewer units.',
  NO_OBJECTS: 'The slicer produced no labelled objects, so the units on the plate could not be counted.',
};

function isSliceErrorCode(v: unknown): v is SliceErrorCode {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(SLICE_ERROR_TEXT, v);
}

/**
 * A code becomes its sentence; any other server text is shown verbatim (the
 * API writes plain messages for re-validation failures and the old-format
 * 3MF check); nothing readable falls back to `fallback`.
 */
export function sliceErrorText(err: unknown, fallback = 'Slicing failed'): string {
  const code = err !== null && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined;
  if (isSliceErrorCode(code)) return SLICE_ERROR_TEXT[code];
  const message = typeof err === 'string' ? err : err instanceof Error ? err.message : '';
  if (isSliceErrorCode(message)) return SLICE_ERROR_TEXT[message];
  // The API writes "CODE: the specific sentence" (it names the printer or the slot); show the
  // sentence without the code, or the code's general sentence when nothing follows it.
  const coded = /^([A-Z][A-Z_]+):\s*([\s\S]*)$/.exec(message.trim());
  if (coded) return coded[2].trim() || (isSliceErrorCode(coded[1]) ? SLICE_ERROR_TEXT[coded[1]] : fallback);
  return message.trim() || fallback;
}

/** The sentence under a failed run: the code mapped, or the reason the API wrote. */
export function runErrorText(run: Pick<SliceRunDto, 'error'>): string {
  return sliceErrorText(run.error ?? '', 'Slicing failed');
}

export const RUN_POLL_MS = 3000;

export function isActiveRun(run: Pick<SliceRunDto, 'status'>): boolean {
  return run.status === SliceRunStatus.QUEUED || run.status === SliceRunStatus.RUNNING;
}

export function anyActiveRun(runs: ReadonlyArray<Pick<SliceRunDto, 'status'>> | null): boolean {
  return runs !== null && runs.some(isActiveRun);
}

export interface RunStatusChip {
  text: string;
  variant: 'default' | 'info' | 'success' | 'error';
}

export function runStatusChip(status: SliceRunStatus): RunStatusChip {
  switch (status) {
    case SliceRunStatus.QUEUED: return { text: 'Queued', variant: 'default' };
    case SliceRunStatus.RUNNING: return { text: 'Slicing…', variant: 'info' };
    case SliceRunStatus.DONE: return { text: 'Done', variant: 'success' };
    default: return { text: 'Failed', variant: 'error' };
  }
}

/** "12 → 12", "12 → …" while it runs, "12 → —" when it failed. */
export function runUnitsText(run: Pick<SliceRunDto, 'unitsRequested' | 'unitsSliced' | 'status'>): string {
  const sliced = run.unitsSliced !== null ? String(run.unitsSliced) : isActiveRun(run) ? '…' : '—';
  return `${run.unitsRequested} → ${sliced}`;
}

/** Apply a `slice-run` websocket event to the list; an unknown id means the list must be refetched. */
export function applyRunEvent(runs: SliceRunDto[], ev: SliceRunLiveEvent): { runs: SliceRunDto[]; known: boolean } {
  let known = false;
  const next = runs.map(r => {
    if (r.id !== ev.id) return r;
    known = true;
    return { ...r, status: ev.status, error: ev.error, resultLayoutId: ev.resultLayoutId, unitsSliced: ev.unitsSliced ?? r.unitsSliced };
  });
  return { runs: next, known };
}

export function isFinishedStatus(status: SliceRunStatus): boolean {
  return status === SliceRunStatus.DONE || status === SliceRunStatus.FAILED;
}

/**
 * True when an event ends a run this list had not yet seen ended: the list is
 * then refetched once, so the row carries everything the run finished with.
 */
export function runJustFinished(prev: SliceRunStatus | undefined, next: SliceRunStatus): boolean {
  return isFinishedStatus(next) && prev !== next;
}

/** The request a failed run was made with, to queue it again as it was. */
export function retryRequestOf(run: SliceRunDto): SliceRequestDto {
  const materials: Partial<Record<SlotKey, string>> = {};
  for (const k of SLOT_KEYS) {
    const f = run.filamentMap[k];
    if (f) materials[k] = f.materialId;
  }
  return { printerId: run.printerId ?? undefined, materials, units: run.unitsRequested };
}

/**
 * The part's source model. ComponentDetail gains `source: ComponentSourceModel | null`
 * with the API (WP4); until the shared type carries it, it is read loosely.
 */
export function sourceOf(c: object): ComponentSourceModel | null {
  const s = (c as { source?: ComponentSourceModel | null }).source;
  return s && typeof s === 'object' && typeof s.attachmentId === 'string' ? s : null;
}

export function sourceKindText(kind: ComponentSourceModel['kind']): string {
  return kind === SourceModelKind.THREEMF ? '3MF project' : 'STL';
}

/** "fish.stl · STL" or "dress.3mf · 3MF project · 2 slots · Creality Hi". */
export function sourceSummary(s: ComponentSourceModel, printerName: string | null): string {
  const parts = [s.filename, sourceKindText(s.kind)];
  if (s.kind === SourceModelKind.THREEMF) {
    parts.push(`${s.slots.length} ${s.slots.length === 1 ? 'slot' : 'slots'}`);
    parts.push(printerName ?? (s.printerModel ? `${s.printerModel} (no matching printer)` : 'printer not named'));
  }
  return parts.join(' · ');
}

/** True when the project names a printer that is locked for the run. */
export function printerLockedBy(s: ComponentSourceModel | null): string | null {
  return s && s.kind === SourceModelKind.THREEMF && s.printerId ? s.printerId : null;
}

/** One slot a run needs a filament for, with the default the dialog starts from. */
export interface SliceSlotSpec {
  key: SlotKey;
  /** What the project names for the slot; null for an STL. */
  fileLabel: string | null;
  fileHex: string | null;
  /** The filament it starts with: the project's match, else the part's BOM filament for the slot. */
  defaultMaterialId: string | null;
}

interface BomLike {
  materialId: string | null;
  materials: Array<{ colorIndex: number; materialId: string }>;
}

function asSlotKey(index: number): SlotKey | null {
  const k = String(index);
  return (SLOT_KEYS as readonly string[]).includes(k) ? (k as SlotKey) : null;
}

/** STL: slot 0 with the part's filament. 3MF: every slot the project uses, in order. */
export function sliceSlotsOf(source: ComponentSourceModel, bom: BomLike): SliceSlotSpec[] {
  const bomFor = (index: number) => bom.materials.find(m => m.colorIndex === index)?.materialId ?? bom.materialId ?? null;
  if (source.kind !== SourceModelKind.THREEMF || source.slots.length === 0) {
    return [{ key: '0', fileLabel: null, fileHex: null, defaultMaterialId: bom.materials[0]?.materialId ?? bom.materialId ?? null }];
  }
  const out: SliceSlotSpec[] = [];
  for (const s of source.slots) {
    const key = asSlotKey(s.colorIndex);
    if (!key) continue;
    out.push({ key, fileLabel: s.profile, fileHex: s.colorHex, defaultMaterialId: s.materialId ?? bomFor(s.colorIndex) });
  }
  return out;
}

/** The `units` field: a whole number from 1 to 500; null when it is not. */
export function parseSliceUnits(v: string): number | null {
  const t = v.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= MAX_UNITS_PER_PLATE ? n : null;
}

/** The body of "Slice a plate", or the reason it cannot be sent yet. */
export function buildSliceRequest(input: {
  printerId: string | null;
  printerLocked: boolean;
  slots: SliceSlotSpec[];
  chosen: Partial<Record<SlotKey, string>>;
  units: string;
  fill: boolean;
}): { body: SliceRequestDto; problem: null } | { body: null; problem: string } {
  if (!input.printerLocked && !input.printerId) return { body: null, problem: 'Choose a printer' };
  const materials: Partial<Record<SlotKey, string>> = {};
  for (const s of input.slots) {
    const id = input.chosen[s.key];
    if (!id) return { body: null, problem: `Choose a filament for slot ${Number(s.key) + 1}` };
    materials[s.key] = id;
  }
  const body: SliceRequestDto = { materials };
  if (!input.printerLocked && input.printerId) body.printerId = input.printerId;
  if (input.fill) body.fill = true;
  else {
    const units = parseSliceUnits(input.units);
    if (units === null) return { body: null, problem: `Whole number from 1 to ${MAX_UNITS_PER_PLATE}` };
    body.units = units;
  }
  return { body, problem: null };
}

/** A plate row the slicer made (ComponentPlateRow.source gains 'SLICED' with the API). */
export function isSlicedRow(r: { source: string }): boolean {
  return r.source === 'SLICED';
}

/** The printer id of a plate row: the row's own when the API sends it, else its layout's. */
export function rowPrinterId(r: { layoutId: string | null; printerId?: string | null }, layouts: ReadonlyArray<{ id: string; printerId?: string | null }>): string | null {
  if (r.printerId) return r.printerId;
  if (!r.layoutId) return null;
  return layouts.find(l => l.id === r.layoutId)?.printerId ?? null;
}

// ---------- Add from model ----------

// Shared with the API (packages/types/src/slicer.ts); re-exported so the dialogs keep one import.
export type { ModelInspectResult, ComponentFromModelDto, ComponentFromModelResult } from '@printforge/types';
import type { ModelInspectResult, ComponentFromModelDto, ComponentFromModelResult } from '@printforge/types';

/** The `slice-run` websocket event (carries `unitsSliced` once a run is done). */
export type SliceRunLiveEvent = SliceRunEvent;

export const PART_NAME_MAX = 120;

/** Why the name cannot be saved; null when it can. */
export function partNameProblem(name: string): string | null {
  const t = name.trim();
  if (!t) return 'Enter a name';
  return t.length > PART_NAME_MAX ? `At most ${PART_NAME_MAX} characters` : null;
}

export function isProjectModel(m: Pick<ModelInspectResult, 'kind'>): boolean {
  return m.kind === SourceModelKind.THREEMF;
}

/** A 3MF project whose printer matches none of the farm's: it cannot be added. */
export function projectPrinterUnmatched(m: Pick<ModelInspectResult, 'kind' | 'printerId'>): boolean {
  return isProjectModel(m) && !m.printerId;
}

export function projectPrinterWarning(printerModel: string | null): string {
  return printerModel
    ? `This project is for ${printerModel}, which matches none of your printers`
    : 'This project names no printer, so it matches none of your printers';
}

/** STL: slot 0 with no default. 3MF: every slot the project uses, with the filament it matched. */
export function inspectSlotsOf(m: Pick<ModelInspectResult, 'kind' | 'slots'>): SliceSlotSpec[] {
  if (!isProjectModel(m)) {
    return [{ key: '0', fileLabel: null, fileHex: null, defaultMaterialId: m.slots[0]?.materialId ?? null }];
  }
  const out: SliceSlotSpec[] = [];
  for (const s of m.slots) {
    const key = asSlotKey(s.colorIndex);
    if (!key || out.some(o => o.key === key)) continue;
    out.push({ key, fileLabel: s.profile, fileHex: s.colorHex, defaultMaterialId: s.materialId });
  }
  return out.length ? out : [{ key: '0', fileLabel: null, fileHex: null, defaultMaterialId: null }];
}

/** The printer an STL starts with: the product's default when it is active, else the first active one. */
export function defaultModelPrinterId(defaultPrinterId: string | null, active: ReadonlyArray<{ id: string }>): string {
  if (defaultPrinterId && active.some(p => p.id === defaultPrinterId)) return defaultPrinterId;
  return active[0]?.id ?? '';
}

/** The body of "Add part", or the reason it cannot be sent yet. */
export function buildFromModelRequest(input: {
  assembledUploadId: string;
  model: Pick<ModelInspectResult, 'kind' | 'printerId'>;
  name: string;
  printerId: string | null;
  slots: SliceSlotSpec[];
  chosen: Partial<Record<SlotKey, string>>;
  variantId: string | null;
}): { body: ComponentFromModelDto; problem: null } | { body: null; problem: string } {
  const nameProblem = partNameProblem(input.name);
  if (nameProblem) return { body: null, problem: nameProblem };
  const project = isProjectModel(input.model);
  if (projectPrinterUnmatched(input.model)) return { body: null, problem: 'The project\'s printer matches none of yours' };
  if (!project && !input.printerId) return { body: null, problem: 'Choose a printer' };
  const materials: Partial<Record<SlotKey, string>> = {};
  for (const s of input.slots) {
    const id = input.chosen[s.key];
    if (!id) return { body: null, problem: input.slots.length > 1 ? `Choose a filament for slot ${Number(s.key) + 1}` : 'Choose a filament' };
    materials[s.key] = id;
  }
  const body: ComponentFromModelDto = { assembledUploadId: input.assembledUploadId, description: input.name.trim(), materials };
  if (!project && input.printerId) body.printerId = input.printerId;
  if (input.variantId) body.variantId = input.variantId;
  return { body, problem: null };
}
