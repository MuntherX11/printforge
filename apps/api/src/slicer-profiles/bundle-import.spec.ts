import JSZip from 'jszip';
import { BundleError, firstUnsafeKey, isSafeEntryPath, parseBundle } from './bundle-import';

/** Build an Orca bundle in memory: `bundle_structure.json` plus the files it names. */
async function bundle(structure: Record<string, unknown>, files: Record<string, unknown>): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('bundle_structure.json', JSON.stringify(structure));
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

const machine = { type: 'machine', name: 'Creality Hi 0.4 nozzle - PF', inherits: 'Creality Hi 0.4 nozzle', from: 'User', printable_area: ['0x0', '260x0', '260x260', '0x260'] };
const process = { type: 'process', name: '0.20mm Standard @Creality Hi', inherits: '0.20mm Standard @Creality', layer_height: '0.2' };
const filament = (i: number) => ({ type: 'filament', name: `eSUN PLA+ ${i} @Creality Hi`, inherits: 'eSUN PLA+ @System', filament_density: ['1.25'] });

describe('parseBundle', () => {
  it('a printer bundle: 1 machine + 1 process + 6 filaments, inherits carried, json kept as exported', async () => {
    const filaments = Array.from({ length: 6 }, (_, i) => filament(i + 1));
    const buf = await bundle(
      {
        bundle_type: 'printer config bundle',
        printer_config: ['printer/Creality Hi 0.4 nozzle - PF.json'],
        process_config: ['process/0.20mm Standard @Creality Hi.json'],
        filament_config: filaments.map((f) => `filament/${f.name}.json`),
        printer_preset_name: 'Creality Hi 0.4 nozzle - PF',
      },
      {
        'printer/Creality Hi 0.4 nozzle - PF.json': machine,
        'process/0.20mm Standard @Creality Hi.json': process,
        ...Object.fromEntries(filaments.map((f) => [`filament/${f.name}.json`, f])),
      },
    );
    const r = await parseBundle(buf);
    expect(r.skipped).toEqual([]);
    expect(r.presets.map((p) => p.kind)).toEqual(['MACHINE', 'PROCESS', ...Array(6).fill('FILAMENT')]);
    expect(r.presets[0]).toEqual({ kind: 'MACHINE', name: 'Creality Hi 0.4 nozzle - PF', inherits: 'Creality Hi 0.4 nozzle', json: machine });
    expect(r.presets[1].json).toEqual(process);
    expect(r.presets.filter((p) => p.kind === 'FILAMENT').map((p) => p.name)).toEqual(filaments.map((f) => f.name));
    // Not flattened: inherits stays in the stored JSON (decision D11).
    expect(r.presets[2].json.inherits).toBe('eSUN PLA+ @System');
  });

  it('a filament bundle (filament_path spelling, backslash entry names, root preset)', async () => {
    const root = { type: 'filament', name: 'My PETG', filament_density: ['1.27'] };
    const zip = new JSZip();
    zip.file('bundle_structure.json', JSON.stringify({ bundle_type: 'filament config bundle', filament_path: ['filament\\My PETG.json'] }));
    zip.file('filament\\My PETG.json', JSON.stringify(root));
    const r = await parseBundle(await zip.generateAsync({ type: 'nodebuffer' }));
    expect(r.presets).toEqual([{ kind: 'FILAMENT', name: 'My PETG', inherits: null, json: root }]);
    expect(r.skipped).toEqual([]);
  });

  it('a traversal entry is rejected and never read; the rest of the bundle still imports', async () => {
    const buf = await bundle(
      { printer_config: ['../../etc/passwd.json', '/abs/machine.json', 'printer/ok.json'] },
      { 'printer/ok.json': machine, '../../etc/passwd.json': machine },
    );
    const r = await parseBundle(buf);
    expect(r.presets.map((p) => p.name)).toEqual([machine.name]);
    expect(r.skipped).toEqual([
      { name: '../../etc/passwd.json', reason: 'Unsafe path in bundle' },
      { name: '/abs/machine.json', reason: 'Unsafe path in bundle' },
    ]);
  });

  it('bad JSON, a non-string value, a missing name and a missing file are skipped with a reason', async () => {
    const buf = await bundle(
      { filament_config: ['f/broken.json', 'f/numeric.json', 'f/noname.json', 'f/missing.json', 'f/ok.json'] },
      {
        'f/broken.json': '{ not json',
        'f/numeric.json': { name: 'Numeric', filament_density: 1.25 },
        'f/noname.json': { type: 'filament' },
        'f/ok.json': filament(9),
      },
    );
    const r = await parseBundle(buf);
    expect(r.presets.map((p) => p.name)).toEqual([filament(9).name]);
    expect(r.skipped).toEqual([
      { name: 'f/broken.json', reason: 'Not valid JSON' },
      { name: 'f/numeric.json', reason: '"filament_density" is not a string or a list of strings' },
      { name: 'f/noname.json', reason: 'Preset has no "name"' },
      { name: 'f/missing.json', reason: 'Listed in bundle_structure.json but not in the archive' },
    ]);
  });

  it('the same (kind, name) twice in one bundle keeps the first', async () => {
    const buf = await bundle(
      { filament_config: ['a.json', 'b.json'] },
      { 'a.json': { name: 'Dup', x: '1' }, 'b.json': { name: 'Dup', x: '2' } },
    );
    const r = await parseBundle(buf);
    expect(r.presets).toHaveLength(1);
    expect(r.presets[0].json.x).toBe('1');
    expect(r.skipped[0].reason).toMatch(/Duplicate filament preset "Dup"/);
  });

  it('not a zip, no index, or an empty index → BundleError', async () => {
    await expect(parseBundle(Buffer.from('hello'))).rejects.toThrow(BundleError);
    const noIndex = new JSZip();
    noIndex.file('x.json', '{}');
    await expect(parseBundle(await noIndex.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow('missing bundle_structure.json');
    await expect(parseBundle(await bundle({ bundle_type: 'printer config bundle' }, {}))).rejects.toThrow('lists no presets');
  });
});

describe('guards (pure)', () => {
  it('isSafeEntryPath', () => {
    expect(isSafeEntryPath('printer/a.json')).toBe(true);
    expect(isSafeEntryPath('./printer/a.json')).toBe(true);
    expect(isSafeEntryPath('a/../../b.json')).toBe(false);
    expect(isSafeEntryPath('/etc/x')).toBe(false);
    expect(isSafeEntryPath('C:\\x.json')).toBe(false);
    expect(isSafeEntryPath('')).toBe(false);
  });

  it('firstUnsafeKey accepts strings and string arrays only', () => {
    expect(firstUnsafeKey({ a: '1', b: ['x', 'y'] })).toBeNull();
    expect(firstUnsafeKey({ a: '1', post_process: [{ cmd: 'rm' }] })).toBe('post_process');
    expect(firstUnsafeKey({ a: true })).toBe('a');
    expect(firstUnsafeKey({ a: null })).toBe('a');
  });
});
