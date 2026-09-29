import {
  FILAMENTS_PER_PAGE,
  MaterialType,
  NO_BRAND,
  catalogueBrandSpelling,
  filterFilaments,
  findScanMatches,
  normText,
  parseFilamentListState,
  serializeFilamentListState,
  type MaterialTypeValue,
} from '@printforge/types';
import {
  catalog,
  esunFire,
  esunRed,
  ids,
  row,
  spool,
  state,
} from './__fixtures__/filament-rows';

// Location and colour-hex search: filament-filter-places.spec.ts.

/** URLSearchParams-like reader over a query string. */
const params = (qs: string) => new URLSearchParams(qs);

// ---------------------------------------------------------------- normText

describe('normText', () => {
  it('trims, collapses inner whitespace and lowercases; empty values give ""', () => {
    expect(normText('  Fire   Engine  RED ')).toBe('fire engine red');
    expect(normText(null)).toBe('');
    expect(normText(undefined)).toBe('');
    expect(normText('   ')).toBe('');
  });
});

// ---------------------------------------------------------------- search

describe('filterFilaments search', () => {
  it('ANDs every token: "esun red petg" matches only eSUN PETG Red', () => {
    expect(ids(catalog, { q: 'esun red petg' })).toEqual(['esun-petg-red']);
  });

  it('matches tokens across colour, name, brand, type and active-spool location, ignoring case', () => {
    expect(ids(catalog, { q: 'BLACK' })).toEqual(['poly-black']); // colour
    expect(ids(catalog, { q: 'generic' })).toEqual(['nobrand-grey']); // name
    expect(ids(catalog, { q: 'polymaker' })).toEqual(['poly-black']); // brand
    expect(ids(catalog, { q: 'Petg' })).toEqual(['esun-petg-red']); // type
    expect(ids(catalog, { q: 'rack' })).toEqual(['bambu-white']); // active spool location
    expect(ids(catalog, { q: 'shelf b black' })).toEqual(['poly-black']); // location AND colour
  });

  it('keeps exact colour names apart: "red" gives both eSun reds as separate rows, "fire engine" only one', () => {
    const red = ids([esunRed, esunFire], { q: 'red' });
    expect(red).toHaveLength(2);
    expect(red).toEqual(expect.arrayContaining(['esun-red', 'esun-fire']));
    expect(ids([esunRed, esunFire], { q: 'fire engine' })).toEqual(['esun-fire']);
  });

  it('an empty or whitespace query matches every row', () => {
    expect(filterFilaments(catalog, state({ q: '   ' })).matchedCount).toBe(catalog.length);
  });

  it('trims the query, then caps it at 100 characters', () => {
    const hundred = row('hundred', { name: 'x'.repeat(100) });
    // 'x' * 100 + 'zzz' only matches because the query is cut to its first 100 characters.
    expect(ids([hundred], { q: `${'x'.repeat(100)}zzz` })).toEqual(['hundred']);
    expect(ids([hundred], { q: `${'x'.repeat(99)}zzz` })).toEqual([]);
    // Leading spaces are trimmed before the cap, so they never push the text out.
    expect(ids(catalog, { q: `${' '.repeat(150)}black` })).toEqual(['poly-black']);
  });
});

