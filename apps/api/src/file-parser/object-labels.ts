/**
 * Count the objects on a sliced plate from the slicer's object labels.
 *
 * Slicers label every placed instance so printers can cancel one mid-print
 * (Klipper's exclude-object UI is exactly what Creality printers expose).
 * Those labels double as an exact object count: "Box x 12.gcode" defines 12.
 */

export type ObjectLabelSource = 'klipper' | 'marlin' | 'comment';

export interface PlateObjects {
  /** null = the file carries no object labels, so the count is unknown — NOT zero. */
  objectCount: number | null;
  /** Instances grouped by source model: "12 x sardines base v2" vs a mixed plate. */
  objectModels: Array<{ model: string; count: number }>;
  objectLabelSource: ObjectLabelSource | null;
  /** Labels on the plate that are not items — the purge tower — and were not counted. */
  ignoredLabels: string[];
}

// Every placed instance carries its id and copy number:
//   Klipper label:  sarindes_base_v2_id_3_copy_0
//   Orca comment:   sarindes base v2 id:3 copy 0
//   Prusa comment:  Shape-Box.stl id:0 copy 2
const INSTANCE_SUFFIX = /[\s_]id[:_]?\d+[\s_]copy[\s_]?\d+\s*$/i;
const MODEL_EXTENSION = /\.(stl|3mf|obj|step|stp)$/i;

export function modelNameOf(label: string): string {
  const base = label.replace(INSTANCE_SUFFIX, '').replace(MODEL_EXTENSION, '').replace(/_/g, ' ').trim();
  return base || label;
}

/**
 * The purge/wipe/prime tower is printed on the plate but is not a sellable
 * item, so it must never count as one. Matched on the WHOLE model name, not a
 * substring: real products are called "castle tower v3" and "Sarah's Tower",
 * and a contains-"tower" rule would silently drop them from the count.
 * (OrcaSlicer does not label its tower at all — verified against 334 real
 * plates — but other slicers and versions may.)
 */
const PURGE_TOWER_NAMES = new Set(['wipetower', 'primetower', 'purgetower']);

export function isPurgeTower(label: string): boolean {
  return PURGE_TOWER_NAMES.has(modelNameOf(label).toLowerCase().replace(/[^a-z]/g, ''));
}

/** The rest of each line following `needle`, optionally stopping before `stopAt`. */
function scanLines(buf: Buffer, needle: string, stopAt?: string): string[] {
  const out: string[] = [];
  const n = Buffer.from(needle);
  const stop = stopAt ? buf.indexOf(stopAt) : -1;
  const end = stop === -1 ? buf.length : stop;
  let i = buf.indexOf(n);
  while (i !== -1 && i < end) {
    const from = i + n.length;
    let eol = buf.indexOf(0x0a, from);
    if (eol === -1) eol = buf.length;
    out.push(buf.subarray(from, eol).toString('utf-8').replace(/\r$/, ''));
    i = buf.indexOf(n, eol);
  }
  return out;
}

function group(labels: string[]): Array<{ model: string; count: number }> {
  const counts = new Map<string, number>();
  for (const l of labels) {
    const m = modelNameOf(l);
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  return Array.from(counts, ([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
}

/**
 * Scans the WHOLE buffer, not a header window: each Klipper label carries the
 * object's outline polygon, so a large plate's labels can run past the first
 * 64 KB that header parsing reads, and a partial count would silently
 * under-state the plate.
 *
 * Sources, most to least authoritative:
 *   klipper — EXCLUDE_OBJECT_DEFINE
 *   marlin  — M486 S<n> (with optional M486 A<name>)
 *   comment — "; printing object <name>" markers
 */
export function detectPlateObjects(buf: Buffer): PlateObjects {
  const result = (labels: string[], source: ObjectLabelSource): PlateObjects => {
    const items = labels.filter((l) => !isPurgeTower(l));
    const ignored = labels.filter(isPurgeTower);
    // A plate whose only label is its tower has no countable items: unknown.
    if (items.length === 0) {
      return { objectCount: null, objectModels: [], objectLabelSource: null, ignoredLabels: ignored };
    }
    return { objectCount: items.length, objectModels: group(items), objectLabelSource: source, ignoredLabels: ignored };
  };

  // Defines always precede the first object's print moves, so stop there.
  const klipper = new Set(
    scanLines(buf, 'EXCLUDE_OBJECT_DEFINE NAME=', 'EXCLUDE_OBJECT_START')
      .map((rest) => rest.split(/\s/)[0])
      .filter(Boolean),
  );
  if (klipper.size > 0) return result([...klipper], 'klipper');

  const ids = new Set<number>();
  const names = new Map<number, string>();
  let current: number | null = null;
  for (const rest of scanLines(buf, 'M486 ')) {
    const s = rest.match(/^S(-?\d+)/);
    if (s) {
      const id = parseInt(s[1], 10);
      // S-1 marks "no object" between labelled moves, not an object.
      current = id >= 0 ? id : null;
      if (id >= 0) ids.add(id);
      continue;
    }
    const a = rest.match(/^A(.+)$/);
    if (a && current !== null && !names.has(current)) names.set(current, a[1].trim());
  }
  if (ids.size > 0) return result([...ids].map((id) => names.get(id) ?? `object ${id}`), 'marlin');

  const comments = new Set(scanLines(buf, '; printing object ').map((x) => x.trim()).filter(Boolean));
  if (comments.size > 0) return result([...comments], 'comment');

  return { objectCount: null, objectModels: [], objectLabelSource: null, ignoredLabels: [] };
}
