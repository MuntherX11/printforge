import * as fs from 'fs/promises';

/**
 * The footprint of what a sliced plate holds, read from its G-code (v2.18.2).
 *
 * OrcaSlicer's Klipper output defines every object near the top:
 *   EXCLUDE_OBJECT_DEFINE NAME=fish.stl_1 CENTER=130,130 POLYGON=[[120,125],[140,125],[140,135],[120,135]]
 * and ends with its config block, which names the bed:
 *   ; printable_area = 0x0,260x0,260x260,0x260
 *
 * The union bounding box of the polygons of a part's x1 file is one unit (a
 * project may hold several bodies per unit), which is what "fill the plate"
 * needs to estimate how many fit. Pure parser + a reader that takes only the
 * head and the tail of the file.
 */

export interface PlateFootprint {
  /** Width and depth (mm) of the box around every object on the plate; null when the file defines none. */
  bbox: { x: number; y: number } | null;
  /** Orca's `printable_area` corner points ("0x0", "260x0", ...); null when the file does not say. */
  printableArea: string[] | null;
}

/** Bytes read from each end of the file: the defines follow the thumbnails; the config block is the last thing in it. */
export const FOOTPRINT_CHUNK_BYTES = 262_144;

const DEFINE = /^\s*EXCLUDE_OBJECT_DEFINE\b(.*)$/gim;
const POINT = /\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/g;
const AREA = /^\s*;\s*printable_area\s*=\s*(.+?)\s*$/im;
const AREA_POINT = /^-?\d+(?:\.\d+)?x-?\d+(?:\.\d+)?$/i;
/** The purge tower is not part of the unit. */
const NOT_A_PART = /NAME=\S*(wipe|purge|prime)[_-]?tower/i;

function bboxOf(text: string): PlateFootprint['bbox'] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const define of text.matchAll(DEFINE)) {
    const args = define[1];
    if (NOT_A_PART.test(args)) continue;
    const polygon = /POLYGON=(\S+)/i.exec(args)?.[1];
    if (!polygon) continue;
    for (const p of polygon.matchAll(POINT)) {
      const x = Number(p[1]);
      const y = Number(p[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const x = maxX - minX;
  const y = maxY - minY;
  return Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0 ? { x, y } : null;
}

function areaOf(text: string): string[] | null {
  const m = AREA.exec(text);
  if (!m) return null;
  const points = m[1].split(',').map((p) => p.trim()).filter(Boolean);
  return points.length >= 2 && points.every((p) => AREA_POINT.test(p)) ? points : null;
}

/** `head` holds the object defines, `tail` the config block (one text for a small file). */
export function parsePlateFootprint(head: string, tail: string = head): PlateFootprint {
  return { bbox: bboxOf(head), printableArea: areaOf(tail) ?? areaOf(head) };
}

/** Reads at most 2 x FOOTPRINT_CHUNK_BYTES of the file. Null when it cannot be read. */
export async function readPlateFootprint(absPath: string): Promise<PlateFootprint | null> {
  let file: fs.FileHandle | null = null;
  try {
    const handle = await fs.open(absPath, 'r');
    file = handle;
    const { size } = await handle.stat();
    const chunk = async (position: number, length: number) => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, position);
      return buf.subarray(0, bytesRead).toString('utf-8');
    };
    if (size <= FOOTPRINT_CHUNK_BYTES * 2) return parsePlateFootprint(await chunk(0, size));
    return parsePlateFootprint(await chunk(0, FOOTPRINT_CHUNK_BYTES), await chunk(size - FOOTPRINT_CHUNK_BYTES, FOOTPRINT_CHUNK_BYTES));
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}
