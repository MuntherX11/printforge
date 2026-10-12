// Bundled OrcaSlicer system presets, looked up through the vendor index files
// (resources/profiles/<Vendor>.json). Each index maps preset names to paths
// relative to resources/profiles/<Vendor>/.
import fs from 'node:fs';
import path from 'node:path';

const LIST_KEY = { machine: 'machine_list', process: 'process_list', filament: 'filament_list' };

/**
 * Load every vendor index under `profilesDir` once. Returns a lookup that
 * resolves a preset by kind and name, preferring the vendor the child came
 * from (chains never leave their vendor in OrcaSlicer, but a user preset may
 * start in any vendor, e.g. a Creality printer with an OrcaFilamentLibrary
 * filament).
 */
export function loadSystemIndex(profilesDir) {
  /** @type {Map<string, Map<string, Map<string, string>>>} kind -> vendor -> name -> file */
  const byKind = new Map(Object.keys(LIST_KEY).map((k) => [k, new Map()]));
  const vendorOfRaw = new WeakMap();
  const cache = new Map();
  const vendors = [];

  let entries = [];
  try {
    entries = fs.readdirSync(profilesDir).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    throw new Error(`cannot read profiles dir ${profilesDir}: ${err.message}`);
  }
  for (const file of entries) {
    let index;
    try {
      index = JSON.parse(fs.readFileSync(path.join(profilesDir, file), 'utf8'));
    } catch {
      continue; // blacklist.json and the like
    }
    if (typeof index?.name !== 'string') continue;
    const vendor = index.name;
    vendors.push(vendor);
    for (const [kind, listKey] of Object.entries(LIST_KEY)) {
      const list = Array.isArray(index[listKey]) ? index[listKey] : [];
      const names = byKind.get(kind);
      if (!names.has(vendor)) names.set(vendor, new Map());
      const map = names.get(vendor);
      for (const item of list) {
        if (typeof item?.name !== 'string' || typeof item?.sub_path !== 'string') continue;
        const rel = path.normalize(item.sub_path);
        if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
        map.set(item.name, path.join(profilesDir, vendor, rel));
      }
    }
  }

  function readPreset(file, vendor) {
    if (cache.has(file)) return cache.get(file);
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      vendorOfRaw.set(raw, vendor);
    } catch {
      raw = null;
    }
    cache.set(file, raw);
    return raw;
  }

  function findVendors(kind, name) {
    const found = [];
    for (const [vendor, map] of byKind.get(kind) ?? []) {
      if (map.has(name)) found.push(vendor);
    }
    return found;
  }

  /**
   * @param {'machine'|'process'|'filament'} kind
   * @param {string} name
   * @param {object} [child] the preset that inherits `name` (used to prefer its vendor)
   * @returns {object|null}
   */
  function lookup(kind, name, child) {
    if (!LIST_KEY[kind] || typeof name !== 'string') return null;
    const preferred = child ? vendorOfRaw.get(child) : undefined;
    const candidates = findVendors(kind, name);
    if (candidates.length === 0) return null;
    let vendor = candidates[0];
    if (preferred && candidates.includes(preferred)) {
      vendor = preferred;
    } else if (candidates.length > 1) {
      // Ambiguous root helper (e.g. fdm_filament_common exists in many vendors)
      // reached from a request preset: prefer the Orca library, else first vendor.
      vendor = candidates.includes('OrcaFilamentLibrary') ? 'OrcaFilamentLibrary' : candidates[0];
    }
    return readPreset(byKind.get(kind).get(vendor).get(name), vendor);
  }

  /**
   * Bundled presets of one kind a user can pick: instantiable ones only (the
   * abstract `fdm_*` roots and `instantiation: "false"` bases are skipped).
   * Names are filtered before any preset file is read, so a search never
   * opens more files than it has candidates.
   *
   * @param {'machine'|'process'|'filament'} kind
   * @param {{q?: string, limit?: number}} [options] case-insensitive substring of the name
   * @returns {Array<{name: string, vendor: string}>} sorted by name
   */
  function list(kind, { q = '', limit = 50 } = {}) {
    if (!LIST_KEY[kind]) return [];
    const needle = String(q).trim().toLowerCase();
    const names = new Set();
    for (const map of byKind.get(kind).values()) {
      for (const name of map.keys()) {
        if (name.startsWith('fdm_')) continue;
        if (needle && !name.toLowerCase().includes(needle)) continue;
        names.add(name);
      }
    }
    const out = [];
    for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
      if (out.length >= limit) break;
      const raw = lookup(kind, name);
      if (!raw || raw.instantiation !== 'true') continue;
      out.push({ name, vendor: vendorOfRaw.get(raw) ?? '' });
    }
    return out;
  }

  return {
    vendors,
    lookup,
    list,
    vendorOf: (raw) => vendorOfRaw.get(raw),
    /** lookup bound to one kind, in the shape flattenPreset's lookup expects */
    forKind: (kind) => (name, child) => lookup(kind, name, child),
  };
}
