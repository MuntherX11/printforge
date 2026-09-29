/**
 * Filaments list logic: search, Type/Brand filters, sort, stock-chip counts,
 * paging and URL state, over the rows of GET /materials/stock. Also the Scan
 * Label review's matching (findScanMatches) and brand spelling.
 *
 * Pure and DOM-free: the app runs it in the browser on every keystroke and the
 * api jest suite tests it (through the '@printforge/types' moduleNameMapper).
 * Only types come from ./index, so there is no runtime import cycle.
 */
import type { FilamentStockRow, FilamentStockSpool, MaterialType } from './index';

/** A MaterialType enum value as a plain string ('PLA' … 'OTHER'). */
export type MaterialTypeValue = `${MaterialType}`;

/** The eight material types in enum order, with the labels the app shows. */
export const MATERIAL_TYPE_OPTIONS: ReadonlyArray<{ value: MaterialTypeValue; label: string }> = [
  { value: 'PLA', label: 'PLA' },
  { value: 'PETG', label: 'PETG' },
  { value: 'ABS', label: 'ABS' },
  { value: 'TPU', label: 'TPU' },
  { value: 'ASA', label: 'ASA' },
  { value: 'NYLON', label: 'Nylon' },
  { value: 'RESIN', label: 'Resin' },
  { value: 'OTHER', label: 'Other' },
];

/** Rows per page on the Filaments list. */
export const FILAMENTS_PER_PAGE = 25;

/** Brand filter value for filaments that have no brand. */
export const NO_BRAND = '__none__';

/** Longest search text kept, in characters. */
export const FILAMENT_QUERY_MAX = 100;

/** '' is the default, Colour A–Z. */
export type FilamentSort = '' | 'brand' | 'type' | 'stock-asc' | 'stock-desc' | 'newest';

/** '' shows every filament; 'low' includes 'out'. */
export type FilamentStockFilter = '' | 'low' | 'out';

const SORTS: ReadonlyArray<Exclude<FilamentSort, ''>> = ['brand', 'type', 'stock-asc', 'stock-desc', 'newest'];

/** Everything the Filaments list keeps in its URL. */
export interface FilamentListState {
  /** Search text as typed; filtering and the URL trim it and cap it at 100 characters. */
  q: string;
  type: MaterialTypeValue | '';
  /** Brand text (matched case-insensitively after trim), NO_BRAND, or '' for every brand. */
  brand: string;
  stock: FilamentStockFilter;
  sort: FilamentSort;
  /** 1-based page number. */
  page: number;
}

export const DEFAULT_FILAMENT_LIST_STATE: Readonly<FilamentListState> = Object.freeze({
  q: '',
  type: '',
  brand: '',
  stock: '',
  sort: '',
  page: 1,
});

/** Anything with URLSearchParams' `get`, e.g. Next's useSearchParams(). */
export interface SearchParamsLike {
  get(key: string): string | null;
}

export interface FilamentStockCounts {
  /** Filaments passing search, Type and Brand. */
  all: number;
  /** Of those, below their reorder point (stockStatus 'low' or 'out'), the dashboard rule. */
  low: number;
  /** Of those, with stockStatus 'out'. */
  out: number;
}

/** The single spool a whole-query PF-ID names, with its filament. */
export interface FilamentPfidHit {
  row: FilamentStockRow;
  spool: FilamentStockSpool;
}

export interface FilamentFilterResult {
  /** The current page of the filtered, sorted rows. */
  pageRows: FilamentStockRow[];
  /** Rows passing every filter, including the stock chip. */
  matchedCount: number;
  /** Every filament. */
  totalCount: number;
  /** The page shown, clamped to 1…totalPages. */
  page: number;
  totalPages: number;
  counts: FilamentStockCounts;
  /** materialId → spools matched through the PF-ID rule, for matched rows only. */
  spoolHits: Record<string, FilamentStockSpool[]>;
  pfidHit: FilamentPfidHit | null;
  /** Distinct brands over ALL rows, A–Z; value and label are the first spelling found. */
  brandOptions: Array<{ value: string; label: string }>;
  /** Material types present in ALL rows, in enum order. */
  typesPresent: MaterialTypeValue[];
  /** True when any filament has no brand. */
  hasNoBrand: boolean;
  /** The brand filter in effect: a brandOptions value, NO_BRAND, or '' when absent or ignored. */
  brand: string;
}

