import * as fs from 'fs';
import { validateHeaderValue } from 'http';
import JSZip from 'jszip';
import * as os from 'os';
import * as path from 'path';
import { contentDisposition, lazyFileStream, zipEntryName, zipOfFiles } from './order-plate-download';

/** Sending plate files: a header any name survives, safe zip entries, files opened only when read. */

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-download-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const file = (name: string, text: string) => {
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, text);
  return abs;
};
const drain = (stream: NodeJS.ReadableStream): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
/** An opener that notes which files were opened. */
function spyOpens() {
  const opened: string[] = [];
  const open = (p: string) => {
    opened.push(path.basename(p));
    return fs.createReadStream(p);
  };
  return { opened, open, restore: () => undefined };
}

describe('contentDisposition', () => {
  it('a plain name goes in as it is, twice', () => {
    expect(contentDisposition('ORD-0042 Plate 3 Ender a1b2c.gcode')).toBe(
      'attachment; filename="ORD-0042 Plate 3 Ender a1b2c.gcode"; filename*=UTF-8\'\'ORD-0042%20Plate%203%20Ender%20a1b2c.gcode',
    );
  });

  it('an Arabic name, a quoted one or one with a line break never makes a header Node refuses', () => {
    for (const name of ['علبة x12.gcode', 'the "big" one.gcode', 'a\\b.gcode', 'line\r\nbreak: evil.gcode', 'emoji 🐟 (v2)*.gcode', '']) {
      const value = contentDisposition(name);
      expect(() => validateHeaderValue('Content-Disposition', value)).not.toThrow();
      expect(value).toMatch(/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''[A-Za-z0-9%._~!-]+$/);
      expect(value.split('filename="')[1].split('"; filename*')[0]).not.toMatch(/["\\]/);
    }
    expect(contentDisposition('علبة x12.gcode')).toContain(`filename*=UTF-8''${encodeURIComponent('علبة x12.gcode')}`);
    expect(contentDisposition('علبة x12.gcode')).toContain('filename="____ x12.gcode"');
    expect(contentDisposition('')).toContain('filename="download"');
  });
});

describe('zipEntryName', () => {
  it('no folder parts and nothing that climbs out of the folder', () => {
    expect(zipEntryName('stand x10.gcode')).toBe('stand x10.gcode');
    expect(zipEntryName('../../etc/passwd')).toBe('etc passwd');
    expect(zipEntryName('..\\..\\windows\\system32\\x.gcode')).toBe('windows system32 x.gcode');
    expect(zipEntryName('a/../b..gcode')).toBe('a b.gcode');
    expect(zipEntryName('/abs/path.gcode')).toBe('abs path.gcode');
    expect(zipEntryName('علبة.gcode')).toBe('علبة.gcode');
    for (const empty of ['', '..', '/', '\\', '...', './..']) expect(zipEntryName(empty)).toMatch(/^[^./\\][^/\\]*$|^file$/);
    for (const any of ['../x', 'a/b', 'a\\b', '..', '....//']) {
      expect(zipEntryName(any)).not.toMatch(/[\\/]/);
      expect(zipEntryName(any)).not.toContain('..');
    }
  });
});

describe('lazyFileStream', () => {
  it('opens the file at the first read, not when it is made, and gives its bytes', async () => {
    const abs = file('a.gcode', 'G28\nG1 X1\n');
    const spy = spyOpens();
    try {
      const stream = lazyFileStream(abs, spy.open);
      await new Promise((r) => setTimeout(r, 20));
      expect(spy.opened).toEqual([]);
      expect((await drain(stream)).toString()).toBe('G28\nG1 X1\n');
      expect(spy.opened).toEqual(['a.gcode']);
    } finally {
      spy.restore();
    }
  });

  it('a missing file is an error of the stream; destroying one that was never read opens nothing', async () => {
    await expect(drain(lazyFileStream(path.join(dir, 'gone.gcode')))).rejects.toThrow(/ENOENT/);
    const spy = spyOpens();
    try {
      lazyFileStream(file('b.gcode', 'x'), spy.open).destroy();
      await new Promise((r) => setTimeout(r, 20));
      expect(spy.opened).toEqual([]);
    } finally {
      spy.restore();
    }
  });
});

describe('zipOfFiles', () => {
  it('nothing is read until the zip is consumed; then every file is in it under a safe name, stored as it is', async () => {
    const entries = [{ abs: file('1.gcode', 'plate one\n'.repeat(200)), filename: 'ORD-1 Plate 1 K1 aaaaa.gcode' }, { abs: file('2.gcode', 'plate two\n'), filename: '../evil/علبة.gcode' }];
    const spy = spyOpens();
    try {
      const zip = zipOfFiles(entries, spy.open);
      await new Promise((r) => setTimeout(r, 20));
      expect(spy.opened).toEqual([]);
      const bytes = await drain(zip.stream);
      expect(spy.opened).toEqual(['1.gcode', '2.gcode']);
      const read = await JSZip.loadAsync(bytes);
      expect(Object.keys(read.files)).toEqual(['ORD-1 Plate 1 K1 aaaaa.gcode', 'evil علبة.gcode']);
      expect(await read.file('ORD-1 Plate 1 K1 aaaaa.gcode')!.async('string')).toBe('plate one\n'.repeat(200));
      // Stored, not deflated: the zip is at least as large as what it holds.
      expect(bytes.length).toBeGreaterThan('plate one\n'.repeat(200).length);
    } finally {
      spy.restore();
    }
  });

  it('a download that is given up before it starts opens no file', async () => {
    const spy = spyOpens();
    try {
      const zip = zipOfFiles([{ abs: file('1.gcode', 'x'), filename: 'a.gcode' }, { abs: file('2.gcode', 'y'), filename: 'b.gcode' }], spy.open);
      zip.destroy();
      await new Promise((r) => setTimeout(r, 20));
      expect(spy.opened).toEqual([]);
    } finally {
      spy.restore();
    }
  });
});