describe('filterFilaments PF-ID rule', () => {
  it.each(['PF-A7X2', 'pf-a7x2', 'A7X2', 'a7x2', 'pfa7x2'])('%s finds the owning filament and fills spoolHits', (q) => {
    const r = filterFilaments(catalog, state({ q }));
    expect(r.pageRows.map((x) => x.id)).toEqual(['poly-black']);
    expect(r.spoolHits['poly-black'].map((s) => s.printforgeId)).toEqual(['PF-A7X2']);
  });

  it('"pf-a7" matches by prefix', () => {
    const r = filterFilaments(catalog, state({ q: 'pf-a7' }));
    expect(r.pageRows.map((x) => x.id)).toEqual(['poly-black']);
    expect(r.spoolHits['poly-black'].map((s) => s.printforgeId)).toEqual(['PF-A7X2']);
  });

  it('"red" never matches a PF-ID: spool PF-RED4 does not pull in its White filament', () => {
    const r = filterFilaments(catalog, state({ q: 'red' }));
    expect(r.pageRows.map((x) => x.id)).not.toContain('bambu-white');
    expect(r.spoolHits).toEqual({});
  });

  it('"pf-red4" does match spool PF-RED4', () => {
    expect(ids(catalog, { q: 'pf-red4' })).toEqual(['bambu-white']);
  });

  it("an inactive spool's PF-ID still finds its filament, and the hit says inactive", () => {
    const r = filterFilaments(catalog, state({ q: 'PF-OLD9' }));
    expect(r.pageRows.map((x) => x.id)).toEqual(['poly-black']);
    expect(r.spoolHits['poly-black']).toEqual([expect.objectContaining({ printforgeId: 'PF-OLD9', isActive: false })]);
  });

  it('a spool with a null PF-ID never matches and never throws', () => {
    const legacy = row('legacy', { color: 'Blue', spools: [spool(null)] });
    expect(ids([legacy], { q: 'pf-a7' })).toEqual([]);
    expect(ids([legacy], { q: 'blue' })).toEqual(['legacy']);
  });

  it.each(['pf', 'PF-', ' pf- '])("a lone '%s' (a PF-ID being typed) keeps every row and adds no spool hints", (q) => {
    const r = filterFilaments(catalog, state({ q }));
    expect(r.matchedCount).toBe(catalog.length);
    expect(r.counts.all).toBe(catalog.length);
    expect(r.spoolHits).toEqual({});
    expect(ids(catalog, { q: 'pf- black' })).toEqual(['poly-black']);
  });

  it('spoolHits only lists rows that matched', () => {
    const r = filterFilaments(catalog, state({ q: 'a7x2', type: 'PETG' }));
    expect(r.matchedCount).toBe(0);
    expect(r.spoolHits).toEqual({});
  });
});

// ---------------------------------------------------------------- filters

describe('filterFilaments Type and Brand', () => {
  it('type=PETG keeps only PETG rows', () => {
    expect(ids(catalog, { type: 'PETG' })).toEqual(['esun-petg-red']);
  });

  it("brand 'esun' matches 'eSUN', 'eSun' and ' eSun ' and reports the first spelling as the brand in effect", () => {
    const spaced = row('spaced', { color: 'Blue', brand: ' eSun ' });
    const r = filterFilaments([...catalog, spaced], state({ brand: 'esun' }));
    expect(r.matchedCount).toBe(4);
    expect(r.pageRows.map((x) => x.id)).toEqual(expect.arrayContaining(['esun-red', 'esun-fire', 'esun-petg-red', 'spaced']));
    expect(r.brand).toBe('eSun');
  });

  it('brand=__none__ returns only the brandless rows', () => {
    const blank = row('blank-brand', { color: 'Teal', brand: '   ' });
    expect(ids([...catalog, blank], { brand: NO_BRAND })).toEqual(['nobrand-grey', 'blank-brand']);
  });

  it('a brand no filament has is ignored', () => {
    const r = filterFilaments(catalog, state({ brand: 'Prusament' }));
    expect(r.matchedCount).toBe(catalog.length);
    expect(r.brand).toBe('');
    const none = filterFilaments([esunRed], state({ brand: NO_BRAND }));
    expect(none.matchedCount).toBe(1);
    expect(none.brand).toBe('');
  });

  it('brandOptions group case-insensitively after trim, A–Z, from all rows; hasNoBrand flags brandless rows', () => {
    const r = filterFilaments(catalog, state({ q: 'black' }));
    expect(r.brandOptions.map((o) => o.label)).toEqual(['Bambu Lab', 'eSun', 'Polymaker']);
    expect(r.brandOptions.every((o) => o.value === o.label)).toBe(true);
    expect(r.hasNoBrand).toBe(true);
    expect(filterFilaments([esunRed], state()).hasNoBrand).toBe(false);
  });

  it('typesPresent lists only the types in the data, in enum order', () => {
    const nylon = row('nylon', { type: MaterialType.NYLON });
    expect(filterFilaments([nylon, ...catalog], state()).typesPresent).toEqual(['PLA', 'PETG', 'NYLON']);
    expect(filterFilaments([], state()).typesPresent).toEqual([]);
  });
});

