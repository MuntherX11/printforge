import { isHeic, readImageHeader, sniffImage, stripImageMetadata } from './image-sniff';
import { jpegSegment, makeHeic, makeJpeg, makePng, makeWebpVp8, makeWebpVp8l, makeWebpVp8x } from './__fixtures__/test-images';

const has = (buf: Buffer, s: string) => buf.includes(Buffer.from(s, 'latin1'));

describe('sniffImage', () => {
  it('accepts baseline (SOF0) and progressive (SOF2) JPEG with dimensions', () => {
    expect(sniffImage(makeJpeg({ width: 640, height: 480 }))).toEqual({ mime: 'image/jpeg', ext: 'jpg', width: 640, height: 480 });
    expect(sniffImage(makeJpeg({ width: 300, height: 1200, progressive: true }))).toEqual({
      mime: 'image/jpeg', ext: 'jpg', width: 300, height: 1200,
    });
  });

  it('finds the SOF after Exif/XMP/COM segments', () => {
    const s = sniffImage(makeJpeg({ width: 10, height: 20, exif: true, orientation: 6, xmp: true, comment: true }));
    expect(s).toMatchObject({ width: 10, height: 20 });
  });

  it('accepts PNG', () => {
    expect(sniffImage(makePng({ width: 800, height: 600 }))).toEqual({ mime: 'image/png', ext: 'png', width: 800, height: 600 });
  });

  it('accepts WebP VP8, VP8L and VP8X', () => {
    expect(sniffImage(makeWebpVp8(320, 240))).toEqual({ mime: 'image/webp', ext: 'webp', width: 320, height: 240 });
    expect(sniffImage(makeWebpVp8l(1000, 16))).toEqual({ mime: 'image/webp', ext: 'webp', width: 1000, height: 16 });
    expect(sniffImage(makeWebpVp8x(4000, 3000))).toEqual({ mime: 'image/webp', ext: 'webp', width: 4000, height: 3000 });
  });

  it('rejects SVG, HTML and GIF regardless of what the browser claimed', () => {
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from('<!DOCTYPE html><html><body>hi</body></html>'))).toBeNull();
    expect(sniffImage(Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00', 'latin1'))).toBeNull();
  });

  it('rejects HEIC and recognises it as HEIC', () => {
    expect(sniffImage(makeHeic())).toBeNull();
    expect(isHeic(makeHeic())).toBe(true);
    expect(isHeic(makeJpeg({ width: 1, height: 1 }))).toBe(false);
  });

  it('rejects a truncated PNG', () => {
    const png = makePng({ width: 10, height: 10 });
    expect(sniffImage(png.subarray(0, 24))).toBeNull();
    const corrupt = Buffer.from(png);
    corrupt[20] ^= 0xff; // IHDR CRC no longer matches
    expect(sniffImage(corrupt)).toBeNull();
  });

  it('rejects a JPEG without a SOF', () => {
    expect(sniffImage(makeJpeg({ width: 10, height: 10, noSof: true }))).toBeNull();
  });

  it('rejects dimensions over 12000 (and zero), while readImageHeader still reports them', () => {
    expect(sniffImage(makeJpeg({ width: 12001, height: 100 }))).toBeNull();
    expect(sniffImage(makePng({ width: 100, height: 20000 }))).toBeNull();
    expect(sniffImage(makeWebpVp8x(12001, 5))).toBeNull();
    expect(sniffImage(makeJpeg({ width: 0, height: 100 }))).toBeNull();
    expect(sniffImage(makeJpeg({ width: 12000, height: 12000 }))).not.toBeNull();
    expect(readImageHeader(makePng({ width: 100, height: 20000 }))).toMatchObject({ height: 20000 });
  });

  it('rejects empty and tiny buffers', () => {
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });
});

