/**
 * Plates and their print files on the product page, jobs and plans (owner spec
 * 2026-10-02: see plates clearly, price for both, every G-code stored, the
 * printer from the G-code). Shapes only.
 */
import type { FileRef, Problem } from './index';

export interface PrinterRef {
  id: string;
  name: string;
}

/** One row of a component's plate list (staff only: costs and files never reach customers). */
export interface ComponentPlateRow {
  /** null = the component's own single unit (×1, its own file) */
  layoutId: string | null;
  /** "×1" for the part's own unit, else the layout's name (default "×12") */
  name: string;
  unitsPerPlate: number;
  plateMinutes: number;
  plateGrams: number;
  /** 'COMPONENT' for the ×1 row; else the layout's source */
  source: 'COMPONENT' | 'GCODE' | 'MANUAL' | 'CALIBRATION';
  /** Cost of one product unit with this part printed on this plate; null when the bill of materials can't be costed. */
  costPerUnit: number | null;
  /** ×1: the size's list price; ×N: the bulk tier whose min qty ≤ N, else the list price. null = no price set. */
  pricePerUnit: number | null;
  priceSource: 'LIST' | 'TIER' | null;
  tierMinQty: number | null;
  /** (price − cost) / price, %, 1 dp */
  marginPct: number | null;
  file: FileRef | null;
  /** The printer the file was sliced for (its header); null = no file, or the file doesn't say. */
  slicedFor: string | null;
  /** The farm printer matched to `slicedFor`; null when nothing matches. */
  printer: PrinterRef | null;
}

/** POST …/plate-layouts/:layoutId/file and POST …/components/:componentId/file. */
export interface PlateFileResult {
  file: FileRef;
  slicedFor: string | null;
  printer: PrinterRef | null;
  warnings: Problem[];
}

/** J2 `printer`: the printer the suggested plates' files were sliced for. */
export interface PlatePrinterSuggestion {
  /** matched farm printer, else the product's pricing printer, else null */
  printerId: string | null;
  printerName: string | null;
  /** the first sliced-for model among the plates' files */
  slicedFor: string | null;
  /** true when `printerId` came from the files */
  fromFile: boolean;
}