describe('filterFilaments stock chips', () => {
  const ok = row('ok', { color: 'Red', stockStatus: 'ok' });
  const low = row('low', { color: 'Red', stockStatus: 'low', totalStock: 100 });
  const out = row('out', { color: 'Red', stockStatus: 'out', totalStock: 0 });
  const blueOut = row('blue-out', { color: 'Blue', stockStatus: 'out', totalStock: 0 });
  const rows = [ok, low, out, blueOut];

  it('counts rows after search/type/brand and before the stock filter; low includes out', () => {
    expect(filterFilaments(rows, state()).counts).toEqual({ all: 4, low: 3, out: 2 });
    const red = filterFilaments(rows, state({ q: 'red', stock: 'out' }));
    expect(red.counts).toEqual({ all: 3, low: 2, out: 1 });
    expect(red.pageRows.map((r) => r.id)).toEqual(['out']);
  });

  it("stock=low returns 'low' and 'out' rows; stock=out returns only 'out' rows", () => {
    expect(ids(rows, { stock: 'low' }).sort()).toEqual(['blue-out', 'low', 'out']);
    expect(ids(rows, { stock: 'out' }).sort()).toEqual(['blue-out', 'out']);
  });
});

// ---------------------------------------------------------------- sort

describe('filterFilaments sort', () => {
  it('Colour A–Z sorts by colour, falling back to name, ignoring case, ties broken by brand', () => {
    const rows = [
      row('red-zeta', { color: 'Red', brand: 'Zeta' }),
      row('noname', { color: null, name: 'Mystery grey' }),
      row('amber', { color: 'amber' }),
      row('red-alpha', { color: 'red', brand: 'Alpha' }),
      row('Black', { color: 'Black' }),
    ];
    expect(ids(rows)).toEqual(['amber', 'Black', 'noname', 'red-alpha', 'red-zeta']);
  });

  it('Brand A–Z puts brandless rows last, then colour', () => {
    const rows = [
      row('none', { color: 'Aqua', brand: null }),
      row('b-red', { color: 'Red', brand: 'bambu lab' }),
      row('a-blue', { color: 'Blue', brand: 'Anycubic' }),
      row('b-black', { color: 'Black', brand: 'Bambu Lab' }),
      row('blank', { color: 'Beige', brand: '  ' }),
    ];
    expect(ids(rows, { sort: 'brand' })).toEqual(['a-blue', 'b-black', 'b-red', 'none', 'blank']);
  });

  it('Type sorts in enum order, then colour', () => {
    const rows = [
      row('other', { type: MaterialType.OTHER, color: 'A' }),
      row('petg-b', { type: MaterialType.PETG, color: 'B' }),
      row('pla', { type: MaterialType.PLA, color: 'Z' }),
      row('petg-a', { type: MaterialType.PETG, color: 'A' }),
    ];
    expect(ids(rows, { sort: 'type' })).toEqual(['pla', 'petg-a', 'petg-b', 'other']);
  });

  it('stock-asc and stock-desc order by totalStock grams', () => {
    const rows = [row('mid', { totalStock: 500 }), row('high', { totalStock: 2000.5 }), row('low', { totalStock: 12 })];
    expect(ids(rows, { sort: 'stock-asc' })).toEqual(['low', 'mid', 'high']);
    expect(ids(rows, { sort: 'stock-desc' })).toEqual(['high', 'mid', 'low']);
  });

  it('newest orders by createdAt descending', () => {
    const rows = [
      row('jan', { createdAt: '2026-01-05T10:00:00.000Z' }),
      row('mar', { createdAt: '2026-03-01T10:00:00.000Z' }),
      row('feb', { createdAt: '2026-02-11T10:00:00.000Z' }),
    ];
    expect(ids(rows, { sort: 'newest' })).toEqual(['mar', 'feb', 'jan']);
  });
});

// ---------------------------------------------------------------- paging