/** Trim, collapse inner whitespace, lowercase. null, undefined and '' become ''. */
export function normText(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function cleanQuery(q: string): string {
  return q.trim().slice(0, FILAMENT_QUERY_MAX).trim();
}

function cleanBrand(brand: string): string {
  return brand.trim().slice(0, FILAMENT_QUERY_MAX).trim();
}

function isMaterialType(value: string): value is MaterialTypeValue {
  return MATERIAL_TYPE_OPTIONS.some((o) => o.value === value);
}

function isSort(value: string): value is Exclude<FilamentSort, ''> {
  return SORTS.some((s) => s === value);
}

function isStockFilter(value: string): value is Exclude<FilamentStockFilter, ''> {
  return value === 'low' || value === 'out';
}

/** Reads the list state from the URL. Unknown or invalid values fall back to the defaults. */
export function parseFilamentListState(params: SearchParamsLike): FilamentListState {
  const type = params.get('type') ?? '';
  const stock = params.get('stock') ?? '';
  const sort = params.get('sort') ?? '';
  const rawPage = (params.get('page') ?? '').trim();
  const page = /^\d{1,6}$/.test(rawPage) ? Number(rawPage) : 1;
  return {
    q: cleanQuery(params.get('q') ?? ''),
    type: isMaterialType(type) ? type : '',
    brand: cleanBrand(params.get('brand') ?? ''),
    stock: isStockFilter(stock) ? stock : '',
    sort: isSort(sort) ? sort : '',
    page: page >= 1 ? page : 1,
  };
}

/**
 * The query string for a state, without '?': keys in the order q, type, brand,
 * stock, sort, page, and defaults left out (the default state gives '').
 */
export function serializeFilamentListState(state: FilamentListState): string {
  const parts: string[] = [];
  const add = (key: string, value: string) => parts.push(`${key}=${encodeURIComponent(value)}`);
  const q = cleanQuery(state.q);
  if (q) add('q', q);
  if (isMaterialType(state.type)) add('type', state.type);
  const brand = cleanBrand(state.brand);
  if (brand) add('brand', brand);
  if (isStockFilter(state.stock)) add('stock', state.stock);
  if (isSort(state.sort)) add('sort', state.sort);
  if (Number.isInteger(state.page) && state.page >= 2) add('page', String(state.page));
  return parts.join('&');
}

// ---------------------------------------------------------------- search

interface Token {
  text: string;
  /** Six lowercase hex digits when the token is a colour hex, '#' optional. */
  hex: string | null;
  /** Lowercase PF-ID code prefix when the PF-ID rule applies to this token. */
  pfCode: string | null;
}

function toToken(text: string): Token {
  const bare = text.replace(/^#/, '');
  const code = text.replace(/^pf-?/, '');
  return {
    text,
    hex: /^[0-9a-f]{6}$/.test(bare) ? bare : null,
    pfCode: code && (text.startsWith('pf') || code.length === 4) ? code : null,
  };
}

/** A spool's PF-ID code, lowercase and without 'PF-' ('' when it has none). */
function spoolCode(spool: FilamentStockSpool): string {
  return (spool.printforgeId ?? '').toLowerCase().replace(/^pf-/, '');
}

/** Whether every token matches the row (AND), and the spools matched by PF-ID. */
function matchRow(row: FilamentStockRow, tokens: Token[]): FilamentStockSpool[] | null {
  const fields = [row.color, row.name, row.brand, row.type].map((v) => (v ?? '').toLowerCase());
  for (const s of row.spools) {
    if (s.isActive && s.locationName) fields.push(s.locationName.toLowerCase());
  }
  const hex = (row.colorHex ?? '').replace(/^#/, '').toLowerCase();
  const hits: FilamentStockSpool[] = [];
  for (const token of tokens) {
    let ok = fields.some((f) => f.includes(token.text)) || (token.hex !== null && hex === token.hex);
    if (token.pfCode !== null) {
      for (const s of row.spools) {
        if (!spoolCode(s).startsWith(token.pfCode)) continue;
        ok = true;
        if (!hits.includes(s)) hits.push(s);
      }
    }
    if (!ok) return null;
  }
  return hits;
}

/** The spool named by a whole query shaped like a PF-ID, when exactly one spool has it. */
function findPfidHit(rows: readonly FilamentStockRow[], q: string): FilamentPfidHit | null {
  const m = /^(pf-?)?([a-z0-9]{4})$/i.exec(cleanQuery(q));
  if (!m) return null;
  const target = `PF-${m[2].toUpperCase()}`;
  let hit: FilamentPfidHit | null = null;
  let found = 0;
  for (const row of rows) {
    for (const spool of row.spools) {
      if ((spool.printforgeId ?? '').toUpperCase() !== target) continue;
      found += 1;
      hit = { row, spool };
    }
  }
  return found === 1 ? hit : null;
}

/**
 * The list's search rule as a predicate (same tokens as filterFilaments): every
 * token must match colour, name, brand, type, an active spool's location, the
 * colour hex ('#' optional) or a spool PF-ID prefix. '' matches every row.
 */
export function filamentQueryMatcher(q: string): (row: FilamentStockRow) => boolean {
  const tokens = cleanQuery(q).toLowerCase().split(/\s+/).filter(Boolean).map(toToken);
  return (row) => tokens.length === 0 || matchRow(row, tokens) !== null;
}

// ---------------------------------------------------------------- sort

function cmpText(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'base' });
}

function colourKey(row: FilamentStockRow): string {
  return (row.color || row.name).trim();
}

/** Brand A–Z with brandless rows last. */
function cmpBrand(a: FilamentStockRow, b: FilamentStockRow): number {
  const x = (a.brand ?? '').trim();
  const y = (b.brand ?? '').trim();
  if (!x !== !y) return x ? -1 : 1;
  return cmpText(x, y);
}

function cmpTies(a: FilamentStockRow, b: FilamentStockRow): number {
  return cmpText(colourKey(a), colourKey(b)) || cmpBrand(a, b) || cmpText(a.name, b.name);
}

function typeRank(row: FilamentStockRow): number {
  const i = MATERIAL_TYPE_OPTIONS.findIndex((o) => o.value === row.type);
  return i === -1 ? MATERIAL_TYPE_OPTIONS.length : i;
}

function createdMs(row: FilamentStockRow): number {
  const ms = Date.parse(row.createdAt);
  return Number.isFinite(ms) ? ms : 0;
}

function comparator(sort: FilamentSort): (a: FilamentStockRow, b: FilamentStockRow) => number {
  switch (sort) {
    case 'brand': return (a, b) => cmpBrand(a, b) || cmpTies(a, b);
    case 'type': return (a, b) => typeRank(a) - typeRank(b) || cmpTies(a, b);
    case 'stock-asc': return (a, b) => a.totalStock - b.totalStock || cmpTies(a, b);
    case 'stock-desc': return (a, b) => b.totalStock - a.totalStock || cmpTies(a, b);
    case 'newest': return (a, b) => createdMs(b) - createdMs(a) || cmpTies(a, b);
    default: return cmpTies;
  }
}

// ---------------------------------------------------------------- filter

function brandFacets(rows: readonly FilamentStockRow[]) {
  const byKey = new Map<string, string>();
  let hasNoBrand = false;
  for (const row of rows) {
    const key = normText(row.brand);
    if (!key) hasNoBrand = true;
    else if (!byKey.has(key)) byKey.set(key, (row.brand ?? '').trim());
  }
  const brandOptions = [...byKey.values()].sort(cmpText).map((b) => ({ value: b, label: b }));
  return { byKey, brandOptions, hasNoBrand };
}

/**
 * Applies search, Type, Brand, the stock chip, sort and paging. Chip counts
 * cover every row passing search, Type and Brand, before the chip is applied.
 */
export function filterFilaments(rows: readonly FilamentStockRow[], state: FilamentListState): FilamentFilterResult {
  const { byKey, brandOptions, hasNoBrand } = brandFacets(rows);
  const typesPresent = MATERIAL_TYPE_OPTIONS.map((o) => o.value).filter((t) => rows.some((r) => r.type === t));

  let brand = '';
  if (state.brand === NO_BRAND) brand = hasNoBrand ? NO_BRAND : '';
  else if (state.brand) brand = byKey.get(normText(state.brand)) ?? '';
  const brandKey = normText(brand);

  const tokens = cleanQuery(state.q).toLowerCase().split(/\s+/).filter(Boolean).map(toToken);
  const hitsById = new Map<string, FilamentStockSpool[]>();
  const counts: FilamentStockCounts = { all: 0, low: 0, out: 0 };
  const matched: FilamentStockRow[] = [];

  for (const row of rows) {
    if (state.type && row.type !== state.type) continue;
    if (brand === NO_BRAND ? normText(row.brand) !== '' : brand !== '' && normText(row.brand) !== brandKey) continue;
    const hits = tokens.length ? matchRow(row, tokens) : [];
    if (hits === null) continue;

    counts.all += 1;
    if (row.stockStatus !== 'ok') counts.low += 1;
    if (row.stockStatus === 'out') counts.out += 1;

    if (state.stock === 'low' && row.stockStatus === 'ok') continue;
    if (state.stock === 'out' && row.stockStatus !== 'out') continue;
    matched.push(row);
    if (hits.length) hitsById.set(row.id, hits);
  }

  matched.sort(comparator(state.sort));
  const totalPages = Math.max(1, Math.ceil(matched.length / FILAMENTS_PER_PAGE));
  const wanted = Number.isInteger(state.page) && state.page >= 1 ? state.page : 1;
  const page = Math.min(wanted, totalPages);

  return {
    pageRows: matched.slice((page - 1) * FILAMENTS_PER_PAGE, page * FILAMENTS_PER_PAGE),
    matchedCount: matched.length,
    totalCount: rows.length,
    page,
    totalPages,
    counts,
    spoolHits: Object.fromEntries(hitsById),
    pfidHit: findPfidHit(rows, state.q),
    brandOptions,
    typesPresent,
    hasNoBrand,
    brand,
  };
}

// ---------------------------------------------------------------- scan label

/** The brand, type and colour read off a spool label, as the review dialog holds them. */
export interface ScanIdentity {
  brand: string | null | undefined;
  type: MaterialTypeValue;
  color: string | null | undefined;
}

/**
 * The filaments a scanned label belongs to, searched over EVERY row: same type,
 * and the same brand and colour after normText, so case and spacing never
 * matter but exact names do ('Red' is not 'Fire Engine Red'). A blank brand
 * matches only brandless filaments; it is never a wildcard. Oldest first
 * (createdAt, then id), the same row the server names for a duplicate.
 */
export function findScanMatches(rows: readonly FilamentStockRow[], scan: ScanIdentity): FilamentStockRow[] {
  const brand = normText(scan.brand);
  const color = normText(scan.color);
  return rows
    .filter((r) => r.type === scan.type && normText(r.brand) === brand && normText(r.color) === color)
    .sort((a, b) => createdMs(a) - createdMs(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * A scanned brand in the catalogue's spelling: the listed brand equal to it
 * after normText, otherwise the only listed brand that starts with it as a
 * whole word ('Bambu' becomes 'Bambu Lab'). Anything else comes back unchanged.
 */
export function catalogueBrandSpelling(scanned: string, brands: readonly string[]): string {
  const key = normText(scanned);
  if (!key) return scanned;
  const exact = brands.find((b) => normText(b) === key);
  if (exact !== undefined) return exact.trim();
  const longer = brands.filter((b) => normText(b).startsWith(`${key} `));
  return longer.length === 1 ? longer[0].trim() : scanned;
}