describe('stripImageMetadata', () => {
  it('JPEG: drops Exif (GPS), XMP, IPTC and COM, keeps a minimal Orientation APP1 and the dimensions', () => {
    const src = makeJpeg({ width: 400, height: 300, exif: true, orientation: 6, xmp: true, comment: true, iptc: true });
    expect(has(src, 'GPS')).toBe(true);
    const s = sniffImage(src)!;
    const out = stripImageMetadata(src, s)!;
    expect(out).not.toBeNull();
    expect(has(out, 'GPS')).toBe(false);
    expect(has(out, 'http://ns.adobe.com/xap')).toBe(false);
    expect(has(out, 'Photoshop 3.0')).toBe(false);
    expect(has(out, 'device serial')).toBe(false);
    expect(has(out, 'ICC_PROFILE')).toBe(true); // APP2 kept
    expect(has(out, 'JFIF')).toBe(true); // APP0 kept
    expect(sniffImage(out)).toEqual(s);

    // Exactly one APP1, which is the minimal Orientation-only block.
    const app1 = out.indexOf(Buffer.from([0xff, 0xe1]));
    expect(app1).toBeGreaterThan(0);
    expect(out.indexOf(Buffer.from([0xff, 0xe1]), app1 + 2)).toBe(-1);
    expect(out.readUInt16BE(app1 + 2)).toBe(34);
    expect(out.toString('latin1', app1 + 4, app1 + 10)).toBe('Exif\0\0');
    const tiff = app1 + 10;
    expect(out.toString('latin1', tiff, tiff + 2)).toBe('MM');
    expect(out.readUInt16BE(tiff + 8)).toBe(1); // one entry
    expect(out.readUInt16BE(tiff + 10)).toBe(0x0112);
    expect(out.readUInt16BE(tiff + 18)).toBe(6);
  });

  it('JPEG: orientation 1 (or none) leaves no APP1 at all', () => {
    for (const orientation of [1, undefined]) {
      const src = makeJpeg({ width: 40, height: 30, exif: true, orientation });
      const out = stripImageMetadata(src, sniffImage(src)!)!;
      expect(out.indexOf(Buffer.from([0xff, 0xe1]))).toBe(-1);
      expect(has(out, 'GPS')).toBe(false);
    }
  });

  it('JPEG: the entropy-coded data after SOS is copied verbatim', () => {
    const src = makeJpeg({ width: 40, height: 30, exif: true });
    const out = stripImageMetadata(src, sniffImage(src)!)!;
    const tail = src.subarray(src.indexOf(Buffer.from([0xff, 0xda])));
    expect(out.subarray(out.length - tail.length).equals(tail)).toBe(true);
  });

  it('JPEG: a secondary image appended after EOI (an MPF preview with its own Exif GPS) is cut off', () => {
    const primary = makeJpeg({ width: 640, height: 480 });
    const secondary = makeJpeg({ width: 160, height: 120, exif: true });
    const src = Buffer.concat([primary, secondary]);
    expect(has(src, 'GPS')).toBe(true);
    const out = stripImageMetadata(src, sniffImage(src)!)!;
    expect(out).not.toBeNull();
    expect(has(out, 'GPS')).toBe(false);
    expect(has(out, 'Exif\0\0')).toBe(false);
    // The primary had nothing to strip, so what is left is exactly the primary.
    expect(out.equals(primary)).toBe(true);
    expect(sniffImage(out)).toEqual({ mime: 'image/jpeg', ext: 'jpg', width: 640, height: 480 });
  });

  it('JPEG: bytes after EOI (Samsung SEFT, motion-photo MP4 trailers) are dropped', () => {
    const primary = makeJpeg({ width: 40, height: 30, exif: true, orientation: 6 });
    const trailer = Buffer.concat([
      Buffer.from('MotionPhoto_Data\0\0\0\x18ftypmp42', 'latin1'),
      Buffer.from([0xff, 0xe1, 0x00, 0x10, 0xff, 0xd8]),
      Buffer.from('Image_UTC_Data1700000000000 +23.5880+058.3829/ SEFH', 'latin1'),
    ]);
    const src = Buffer.concat([primary, trailer]);
    const out = stripImageMetadata(src, sniffImage(src)!)!;
    expect(out).not.toBeNull();
    for (const s of ['MotionPhoto_Data', 'ftypmp42', 'Image_UTC_Data', '+23.5880+058.3829', 'SEFH']) expect(has(out, s)).toBe(false);
    expect(out.subarray(out.length - 2)).toEqual(Buffer.from([0xff, 0xd9]));
    // Same result as stripping the primary on its own (Orientation block included).
    expect(out.equals(stripImageMetadata(primary, sniffImage(primary)!)!)).toBe(true);
  });

  it('JPEG: an appended image is cut even when the primary has no EOI, and the result ends with one', () => {
    const primary = makeJpeg({ width: 40, height: 30 });
    const noEoi = primary.subarray(0, primary.length - 2);
    const src = Buffer.concat([noEoi, makeJpeg({ width: 8, height: 8, exif: true })]);
    const out = stripImageMetadata(src, sniffImage(src)!)!;
    expect(out).not.toBeNull();
    expect(has(out, 'GPS')).toBe(false);
    expect(out.equals(primary)).toBe(true);
  });

  it('JPEG progressive: every scan is kept byte-for-byte (0xFF00, RST, fill); metadata between scans is dropped', () => {
    const base = makeJpeg({ width: 300, height: 200, progressive: true });
    const head = base.subarray(0, base.length - 2); // SOI … first scan, without EOI
    const dht = jpegSegment(0xc4, Buffer.alloc(20, 2));
    const sos2 = jpegSegment(0xda, Buffer.from([1, 1, 0, 1, 5, 0x10]));
    const data2 = Buffer.from([0x01, 0xff, 0x00, 0x02, 0xff, 0xd3, 0x03, 0xff, 0xff]); // stuffed FF, RST3, fill
    const sos3 = jpegSegment(0xda, Buffer.from([1, 1, 0, 6, 63, 0x10]));
    const data3 = Buffer.from([0x05, 0x06]);
    const eoi = Buffer.from([0xff, 0xd9]);
    const src = Buffer.concat([
      head,
      dht,
      jpegSegment(0xfe, Buffer.from('between scans: device serial 999', 'latin1')),
      jpegSegment(0xe1, Buffer.from('Exif\0\0MM GPS-between-scans', 'latin1')),
      jpegSegment(0xed, Buffer.from('Photoshop 3.0\0 8BIM caption', 'latin1')),
      sos2,
      data2,
      sos3,
      data3,
      eoi,
      Buffer.from('trailer +23.5880+058.3829', 'latin1'),
    ]);
    const out = stripImageMetadata(src, sniffImage(src)!)!;
    expect(out).not.toBeNull();
    for (const s of ['device serial', 'GPS-between-scans', 'Photoshop 3.0', '+23.5880']) expect(has(out, s)).toBe(false);
    expect(out.equals(Buffer.concat([head, dht, sos2, data2, sos3, data3, eoi]))).toBe(true);
    expect(sniffImage(out)).toEqual({ mime: 'image/jpeg', ext: 'jpg', width: 300, height: 200 });
  });

  it('JPEG: drops the MPF index and APP11 JUMBF (C2PA); keeps the ICC profile and other APP11', () => {
    const base = makeJpeg({ width: 64, height: 48 });
    const mpf = jpegSegment(0xe2, Buffer.from('MPF\0MM\0\x2a\0\0\0\x08', 'latin1'));
    const jumbf = jpegSegment(
      0xeb,
      Buffer.concat([
        Buffer.from('JP', 'latin1'),
        Buffer.from([0, 1, 0, 0, 0, 1, 0, 0, 0, 40]),
        Buffer.from('jumb', 'latin1'),
        Buffer.from('c2pa stds.exif exif:GPSLatitude 23.588', 'latin1'),
      ]),
    );
    const jpegXt = jpegSegment(0xeb, Buffer.concat([Buffer.from('JP', 'latin1'), Buffer.from([0, 1, 0, 0, 0, 1, 0, 0, 0, 16]), Buffer.from('LCHK', 'latin1'), Buffer.alloc(4)]));
    const src = Buffer.concat([base.subarray(0, 2), mpf, jumbf, jpegXt, base.subarray(2)]);
    const out = stripImageMetadata(src, sniffImage(src)!)!;
    expect(out).not.toBeNull();
    expect(has(out, 'MPF\0')).toBe(false);
    expect(has(out, 'jumb')).toBe(false);
    expect(has(out, 'GPSLatitude')).toBe(false);
    expect(has(out, 'LCHK')).toBe(true);
    expect(has(out, 'ICC_PROFILE')).toBe(true);
    expect(out.equals(Buffer.concat([base.subarray(0, 2), jpegXt, base.subarray(2)]))).toBe(true);
  });

  it('JPEG: a file truncated inside its scan data is still processed, its scan data kept as it is', () => {
    const src = makeJpeg({ width: 40, height: 30, comment: true });
    const truncated = src.subarray(0, src.length - 3); // loses the EOI and one data byte
    const out = stripImageMetadata(truncated, sniffImage(truncated)!)!;
    expect(out).not.toBeNull();
    expect(has(out, 'device serial')).toBe(false);
    const sos = Buffer.from([0xff, 0xda]);
    expect(out.subarray(out.indexOf(sos)).equals(truncated.subarray(truncated.indexOf(sos)))).toBe(true);
  });

  it('PNG: loses tEXt, eXIf and tIME and still sniffs', () => {
    const src = makePng({ width: 64, height: 32, text: true, exif: true, time: true });
    const out = stripImageMetadata(src, sniffImage(src)!)!;
    expect(out).not.toBeNull();
    for (const t of ['tEXt', 'eXIf', 'tIME', 'GPS']) expect(has(out, t)).toBe(false);
    expect(has(out, 'IDAT')).toBe(true);
    expect(has(out, 'IEND')).toBe(true);
    expect(sniffImage(out)).toEqual({ mime: 'image/png', ext: 'png', width: 64, height: 32 });
  });

  it('PNG: a file with no IEND cannot be processed', () => {
    const src = makePng({ width: 4, height: 4 });
    const truncated = src.subarray(0, src.length - 12);
    expect(stripImageMetadata(truncated, sniffImage(truncated)!)).toBeNull();
  });

  it('WebP VP8X: loses EXIF/XMP chunks, clears the flags, fixes the RIFF size', () => {
    const src = makeWebpVp8x(200, 100, true);
    const out = stripImageMetadata(src, sniffImage(src)!)!;
    expect(out).not.toBeNull();
    expect(has(out, 'EXIF')).toBe(false);
    expect(has(out, 'XMP ')).toBe(false);
    expect(has(out, 'GPS')).toBe(false);
    const flags = out[20];
    expect(flags & 0x08).toBe(0);
    expect(flags & 0x04).toBe(0);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(sniffImage(out)).toEqual({ mime: 'image/webp', ext: 'webp', width: 200, height: 100 });
  });

  it('refuses when the sniff it is given does not match the bytes', () => {
    const src = makePng({ width: 4, height: 4 });
    expect(stripImageMetadata(src, { mime: 'image/png', ext: 'png', width: 5, height: 4 })).toBeNull();
  });
});
