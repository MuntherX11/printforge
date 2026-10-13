// Mixed-plate naming and G-code object labels (pure).
//
// Every model of a mixed job is placed in the scratch dir as `in<k>_<j>.stl`
// (k = index in the request's `inputs`, j = object index inside that input), so
// the labels orca-slicer writes can be mapped back to the request whatever the
// original file was called. Orca derives a label from the input path:
//
//   EXCLUDE_OBJECT_DEFINE NAME=C_/scratch/job-x/in0_0.stl_2_id_1_copy_0 CENTER=...
//
// `_2` is the copy number (absent when the file was loaded once), `_id_.._copy_..`
// is added by the G-code writer. Asking for more copies than fit still exits 0
// with an arbitrary subset on the plate, so the labels are the only truth.

/** Scratch file name of object `j` of input `k`. */
export function scratchName(k, j) {
  if (!Number.isInteger(k) || k < 0 || !Number.isInteger(j) || j < 0) {
    throw new RangeError('scratchName needs non-negative integer indexes');
  }
  return `in${k}_${j}.stl`;
}

/** Object labels of a G-code file, in file order. */
export function objectLabels(gcode) {
  const labels = [];
  const re = /^EXCLUDE_OBJECT_DEFINE NAME=(.*?)(?: CENTER=.*| POLYGON=.*)?$/gm;
  for (let m = re.exec(gcode); m !== null; m = re.exec(gcode)) labels.push(m[1].trim());
  return labels;
}

// `in<k>_<j>.stl` as a whole file name: not glued to a longer word on either
// side, so `in1_0.stl` never matches inside `in11_0.stl` or `main1_0.stl`.
const SCRATCH_NAME = /(?<![A-Za-z0-9])in(\d+)_(\d+)\.stl(?![A-Za-z0-9])/g;

/**
 * Which scratch file a label belongs to, or null (wipe tower, foreign names).
 * @returns {{input: number, object: number}|null}
 */
export function parseLabel(label) {
  let last = null;
  for (const m of String(label).matchAll(SCRATCH_NAME)) last = m;
  return last ? { input: Number(last[1]), object: Number(last[2]) } : null;
}

/**
 * Complete units placed per input. An input whose project holds several
 * objects loads each as its own file with the same copy count, and an overfull
 * plate keeps an arbitrary subset of every file, so a unit is complete only
 * when all of its objects are there: the count is the smallest label count
 * over the input's objects.
 * @param {string} gcode
 * @param {number} inputCount
 * @param {number[]} [objectCounts] objects per input (default 1 each)
 * @returns {number[]} one count per input, in request order
 */
export function countInputUnits(gcode, inputCount, objectCounts = []) {
  const objects = (k) => (Number.isInteger(objectCounts[k]) && objectCounts[k] > 0 ? objectCounts[k] : 1);
  const placed = Array.from({ length: inputCount }, (_, k) => new Array(objects(k)).fill(0));
  for (const label of objectLabels(gcode)) {
    const hit = parseLabel(label);
    if (hit && hit.input < inputCount && hit.object < placed[hit.input].length) placed[hit.input][hit.object] += 1;
  }
  return placed.map((counts) => Math.min(...counts));
}

/**
 * The STL files `--export-stls` wrote (`obj_<N>_<name>.stl`), in object order.
 * @param {string[]} names directory listing
 */
export function exportedStls(names) {
  return names
    .map((name) => ({ name, m: /^obj_(\d+)_.*\.stl$/i.exec(name) }))
    .filter((e) => e.m)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]) || (a.name < b.name ? -1 : 1))
    .map((e) => e.name);
}