describe('filterFilaments paging', () => {
  const sixty = Array.from({ length: 60 }, (_, i) => row(`r${String(i).padStart(2, '0')}`, { color: `Colour ${String(i).padStart(2, '0')}` }));

  it('25 per page: 60 matches give 3 pages and page 3 has 10 rows', () => {
    expect(FILAMENTS_PER_PAGE).toBe(25);
    const first = filterFilaments(sixty, state());
    expect(first.totalPages).toBe(3);
    expect(first.pageRows).toHaveLength(25);
    const third = filterFilaments(sixty, state({ page: 3 }));
    expect(third.page).toBe(3);
    expect(third.pageRows).toHaveLength(10);
    expect(third.pageRows[0].id).toBe('r50');
  });

  it('page 9 clamps to the last page; page 0, negative or fractional becomes 1', () => {
    expect(filterFilaments(sixty, state({ page: 9 })).page).toBe(3);
    expect(filterFilaments(sixty, state({ page: 0 })).page).toBe(1);
    expect(filterFilaments(sixty, state({ page: -2 })).page).toBe(1);
    expect(filterFilaments(sixty, state({ page: 1.5 })).page).toBe(1);
  });

  it("page 'abc' or '0' in the URL parses to 1", () => {
    expect(parseFilamentListState(params('page=abc')).page).toBe(1);
    expect(parseFilamentListState(params('page=0')).page).toBe(1);
    expect(parseFilamentListState(params('page=2.5')).page).toBe(1);
  });

  it('no rows gives one empty page', () => {
    const r = filterFilaments([], state({ page: 4 }));
    expect(r).toEqual(expect.objectContaining({ page: 1, totalPages: 1, matchedCount: 0, totalCount: 0, pageRows: [] }));
  });
});

// ---------------------------------------------------------------- URL

describe('filament list URL state', () => {
  it('the default state serialises to an empty string', () => {
    expect(serializeFilamentListState(state())).toBe('');
    expect(parseFilamentListState(params(''))).toEqual(state());
  });

  it('writes keys in the order q, type, brand, stock, sort, page and round-trips', () => {
    const full = state({ q: 'fire engine', type: 'PETG', brand: 'Bambu Lab', stock: 'low', sort: 'stock-desc', page: 3 });
    const qs = serializeFilamentListState(full);
    expect(qs).toBe('q=fire%20engine&type=PETG&brand=Bambu%20Lab&stock=low&sort=stock-desc&page=3');
    expect(parseFilamentListState(params(qs))).toEqual(full);
    const none = state({ brand: NO_BRAND, stock: 'out', sort: 'newest' });
    expect(parseFilamentListState(params(serializeFilamentListState(none)))).toEqual(none);
  });

  it('round-trips characters that need escaping', () => {
    const odd = state({ q: 'a&b=c #91202B 100%' });
    expect(parseFilamentListState(params(serializeFilamentListState(odd)))).toEqual(odd);
  });

  it('omits page 1', () => {
    expect(serializeFilamentListState(state({ sort: 'brand', page: 1 }))).toBe('sort=brand');
  });

  it('unknown sort, stock or type values fall back to the defaults without throwing', () => {
    expect(parseFilamentListState(params('sort=x&page=abc&stock=empty&type=pla&brand='))).toEqual(state());
    expect(parseFilamentListState(params('type=WOOD'))).toEqual(state());
  });

  it('q is trimmed and capped at 100 characters', () => {
    expect(parseFilamentListState(params('q=%20%20esun%20red%20%20')).q).toBe('esun red');
    const parsed = parseFilamentListState(params(`q=${'a'.repeat(150)}`));
    expect(parsed.q).toHaveLength(100);
    expect(serializeFilamentListState(state({ q: `  ${'b'.repeat(120)}  ` }))).toBe(`q=${'b'.repeat(100)}`);
  });
});

// ---------------------------------------------------------------- pfidHit

describe('filterFilaments pfidHit', () => {
  it("an exact 'PF-A7X2' query with one matching spool returns { row, spool }", () => {
    for (const q of ['PF-A7X2', ' pf-a7x2 ', 'a7x2', 'PFA7X2']) {
      const hit = filterFilaments(catalog, state({ q })).pfidHit;
      expect(hit?.row.id).toBe('poly-black');
      expect(hit?.spool.printforgeId).toBe('PF-A7X2');
    }
  });

  it('finds an inactive spool too', () => {
    expect(filterFilaments(catalog, state({ q: 'PF-OLD9' })).pfidHit?.spool.isActive).toBe(false);
  });

  it('is null for a query that is not PF-shaped or names no spool', () => {
    expect(filterFilaments(catalog, state({ q: 'pf-a7' })).pfidHit).toBeNull();
    expect(filterFilaments(catalog, state({ q: 'PF-A7X2 black' })).pfidHit).toBeNull();
    expect(filterFilaments(catalog, state({ q: 'PF-ZZZZ' })).pfidHit).toBeNull();
    expect(filterFilaments(catalog, state({ q: 'red' })).pfidHit).toBeNull();
    expect(filterFilaments(catalog, state()).pfidHit).toBeNull();
  });

  it('is null when two spools share the PF-ID', () => {
    const twin = row('twin', { spools: [spool('PF-A7X2')] });
    expect(filterFilaments([...catalog, twin], state({ q: 'PF-A7X2' })).pfidHit).toBeNull();
  });

  it('ignores the Type, Brand and stock filters', () => {
    expect(filterFilaments(catalog, state({ q: 'PF-A7X2', type: 'PETG' })).pfidHit?.row.id).toBe('poly-black');
  });
});

