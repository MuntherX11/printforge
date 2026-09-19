import { isHeic, readImageHeader, sniffImage, stripImageMetadata } from './image-sniff';
import { makeHeic, makeJpeg, makePng, makeWebpVp8, makeWebpVp8l, makeWebpVp8x } from './__fixtures__/test-images';

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
