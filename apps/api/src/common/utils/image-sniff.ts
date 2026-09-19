/**
 * Byte-level image identification and metadata stripping for product photos (§3.11).
 *
 * The browser's MIME type and the file name are never trusted: a file is a photo
 * only if its magic bytes and header parse as JPEG, PNG or WebP. SVG, HTML, GIF,
 * HEIC and anything else fail the sniff.
 *
 * `stripImageMetadata` removes EXIF (including GPS), XMP, IPTC and text chunks
 * without re-encoding (no `sharp`), because phone photos carry the location of
 * this home-based farm. A JPEG keeps a minimal Orientation-only EXIF block so
 * portrait photos stay upright.
 */

export type ImageExt = 'jpg' | 'png' | 'webp';
export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

export interface ImageSniff {
  mime: ImageMime;
  ext: ImageExt;
  width: number;
  height: number;
}

/** Largest accepted side, in pixels (§3.11). */
export const MAX_IMAGE_SIDE = 12000;

export const IMAGE_MIME_BY_EXT: Record<ImageExt, ImageMime> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);

/**
 * Identifies a JPEG, PNG or WebP from its bytes and returns its type and
 * dimensions, with NO bound on the dimensions. `null` when it is not one of the
 * three types, or the header is truncated or malformed.
 */
export function readImageHeader(buf: Buffer): ImageSniff | null {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  try {
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return readJpeg(buf);
    if (buf.subarray(0, 8).equals(PNG_SIGNATURE)) return readPng(buf);
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return readWebp(buf);
  } catch {
    return null;
  }
  return null;
}

/**
 * `readImageHeader` plus the §3.11 dimension rule (1..12000 px on each side).
 * This is THE check for "is this a photo".
 */
export function sniffImage(buf: Buffer): ImageSniff | null {
  const s = readImageHeader(buf);
  if (!s) return null;
  if (!inRange(s.width) || !inRange(s.height)) return null;
  return s;
}

/** True for an ISO-BMFF HEIF/HEIC file (`ftyp` box with a HEIF brand). */
export function isHeic(buf: Buffer): boolean {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  if (buf.toString('latin1', 4, 8) !== 'ftyp') return false;
  const size = buf.readUInt32BE(0);
  const end = Math.min(buf.length, size >= 16 ? size : 16);
  if (HEIF_BRANDS.has(buf.toString('latin1', 8, 12))) return true;
  // Compatible brands follow the minor version.
  for (let o = 16; o + 4 <= end; o += 4) {
    if (HEIF_BRANDS.has(buf.toString('latin1', o, o + 4))) return true;
  }
  return false;
}

function inRange(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_IMAGE_SIDE;
}

// ---------------------------------------------------------------- JPEG

function isSof(marker: number): boolean {
  return (
    marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
  );
}

