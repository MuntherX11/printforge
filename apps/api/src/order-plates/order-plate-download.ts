import { createReadStream } from 'fs';
import JSZip from 'jszip';
import { Readable } from 'stream';

/**
 * Sending plate files to the browser (v2.19.0): the header that names a
 * download, safe names inside the zip, and a zip that opens each file only
 * when its turn comes.
 */

/**
 * `Content-Disposition` for a download. A header value is Latin-1 only, so a
 * name with Arabic letters (a plate file uploaded as "علبة x12.gcode") or a
 * quote cannot go in as it is: `filename=` carries a plain-letters fallback
 * and `filename*=` the real name (RFC 6266), which every current browser uses.
 */
export function contentDisposition(name: string): string {
  const clean = String(name ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim() || 'download';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** A file name for inside a zip: no folder parts, nothing that climbs out of the folder it is unpacked into. */
export function zipEntryName(name: string): string {
  const flat = String(name ?? '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .split(/[\\/]+/)
    // "." and ".." are steps of a path, never part of a name.
    .filter((part) => !/^\.*$/.test(part.trim()))
    .join(' ')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return flat || 'file';
}

/**
 * A readable over a file that opens it at the first read, not when it is
 * made: a zip of 200 plates then holds one open file at a time, and a download
 * that is given up never opens the rest. Destroying it closes the file.
 */
export function lazyFileStream(abs: string, open: (path: string) => Readable = createReadStream): Readable {
  let source: Readable | null = null;
  const out = new Readable({
    read() {
      if (source) {
        source.resume();
        return;
      }
      source = open(abs);
      source.on('data', (chunk) => { if (!out.push(chunk)) source!.pause(); });
      source.on('end', () => out.push(null));
      source.on('error', (e) => out.destroy(e));
    },
    destroy(err, done) {
      source?.destroy();
      done(err);
    },
  });
  return out;
}

export interface ZipDownload {
  /** The zip's bytes; nothing is read from disk until it is consumed. */
  stream: NodeJS.ReadableStream;
  /** Closes every file and stops the zip (the client went away). */
  destroy(): void;
}

/**
 * The zip of the given files, stored without compression: G-code downloads
 * are local-network transfers, and deflating hundreds of megabytes would keep
 * a core of the API busy for the whole download.
 */
export function zipOfFiles(entries: ReadonlyArray<{ abs: string; filename: string }>, open?: (path: string) => Readable): ZipDownload {
  const zip = new JSZip();
  const sources: Readable[] = [];
  for (const e of entries) {
    const source = lazyFileStream(e.abs, open);
    sources.push(source);
    zip.file(zipEntryName(e.filename), source);
  }
  const stream = zip.generateNodeStream({ streamFiles: true, compression: 'STORE' });
  return {
    stream,
    destroy() {
      for (const s of sources) s.destroy();
      (stream as unknown as { destroy?: () => void }).destroy?.();
    },
  };
}
