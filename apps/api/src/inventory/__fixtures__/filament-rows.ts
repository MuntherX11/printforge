/**
 * Rows of GET /materials/stock for the filterFilaments specs
 * (filament-filter.spec.ts and filament-filter-places.spec.ts).
 */
import {
  DEFAULT_FILAMENT_LIST_STATE,
  MaterialType,
  filterFilaments,
  type FilamentListState,
  type FilamentStockRow,
  type FilamentStockSpool,
} from '@printforge/types';

let spoolSeq = 0;

/** An active 640 g spool with no location, unless `extra` says otherwise. */
export function spool(printforgeId: string | null, extra: Partial<FilamentStockSpool> = {}): FilamentStockSpool {
  spoolSeq += 1;
  return {
    id: `s-${spoolSeq}`,
    printforgeId,
    currentWeight: 640,
    isActive: true,
    locationName: null,
    ...extra,
  };
}

/** A brandless PLA filament with 1000 g in stock and no spools, unless `extra` says otherwise. */
export function row(id: string, extra: Partial<FilamentStockRow> = {}): FilamentStockRow {
  return {
    id,
    name: `Filament ${id}`,
    type: MaterialType.PLA,
    color: null,
    colorHex: null,
    brand: null,
    costPerGram: 0.02,
    spoolPrice: 20,
    spoolWeightGrams: 1000,
    reorderPoint: 500,
    createdAt: '2026-01-01T00:00:00.000Z',
    totalStock: 1000,
    activeSpools: 1,
    stockStatus: 'ok',
    spools: [],
    ...extra,
  };
}

export const state = (patch: Partial<FilamentListState> = {}): FilamentListState => ({ ...DEFAULT_FILAMENT_LIST_STATE, ...patch });

/** Ids of every matched row, in order, across all pages. */
export function ids(rows: FilamentStockRow[], patch: Partial<FilamentListState> = {}): string[] {
  const all: string[] = [];
  const first = filterFilaments(rows, state(patch));
  for (let p = 1; p <= first.totalPages; p++) {
    all.push(...filterFilaments(rows, state({ ...patch, page: p })).pageRows.map((r) => r.id));
  }
  return all;
}

export const esunRed = row('esun-red', { name: 'eSun PLA Red', color: 'Red', brand: 'eSun', colorHex: '91202B' });
export const esunFire = row('esun-fire', { name: 'eSun PLA Fire Engine Red', color: 'Fire Engine Red', brand: 'eSun', colorHex: 'C8102E' });
export const esunPetgRed = row('esun-petg-red', { name: 'eSUN PETG Red', type: MaterialType.PETG, color: 'Red', brand: 'eSUN' });
export const polyBlack = row('poly-black', {
  name: 'Polymaker PLA Black',
  color: 'Black',
  brand: 'Polymaker',
  spools: [
    spool('PF-A7X2', { locationName: 'Shelf B', currentWeight: 640 }),
    spool('PF-OLD9', { isActive: false, locationName: 'Attic' }),
  ],
});
export const bambuWhite = row('bambu-white', {
  name: 'Bambu Lab PLA White',
  color: 'White',
  brand: 'Bambu Lab',
  spools: [spool('PF-RED4', { locationName: 'Rack 1' })],
});
export const noBrandGrey = row('nobrand-grey', { name: 'Generic Grey', color: 'Grey', brand: null });
export const catalog = [esunRed, esunFire, esunPetgRed, polyBlack, bambuWhite, noBrandGrey];