function isStandalone(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

function readJpeg(buf: Buffer): ImageSniff | null {
  let o = 2;
  while (o < buf.length) {
    if (buf[o] !== 0xff) return null;
    while (o < buf.length && buf[o] === 0xff) o++; // fill bytes
    if (o >= buf.length) return null;
    const marker = buf[o++];
    if (isStandalone(marker)) continue;
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before any SOF
    if (o + 2 > buf.length) return null;
    const len = buf.readUInt16BE(o);
    if (len < 2 || o + len > buf.length) return null;
    if (isSof(marker)) {
      if (len < 8) return null;
      const height = buf.readUInt16BE(o + 3);
      const width = buf.readUInt16BE(o + 5);
      return { mime: 'image/jpeg', ext: 'jpg', width, height };
    }
    o += len;
  }
  return null;
}

// ---------------------------------------------------------------- PNG

function readPng(buf: Buffer): ImageSniff | null {
  // Signature (8) + IHDR length (4) + 'IHDR' (4) + 13 data + CRC (4) = 33 bytes.
  if (buf.length < 33) return null;
  if (buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  if (crc32(buf.subarray(12, 29)) !== buf.readUInt32BE(29)) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { mime: 'image/png', ext: 'png', width, height };
}

// ---------------------------------------------------------------- WebP

function readWebp(buf: Buffer): ImageSniff | null {
  if (buf.length < 30) return null;
  const fourcc = buf.toString('latin1', 12, 16);
  const d = 20; // start of the first chunk's data
  if (fourcc === 'VP8 ') {
    // Frame tag (3 bytes), start code 9d 01 2a, then 14-bit width/height.
    if (buf[d + 3] !== 0x9d || buf[d + 4] !== 0x01 || buf[d + 5] !== 0x2a) return null;
    const width = buf.readUInt16LE(d + 6) & 0x3fff;
    const height = buf.readUInt16LE(d + 8) & 0x3fff;
    return { mime: 'image/webp', ext: 'webp', width, height };
  }
  if (fourcc === 'VP8L') {
    if (buf[d] !== 0x2f) return null;
    const bits = buf.readUInt32LE(d + 1);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { mime: 'image/webp', ext: 'webp', width, height };
  }
  if (fourcc === 'VP8X') {
    const width = buf.readUIntLE(d + 4, 3) + 1;
    const height = buf.readUIntLE(d + 7, 3) + 1;
    return { mime: 'image/webp', ext: 'webp', width, height };
  }
  return null;
}

// ---------------------------------------------------------------- strip

/**
 * Returns the image without its metadata, or `null` when it can't be processed
 * (malformed structure, or the result no longer sniffs as the same type with the
 * same dimensions). Callers turn `null` into 400 `"<name>" couldn't be processed`
 * (G2) or mark the legacy row "unprocessable" (BF-2).
 */
export function stripImageMetadata(buf: Buffer, sniff: ImageSniff): Buffer | null {
  let out: Buffer | null;
  try {
    if (sniff.ext === 'jpg') out = stripJpeg(buf);
    else if (sniff.ext === 'png') out = stripPng(buf);
    else if (sniff.ext === 'webp') out = stripWebp(buf);
    else out = null;
  } catch {
    out = null;
  }
  if (!out) return null;
  const again = sniffImage(out);
  if (!again || again.mime !== sniff.mime || again.width !== sniff.width || again.height !== sniff.height) {
    return null;
  }
  return out;
}

function stripJpeg(buf: Buffer): Buffer | null {
  const parts: Buffer[] = [buf.subarray(0, 2)];
  let orientation: number | null = null;
  let orientationAt = -1; // index in `parts` where the dropped Exif block was
  let o = 2;
  while (o < buf.length) {
    if (buf[o] !== 0xff) return null;
    const segStart = o;
    while (o < buf.length && buf[o] === 0xff) o++;
    if (o >= buf.length) return null;
    const marker = buf[o++];
    if (isStandalone(marker)) {
      parts.push(buf.subarray(segStart, o));
      continue;
    }
    if (marker === 0xd9) {
      parts.push(buf.subarray(segStart));
      break;
    }
    if (o + 2 > buf.length) return null;
    const len = buf.readUInt16BE(o);
    if (len < 2 || o + len > buf.length) return null;
    if (marker === 0xda) {
      // Start of scan: entropy-coded data follows; copy the rest verbatim.
      parts.push(buf.subarray(segStart));
      break;
    }
    const payload = buf.subarray(o + 2, o + len);
    const end = o + len;
    if (marker === 0xe1) {
      if (payload.toString('latin1', 0, 6) === 'Exif\0\0') {
        const orient = readExifOrientation(payload.subarray(6));
        if (orient !== null && orientation === null) {
          orientation = orient;
          orientationAt = parts.length;
        }
      }
      o = end; // drop every APP1 (Exif, XMP, extended XMP)
      continue;
    }
    if (marker === 0xed || marker === 0xfe) {
      o = end; // APP13 (Photoshop/IPTC) and COM
      continue;
    }
    parts.push(buf.subarray(segStart, end));
    o = end;
  }
  if (orientation !== null && orientation !== 1 && orientationAt >= 0) {
    parts.splice(orientationAt, 0, minimalOrientationApp1(orientation));
  }
  return Buffer.concat(parts);
}

/** Orientation (tag 0x0112) from IFD0 of a TIFF block, or null. */
function readExifOrientation(tiff: Buffer): number | null {
  if (tiff.length < 8) return null;
  const order = tiff.toString('latin1', 0, 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return null;
  const u16 = (p: number) => (le ? tiff.readUInt16LE(p) : tiff.readUInt16BE(p));
  const u32 = (p: number) => (le ? tiff.readUInt32LE(p) : tiff.readUInt32BE(p));
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > tiff.length) return null;
    if (u16(e) === 0x0112 && u16(e + 2) === 3) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** APP1 with `Exif\0\0`, a big-endian TIFF header and IFD0 holding only Orientation. */
function minimalOrientationApp1(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4); // IFD0 offset
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14); // count
  tiff.writeUInt16BE(orientation, 18); // value (left-justified), 2 bytes padding
  tiff.writeUInt32BE(0, 22); // no next IFD
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = 0xe1;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

function stripPng(buf: Buffer): Buffer | null {
  const parts: Buffer[] = [buf.subarray(0, 8)];
  let o = 8;
  let sawEnd = false;
  while (o + 12 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    const end = o + 12 + len;
    if (end > buf.length) return null;
    if (!PNG_DROP.has(type)) parts.push(buf.subarray(o, end));
    o = end;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd) return null;
  return Buffer.concat(parts);
}

function stripWebp(buf: Buffer): Buffer | null {
  const parts: Buffer[] = [];
  let o = 12;
  const riffEnd = Math.min(buf.length, 8 + buf.readUInt32LE(4));
  while (o + 8 <= riffEnd) {
    const fourcc = buf.toString('latin1', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    const padded = size + (size & 1);
    const end = o + 8 + padded;
    if (o + 8 + size > buf.length) return null;
    const chunk = Buffer.alloc(8 + padded); // a missing trailing pad byte is restored as 0
    buf.copy(chunk, 0, o, Math.min(end, buf.length));
    if (fourcc === 'EXIF' || fourcc === 'XMP ') {
      o = end;
      continue;
    }
    if (fourcc === 'VP8X' && size >= 1) chunk[8] &= ~(0x08 | 0x04);
    parts.push(chunk);
    o = end;
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

// ---------------------------------------------------------------- CRC-32

let CRC_TABLE: Uint32Array | null = null;

export function crc32(data: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