// ---------------------------------------------------------------- scan label

describe('findScanMatches', () => {
  const matchIds = (brand: string | null, type: MaterialTypeValue, color: string | null, rows = catalog) =>
    findScanMatches(rows, { brand, type, color }).map((r) => r.id);

  it('compares brand, type and colour trimmed, case-insensitively and with spaces collapsed', () => {
    expect(matchIds('eSUN', 'PLA', ' fire  engine red')).toEqual(['esun-fire']);
    expect(matchIds(' ESUN ', 'PLA', 'RED')).toEqual(['esun-red']);
  });

  it('keeps exact colour names apart: "Red" never matches Fire Engine Red', () => {
    expect(matchIds('eSun', 'PLA', 'Red')).toEqual(['esun-red']);
    expect(matchIds('eSun', 'PLA', 'Engine Red')).toEqual([]);
  });

  it('an empty brand matches only brandless filaments, never a branded one', () => {
    expect(matchIds('', 'PLA', 'Red')).toEqual([]);
    expect(matchIds('  ', 'PLA', 'grey')).toEqual(['nobrand-grey']);
    expect(matchIds(null, 'PLA', 'Grey')).toEqual(['nobrand-grey']);
  });

  it('a different type never matches', () => {
    expect(matchIds('eSUN', 'PETG', 'Fire Engine Red')).toEqual([]);
    expect(matchIds('eSUN', 'PETG', 'Red')).toEqual(['esun-petg-red']);
  });

  it('searches every row, not one page: a match at row 60 is found', () => {
    const many = Array.from({ length: 59 }, (_, i) => row(`f-${i}`, { brand: 'eSUN', color: `Colour ${i}` }));
    const black = row('esun-black', { brand: 'eSUN', color: 'Black' });
    expect(matchIds('esun', 'PLA', 'black', [...many, black])).toEqual(['esun-black']);
  });

  it('two identical filaments return 2 matches, oldest first', () => {
    const newer = row('b-newer', { brand: 'eSUN', color: 'Black', createdAt: '2026-05-01T00:00:00.000Z' });
    const older = row('a-older', { brand: 'eSun', color: 'black', createdAt: '2026-02-01T00:00:00.000Z' });
    expect(matchIds('eSUN', 'PLA', 'Black', [newer, older])).toEqual(['a-older', 'b-newer']);
  });
});

describe('catalogueBrandSpelling', () => {
  const brands = ['Bambu Lab', 'eSUN', 'Polymaker', 'Poly Lite', 'Poly Terra'];

  it('uses the listed spelling for a brand equal to it ignoring case and spacing', () => {
    expect(catalogueBrandSpelling('esun', brands)).toBe('eSUN');
    expect(catalogueBrandSpelling('  POLYMAKER ', brands)).toBe('Polymaker');
  });

  it("uses the only listed brand that starts with the scan as a whole word: 'Bambu' becomes 'Bambu Lab'", () => {
    expect(catalogueBrandSpelling('Bambu', brands)).toBe('Bambu Lab');
  });

  it('leaves the scan unchanged when no brand, or more than one, fits', () => {
    expect(catalogueBrandSpelling('Poly', brands)).toBe('Poly');
    expect(catalogueBrandSpelling('Bamb', brands)).toBe('Bamb');
    expect(catalogueBrandSpelling('Hatchbox', brands)).toBe('Hatchbox');
    expect(catalogueBrandSpelling('Bambu', [])).toBe('Bambu');
    expect(catalogueBrandSpelling('', brands)).toBe('');
  });
});
