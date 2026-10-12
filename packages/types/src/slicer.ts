// In-app slicing (v2.18.0): Orca presets the owner exported, the source model on a part,
// and the status of a slice run. Pure types only; helpers live in fill-plate.ts.
//
//  Settings > Slicer ──import bundle──▶ SlicerProfile (raw preset JSON, mapped to a printer / filament)
//  part ──upload STL | 3MF──▶ sourceAttachment ──Slice a plate──▶ SliceRun ──▶ PlateLayout(SLICED)

import type { MaterialType } from './index';

export const SourceModelKind = { STL: 'STL', THREEMF: 'THREEMF' } as const;
export type SourceModelKind = (typeof SourceModelKind)[keyof typeof SourceModelKind];

export const SlicerProfileKind = { MACHINE: 'MACHINE', PROCESS: 'PROCESS', FILAMENT: 'FILAMENT' } as const;
export type SlicerProfileKind = (typeof SlicerProfileKind)[keyof typeof SlicerProfileKind];

export const SliceRunStatus = { QUEUED: 'QUEUED', RUNNING: 'RUNNING', DONE: 'DONE', FAILED: 'FAILED' } as const;
export type SliceRunStatus = (typeof SliceRunStatus)[keyof typeof SliceRunStatus];

/** Slot index as a string key: "0".."3" (the Creality Hi has four). */
export type SlotKey = '0' | '1' | '2' | '3';
export const SLOT_KEYS: readonly SlotKey[] = ['0', '1', '2', '3'];

/** Upper bound of units a plate can hold; matches PlateLayout.unitsPerPlate (1..500). */
export const MAX_UNITS_PER_PLATE = 500;

/** One Orca preset as exported, with its mapping. `json` is never flattened in PrintForge. */
export interface SlicerProfileDto {
  id: string;
  kind: SlicerProfileKind;
  name: string;
  /** The preset's `inherits` value, for display ("based on Creality Hi 0.4 nozzle"). */
  inherits: string | null;
  printerId: string | null;
  materialId: string | null;
  /** FILAMENT: the main preset for every filament of this type that has no preset of its own. */
  materialType: MaterialType | null;
  isDefault: boolean;
  /** True when the row is a reference to a preset that ships with OrcaSlicer (json is only name / inherits / from). */
  stock: boolean;
  updatedAt: string;
}

/** Result of importing an .orca_printer / .orca_filament bundle. */
export interface SlicerBundleImportResult {
  imported: Array<{ id: string; kind: SlicerProfileKind; name: string; replaced: boolean }>;
  skipped: Array<{ name: string; reason: string }>;
  /** Null when the slicer container was not reachable (check deferred to the first slice). */
  check: { ok: boolean; unresolved: string[] } | null;
}

export interface SlicerProfilePatchDto {
  printerId?: string | null;
  materialId?: string | null;
  /** FILAMENT only; null clears. Setting it takes the type away from any other filament preset. */
  materialType?: MaterialType | null;
  isDefault?: boolean;
}

/** A preset that ships with OrcaSlicer, offered by GET /slicer-profiles/stock. */
export interface SlicerStockPresetDto {
  name: string;
  vendor: string;
}

/** GET /slicer-profiles/stock?kind=&q= response. `reachable` is false when the slicer container is down. */
export interface SlicerStockPresetList {
  presets: SlicerStockPresetDto[];
  reachable: boolean;
}

/** POST /slicer-profiles/stock body: store a reference to the stock preset `name`. */
export interface CreateStockProfileDto {
  kind: SlicerProfileKind;
  name: string;
}

/** Suffix of the stored name of a stock reference: a preset may not carry its parent's name. */
export const STOCK_PROFILE_SUFFIX = ' (stock)';

/** GET /slicer-profiles/health */
export interface SlicerHealth {
  reachable: boolean;
  orcaVersion: string | null;
}

/** The source model stored on a part. */
export interface ComponentSourceModel {
  attachmentId: string;
  kind: SourceModelKind;
  filename: string;
  sizeBytes: number;
  /** 3MF projects: the slots the project uses, in order, with the filament the file names. */
  slots: Array<{ colorIndex: number; profile: string | null; colorHex: string | null; materialId: string | null }>;
  /** 3MF projects: the printer the project names, matched to a Printer row; null = not matched. */
  printerId: string | null;
  printerModel: string | null;
}

