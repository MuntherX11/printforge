/**
 * Tiny, structurally valid image files for specs. Only the parts the sniffer
 * and the metadata stripper look at are real; pixel data is filler.
 */
import { crc32 } from '../image-sniff';

function seg(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** Little-endian TIFF with IFD0 = [Orientation?, GPS IFD pointer], GPS IFD holding an ASCII "GPS…" value. */
function exifTiff(orientation?: number): Buffer {
  const secret = Buffer.from('GPSSECRET-23.58N-58.40E\0', 'latin1');
  const ifd0Entries = orientation ? 2 : 1;
  const ifd0Size = 2 + ifd0Entries * 12 + 4;
  const gpsIfdOffset = 8 + ifd0Size;
  const gpsIfdSize = 2 + 12 + 4;
  const secretOffset = gpsIfdOffset + gpsIfdSize;
  const t = Buffer.alloc(secretOffset + secret.length);
  t.write('II', 0, 'latin1');
  t.writeUInt16LE(42, 2);
  t.writeUInt32LE(8, 4);
  let p = 8;
  t.writeUInt16LE(ifd0Entries, p);
  p += 2;
  if (orientation) {
    t.writeUInt16LE(0x0112, p);
    t.writeUInt16LE(3, p + 2);
    t.writeUInt32LE(1, p + 4);
    t.writeUInt16LE(orientation, p + 8);
    p += 12;
  }
  t.writeUInt16LE(0x8825, p); // GPSInfo IFD pointer
  t.writeUInt16LE(4, p + 2);
  t.writeUInt32LE(1, p + 4);
  t.writeUInt32LE(gpsIfdOffset, p + 8);
  p += 12;
  t.writeUInt32LE(0, p);
  p = gpsIfdOffset;
  t.writeUInt16LE(1, p);
  t.writeUInt16LE(0x001b, p + 2); // GPSProcessingMethod
  t.writeUInt16LE(7, p + 4); // UNDEFINED
  t.writeUInt32LE(secret.length, p + 6);
  t.writeUInt32LE(secretOffset, p + 10);
  t.writeUInt32LE(0, p + 14);
  secret.copy(t, secretOffset);
  return t;
}

export interface JpegOpts {
  width: number;
  height: number;
  progressive?: boolean;
  /** Adds an Exif APP1 with a GPS IFD; orientation is included when given. */
  exif?: boolean;
  orientation?: number;
  xmp?: boolean;
  comment?: boolean;
  iptc?: boolean;
  /** Omit the SOF segment entirely. */
  noSof?: boolean;
}

export function makeJpeg(o: JpegOpts): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  parts.push(seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')));
  if (o.exif) parts.push(seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exifTiff(o.orientation)])));
  if (o.xmp) {
    parts.push(
      seg(
        0xe1,
        Buffer.from(
          'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"><exif:GPSLatitude>23,35N</exif:GPSLatitude></x:xmpmeta>',
          'latin1',
        ),
      ),
    );
  }
  if (o.iptc) parts.push(seg(0xed, Buffer.from('Photoshop 3.0\0 8BIM secret caption', 'latin1')));
  if (o.comment) parts.push(seg(0xfe, Buffer.from('shot at home, device serial 12345', 'latin1')));
  parts.push(seg(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01fakeprofile', 'latin1')));
  parts.push(seg(0xdb, Buffer.alloc(65, 1))); // DQT
  if (!o.noSof) {
    const sof = Buffer.alloc(15);
    sof[0] = 8;
    sof.writeUInt16BE(o.height, 1);
    sof.writeUInt16BE(o.width, 3);
    sof[5] = 3;
    parts.push(seg(o.progressive ? 0xc2 : 0xc0, sof));
  }
  parts.push(seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0, 0, 0, 0, 0])));
  parts.push(Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a]));
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

export interface PngOpts {
  width: number;
  height: number;
  text?: boolean;
  exif?: boolean;
  time?: boolean;
}

export function makePng(o: PngOpts): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(o.width, 0);
  ihdr.writeUInt32BE(o.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr)];
  if (o.text) parts.push(pngChunk('tEXt', Buffer.from('Comment\0GPSSECRET home address', 'latin1')));
  if (o.exif) parts.push(pngChunk('eXIf', exifTiff(6)));
  if (o.time) parts.push(pngChunk('tIME', Buffer.from([7, 0xe8, 1, 2, 3, 4, 5])));
  parts.push(pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0, 0, 0, 1, 0, 1])));
  parts.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function riffChunk(fourcc: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  const pad = data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([head, data, pad]);
}

function riff(chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

function vp8Data(width: number, height: number): Buffer {
  const d = Buffer.alloc(14);
  d[0] = 0x10; // key frame tag (filler)
  d[3] = 0x9d;
  d[4] = 0x01;
  d[5] = 0x2a;
  d.writeUInt16LE(width & 0x3fff, 6);
  d.writeUInt16LE(height & 0x3fff, 8);
  return d;
}

export function makeWebpVp8(width: number, height: number): Buffer {
  return riff([riffChunk('VP8 ', vp8Data(width, height))]);
}

export function makeWebpVp8l(width: number, height: number): Buffer {
  const d = Buffer.alloc(10);
  d[0] = 0x2f;
  d.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1);
  return riff([riffChunk('VP8L', d)]);
}

export function makeWebpVp8x(width: number, height: number, meta = true): Buffer {
  const x = Buffer.alloc(10);
  x[0] = meta ? 0x08 | 0x04 : 0;
  x.writeUIntLE(width - 1, 4, 3);
  x.writeUIntLE(height - 1, 7, 3);
  const chunks = [riffChunk('VP8X', x), riffChunk('VP8 ', vp8Data(width, height))];
  if (meta) {
    chunks.push(riffChunk('EXIF', exifTiff(6)));
    chunks.push(riffChunk('XMP ', Buffer.from('<x:xmpmeta>http://ns.adobe.com/xap/1.0/ GPS</x:xmpmeta>', 'latin1')));
  }
  return riff(chunks);
}

export function makeHeic(): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(24, 0);
  b.write('ftypheic', 4, 'latin1');
  b.write('mif1heic', 16, 'latin1');
  return b;
}
