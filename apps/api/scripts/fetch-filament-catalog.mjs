/**
 * Pull the filamentcolors.xyz swatch database into a local snapshot.
 *
 * The catalogue is bundled rather than queried live so adding a filament keeps
 * working when the upstream site is slow or down, and so a data-entry session
 * never stalls on someone else's uptime. Re-run to refresh.
 *
 * Data: https://filamentcolors.xyz — CC BY 4.0.
 */
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'filament-catalog.json');
const BASE = 'https://filamentcolors.xyz/api/swatch/?page_size=200';

const rows = [];
let url = BASE;
let page = 0;

while (url && page < 60) {
  process.stdout.write(`fetching page ${++page}... `);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  const body = await res.json();
  for (const s of body.results ?? []) {
    // Only what a filament record actually needs. Images, colour-theory links
    // and Pantone/RAL cross-references are left upstream. Upstream LAB is
    // dropped too: it is populated for only about half the swatches, and is
    // absent on some of the ones colour matching most depends on. LAB is
    // derived from hex at runtime instead, so every swatch is measured the
    // same way.
    if (!s.hex_color) continue;
    rows.push({
      id: s.id,
      brand: s.manufacturer?.name ?? null,
      colour: s.color_name ?? null,
      type: s.filament_type?.name ?? null,
      family: s.filament_type?.parent_type?.name ?? null,
      hex: String(s.hex_color).replace('#', '').toUpperCase(),
      hotEnd: s.filament_type?.hot_end_temp ?? null,
      bed: s.filament_type?.bed_temp ?? null,
    });
  }
  console.log(`${rows.length} total`);
  url = body.next;
}

rows.sort((a, b) => (a.brand ?? '').localeCompare(b.brand ?? '') || (a.colour ?? '').localeCompare(b.colour ?? ''));
writeFileSync(OUT, JSON.stringify({
  source: 'https://filamentcolors.xyz',
  licence: 'CC BY 4.0',
  fetchedAt: new Date().toISOString(),
  count: rows.length,
  swatches: rows,
}, null, 0));
console.log(`\nwrote ${rows.length} swatches -> ${OUT}`);
