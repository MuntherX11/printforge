/**
 * The printer a G-code was sliced for, read from the slicer's own header or
 * config block. Pure, no I/O.
 *
 * Formats seen on the owner's files:
 * - OrcaSlicer / Bambu Studio / Creality Print 5+ / PrusaSlicer config block:
 *     `; printer_model = Creality Hi`
 *     `; printer_settings_id = Creality Hi 0.4 nozzle`
 *     `; printer_notes = ... PRINTER_MODEL_MK3 ...` (PrusaSlicer vendor profiles)
 * - Creality Print 4 (CXEngine): `;Machine Name:F001` — an internal code
 * - Cura: `;TARGET_MACHINE.NAME:Creality Ender-3 Pro`
 */

/** Internal machine codes some slicers write instead of a name (Creality Print 4). */
const MACHINE_CODES: Record<string, string> = {
  // Creality Print 4 writes F001 for the Ender-3 V3 (the owner's "…-Ender-3 V3_0.4_Hyper PLA" exports).
  F001: 'Creality Ender-3 V3',
};

const MAX_LEN = 120;

/** Trim the nozzle, "- Copy" and "@vendor" tails a printer profile name carries. */
export function cleanProfileName(raw: string): string {
  return raw
    .replace(/^"+|"+$/g, '')
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s*@.*$/, '')
    .replace(/\s*-\s*copy(\s*\(\d+\))?\s*$/i, '')
    .replace(/\s+\d+(\.\d+)?\s*(mm)?\s*nozzle\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LEN);
}

function valueOf(line: string, key: RegExp): string | null {
  const m = line.match(key);
  if (!m) return null;
  const v = m[1].trim();
  return v ? v : null;
}

/**
 * The printer model of a G-code, or null when the file doesn't say. Prefers
 * `printer_model`, then the printer profile name, then Cura's target machine,
 * then a Creality machine code, then PrusaSlicer's PRINTER_MODEL_ note.
 */
export function detectPrinterModel(text: string): string | null {
  let model: string | null = null;
  let settings: string | null = null;
  let cura: string | null = null;
  let machine: string | null = null;
  let notes: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith(';')) continue;
    model ??= valueOf(line, /^;\s*printer_model\s*=\s*(.+)$/i);
    settings ??= valueOf(line, /^;\s*printer_settings_id\s*=\s*(.+)$/i);
    cura ??= valueOf(line, /^;\s*TARGET_MACHINE\.NAME\s*:\s*(.+)$/i);
    machine ??= valueOf(line, /^;\s*Machine Name\s*:\s*(.+)$/i);
    if (notes === null) {
      // PrusaSlicer vendor keywords, separated by a literal "\n" in the header: PRINTER_MODEL_MK3S
      const n = line.match(/^;\s*printer_notes\s*=.*?PRINTER_MODEL_([A-Z0-9]+(?:_[A-Z0-9]+)*)/);
      if (n) notes = n[1].replace(/_/g, ' ');
    }
  }
  if (model) return model.replace(/^"+|"+$/g, '').trim().slice(0, MAX_LEN) || null;
  if (settings) {
    const s = cleanProfileName(settings);
    if (s) return s;
  }
  if (cura) return cura.slice(0, MAX_LEN);
  if (machine) return MACHINE_CODES[machine.toUpperCase()] ?? machine.slice(0, MAX_LEN);
  return notes ? notes.slice(0, MAX_LEN) : null;
}

/** `printer_model` / `printer_settings_id` of a 3MF's Metadata/project_settings.config (JSON). */
export function printerModelFromProjectSettings(json: string): string | null {
  let cfg: unknown;
  try {
    cfg = JSON.parse(json);
  } catch {
    return null;
  }
  if (!cfg || typeof cfg !== 'object') return null;
  const rec = cfg as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const model = str(rec.printer_model);
  if (model) return model.slice(0, MAX_LEN);
  const settings = str(rec.printer_settings_id);
  return settings ? cleanProfileName(settings) || null : null;
}
