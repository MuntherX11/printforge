/**
 * Generates 192x192 and 512x512 PNG icons for the PrintForge PWA.
 * No external dependencies — uses Node's built-in zlib.
 * Icon: blue (#2563eb) circle on transparent background.
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// CRC32 lookup table
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePNG(size) {
  const cx = size / 2, cy = size / 2;
  const r = size * 0.45;      // circle radius (90% of half-size)
  const pr = size * 0.28;     // inner white rounded-rect half-size
  const rr = size * 0.07;     // corner radius of inner rect

  // RGBA pixel function
  function pixel(x, y) {
    const dx = x - cx, dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Outside circle → transparent
    if (dist > r) return [0, 0, 0, 0];

    // Anti-alias circle edge (1px feather)
    const alpha = dist > r - 1 ? Math.round((r - dist) * 255) : 255;

    // Inner white rounded rectangle (mimics the SVG "PF" label area)
    const inX = Math.abs(dx) < pr - rr || (Math.abs(dx) < pr && Math.abs(dy) < pr - rr);
    const inCorner = Math.abs(dx) > pr - rr && Math.abs(dy) > pr - rr &&
      Math.sqrt((Math.abs(dx) - (pr - rr)) ** 2 + (Math.abs(dy) - (pr - rr)) ** 2) < rr;
    const inRect = inX || inCorner;

    if (inRect) {
      return [255, 255, 255, alpha]; // white
    }
    return [37, 99, 235, alpha]; // #2563eb blue
  }

  // Build raw image data (RGBA, filter byte per row)
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const i = 1 + x * 4;
      row[i] = r; row[i + 1] = g; row[i + 2] = b; row[i + 3] = a;
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows);
  const compressed = zlib.deflateSync(raw, { level: 9 });

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 6;  // RGBA color type
  // compression, filter, interlace = 0

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdrData),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'apps', 'app', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [192, 512]) {
  const buf = makePNG(size);
  const file = path.join(outDir, `icon-${size}x${size}.png`);
  fs.writeFileSync(file, buf);
  console.log(`Generated ${file} (${buf.length} bytes)`);
}