/** POST /products/:id/components/:cid/source response. */
export interface SourceModelUploadResult {
  source: ComponentSourceModel;
  /** The validation run that was queued, or null with a notice when it could not be. */
  validationRun: SliceRunDto | null;
  notice: string | null;
}

/** POST /products/:id/model-inspect response: what a staged STL or project is, before any part exists. */
export interface ModelInspectResult {
  kind: SourceModelKind;
  filename: string;
  sizeBytes: number;
  /** The file name without its extension, at most 120 characters. */
  suggestedName: string;
  /** 3MF projects: the project's slots with the shop filament each one matched (null = no match). STL: []. */
  slots: Array<{ colorIndex: number; profile: string | null; colorHex: string | null; materialId: string | null }>;
  /** 3MF projects: the printer the project names, matched to a Printer row; null = not matched (or an STL). */
  printerId: string | null;
  printerModel: string | null;
  /** The product's pricing printer, the default choice for an STL. */
  defaultPrinterId: string | null;
}

/** POST /products/:id/components/from-model body. */
export interface ComponentFromModelDto {
  assembledUploadId: string;
  /** 1..120 characters. */
  description: string;
  /** STL only; required when the product has no pricing printer. Ignored for a project. */
  printerId?: string;
  /** Filament per slot: "0" alone for an STL, one per project slot for a 3MF. */
  materials: Partial<Record<SlotKey, string>>;
  /** The SIZE option that owns the part; null or omitted = the standard size. */
  variantId?: string | null;
}

/** POST /products/:id/components/from-model response. */
export interface ComponentFromModelResult {
  componentId: string;
  source: ComponentSourceModel;
  /** The 1-unit validation run that was queued, or null with a notice when it could not be. */
  validationRun: SliceRunDto | null;
  notice: string | null;
}

/** A filament chosen for a slot, snapshotted so a merged Material stays readable. */
export interface SliceFilamentChoice {
  materialId: string;
  name: string;
  type: MaterialType | string;
}
export type SliceFilamentMap = Partial<Record<SlotKey, SliceFilamentChoice>>;

/** POST /products/:id/components/:cid/slice body. */
export interface SliceRequestDto {
  /** Ignored for 3MF projects (locked to the printer the project names). */
  printerId?: string;
  /** Material per slot; STL parts use "0" only. */
  materials: Partial<Record<SlotKey, string>>;
  /** 1..500. Omit with fill = true. */
  units?: number;
  /** Fill the plate: the server estimates the count from the bounding box and the bed. */
  fill?: boolean;
}

export interface SliceRunDto {
  id: string;
  componentId: string;
  printerId: string | null;
  printerName: string | null;
  unitsRequested: number;
  unitsSliced: number | null;
  filamentMap: SliceFilamentMap;
  status: SliceRunStatus;
  error: string | null;
  resultLayoutId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Websocket event `slice-run`. */
export interface SliceRunEvent {
  id: string;
  componentId: string;
  productId: string;
  status: SliceRunStatus;
  resultLayoutId: string | null;
  error: string | null;
  /** Set on DONE: the units the slicer placed (a 1-unit run reports its labelled bodies). */
  unitsSliced?: number | null;
}

/** Error codes the slice endpoints return in `message` (exact strings the UI maps). */
export const SliceErrorCode = {
  NO_SOURCE: 'NO_SOURCE',
  NO_MACHINE_PROFILE: 'NO_MACHINE_PROFILE',
  NO_PROCESS_PROFILE: 'NO_PROCESS_PROFILE',
  NO_FILAMENT_PROFILE: 'NO_FILAMENT_PROFILE',
  SLOT_UNMAPPED: 'SLOT_UNMAPPED',
  IDENTICAL_PENDING: 'IDENTICAL_PENDING',
  OLD_PROJECT_FORMAT: 'OLD_PROJECT_FORMAT',
  SLICER_UNAVAILABLE: 'SLICER_UNAVAILABLE',
  TIMED_OUT: 'TIMED_OUT',
  NO_OBJECTS: 'NO_OBJECTS',
} as const;
export type SliceErrorCode = (typeof SliceErrorCode)[keyof typeof SliceErrorCode];
