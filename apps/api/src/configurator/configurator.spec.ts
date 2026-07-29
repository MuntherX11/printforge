/**
 * Configurator → order-attachment security tests.
 *
 * Each block maps to a section of the implementation spec. These are the
 * acceptance criteria expressed as executable checks.
 */
import JSZip from 'jszip';
import { NameplateGenerator } from './generators/nameplate.generator';
import { getGenerator, listGenerators } from './generators/registry';
import { slab, Mesh } from './geometry/mesh';
import { toBinarySTL, to3MF } from './geometry/serialize';
import { sanitizeSvg } from './util/svg-sanitizer';
import { Semaphore } from './util/semaphore';

const gen = new NameplateGenerator();
const validParams = { width: 40, height: 20, thickness: 3, holeDiameter: 4, label: 'Munther' };

/** Every edge must be shared by exactly two triangles => closed surface. */
function isWatertight(mesh: Mesh): { ok: boolean; openEdges: number } {
  const key = (a: any, b: any) =>
    `${a.x.toFixed(4)},${a.y.toFixed(4)},${a.z.toFixed(4)}|${b.x.toFixed(4)},${b.y.toFixed(4)},${b.z.toFixed(4)}`;
  const counts = new Map<string, number>();
  for (const t of mesh.triangles) {
    for (const [p, q] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as const) {
      // Undirected edge: canonicalise ordering
      const k1 = key(p, q);
      const k2 = key(q, p);
      const k = k1 < k2 ? k1 : k2;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  let openEdges = 0;
  for (const c of counts.values()) if (c !== 2) openEdges++;
  return { ok: openEdges === 0, openEdges };
}

// ============ §6 Server-side validation is authoritative ============
describe('§6 server-side parameter validation', () => {
  it('accepts a valid parameter set', () => {
    const spec = gen.validate(validParams);
    expect(spec.width).toBe(40);
    expect(spec.thickness).toBe(3);
  });

  it.each([
    ['negative width', { ...validParams, width: -5 }],
    ['zero width', { ...validParams, width: 0 }],
    ['zero thickness', { ...validParams, thickness: 0 }],
    ['negative thickness', { ...validParams, thickness: -1 }],
    ['oversized width', { ...validParams, width: 10_000 }],
    ['oversized thickness', { ...validParams, thickness: 999 }],
    ['NaN width', { ...validParams, width: NaN }],
    ['Infinity height', { ...validParams, height: Infinity }],
    ['-Infinity height', { ...validParams, height: -Infinity }],
    ['non-numeric width', { ...validParams, width: 'abc' }],
    ['null width', { ...validParams, width: null }],
    ['object injected as width', { ...validParams, width: { evil: true } }],
  ])('rejects %s', (_label, params) => {
    expect(() => gen.validate(params as any)).toThrow();
  });

  it('bounds `height` explicitly (the gap called out in the spec)', () => {
    expect(() => gen.validate({ ...validParams, height: -1 })).toThrow();
    expect(() => gen.validate({ ...validParams, height: 0 })).toThrow();
    expect(() => gen.validate({ ...validParams, height: 99_999 })).toThrow();
  });

  it('rejects a hole too large for the plate', () => {
    expect(() => gen.validate({ ...validParams, width: 20, height: 20, holeDiameter: 19 })).toThrow();
  });

  it('rejects missing/!object params', () => {
    expect(() => gen.validate(null)).toThrow();
    expect(() => gen.validate('nope')).toThrow();
  });

  it('caps segments so triangle count cannot explode', () => {
    expect(() => gen.validate({ ...validParams, segments: 100_000 })).toThrow();
    const spec = gen.validate({ ...validParams, segments: 256 });
    expect(spec.segments).toBe(256);
  });

  it('strips control characters (NUL/TAB/ESC/DEL) from the label', () => {
    const raw = 'a' + String.fromCharCode(9) + 'b' + String.fromCharCode(0)
      + 'c' + String.fromCharCode(27) + 'd' + String.fromCharCode(127);
    const spec = gen.validate({ ...validParams, label: raw });
    const codes = [...spec.label].map((c) => c.charCodeAt(0));
    expect(codes.some((c) => c < 0x20 || c === 0x7f)).toBe(false);
    expect(spec.label).toBe('abcd');
  });

  it('caps label length', () => {
    const spec = gen.validate({ ...validParams, label: 'x'.repeat(500) });
    expect(spec.label.length).toBeLessThanOrEqual(60);
  });
  it('errors carry a short message, not a stack trace', () => {
    try {
      gen.validate({ ...validParams, width: -1 });
      throw new Error('should have thrown');
    } catch (err: any) {
      const msg = err?.response?.message ?? err.message;
      expect(String(msg)).toMatch(/width/i);
      expect(String(msg)).not.toMatch(/at .*\(/); // no stack frames
    }
  });
});

// ============ §1/§5 Server generates bounded, watertight geometry ============
describe('§1/§5 server-generated geometry is well-formed', () => {
  it('produces a watertight mesh with a hole', () => {
    const mesh = slab({ width: 40, depth: 20, thickness: 3, holeDiameter: 4, segments: 48 });
    const res = isWatertight(mesh);
    expect(res.openEdges).toBe(0);
    expect(res.ok).toBe(true);
  });

  it('produces a watertight mesh without a hole', () => {
    const mesh = slab({ width: 40, depth: 20, thickness: 3 });
    expect(isWatertight(mesh).ok).toBe(true);
    expect(mesh.triangleCount).toBe(12);
  });

  it('keeps the triangle count bounded by segments', () => {
    const small = slab({ width: 40, depth: 20, thickness: 3, holeDiameter: 4, segments: 12 });
    const big = slab({ width: 40, depth: 20, thickness: 3, holeDiameter: 4, segments: 256 });
    expect(small.triangleCount).toBe(12 * 8);
    expect(big.triangleCount).toBe(256 * 8);
    expect(big.triangleCount).toBeLessThan(5000); // hard ceiling, no explosion
  });

  it('is deterministic — same params produce identical bytes', async () => {
    const spec = gen.validate(validParams);
    const a = await gen.generate(spec);
    const b = await gen.generate(spec);
    const stlA = a.find((f) => f.filename.endsWith('.stl'))!;
    const stlB = b.find((f) => f.filename.endsWith('.stl'))!;
    expect(stlA.body.equals(stlB.body)).toBe(true);
  });

  it('emits a valid binary STL with a matching triangle count', async () => {
    const spec = gen.validate(validParams);
    const files = await gen.generate(spec);
    const stl = files.find((f) => f.filename.endsWith('.stl'))!;
    const count = stl.body.readUInt32LE(80);
    expect(stl.body.length).toBe(84 + count * 50);
    expect(count).toBe(spec.segments * 8);
  });

  it('emits a structurally valid 3MF zip', async () => {
    const spec = gen.validate(validParams);
    const files = await gen.generate(spec);
    const threemf = files.find((f) => f.filename.endsWith('.3mf'))!;
    const zip = await JSZip.loadAsync(threemf.body);
    expect(zip.file('[Content_Types].xml')).toBeTruthy();
    expect(zip.file('_rels/.rels')).toBeTruthy();
    const model = await zip.file('3D/3dmodel.model')!.async('string');
    expect(model).toContain('<model unit="millimeter"');
    expect(model).toContain('<triangle ');
    expect(model).toContain('<build><item objectid="1"/></build>');
  });

  it('never lets customer text escape into the 3MF XML', async () => {
    const spec = gen.validate({ ...validParams, label: '"><script>alert(1)</script>' });
    const files = await gen.generate(spec);
    const zip = await JSZip.loadAsync(files.find((f) => f.filename.endsWith('.3mf'))!.body);
    const model = await zip.file('3D/3dmodel.model')!.async('string');
    expect(model).not.toContain('<script>');
  });
});

// ============ §3a Filenames/keys carry no raw customer input ============
describe('§3a filename safety (storage keys are opaque server-side)', () => {
  it('sanitises path traversal attempts out of the download filename', async () => {
    const spec = gen.validate({ ...validParams, label: '../../etc/passwd' });
    const files = await gen.generate(spec);
    for (const f of files) {
      expect(f.filename).not.toContain('..');
      expect(f.filename).not.toContain('/');
      expect(f.filename).not.toContain('\\');
      expect(f.filename).toMatch(/^[a-zA-Z0-9._-]+$/);
    }
  });

  it('sanitises null bytes and shell metacharacters', async () => {
    const spec = gen.validate({ ...validParams, label: 'a;rm -rf ~|b$(x)' });
    const files = await gen.generate(spec);
    for (const f of files) expect(f.filename).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it('falls back to a safe base name when the label is empty', async () => {
    const spec = gen.validate({ ...validParams, label: '' });
    const files = await gen.generate(spec);
    expect(files[0].filename.startsWith('tag-')).toBe(true);
  });
});

// ============ §2 Previews are pure (no disk writes) ============
describe('§2 preview surface is read-only', () => {
  it('info() and previewSvg() are synchronous and touch no fs', () => {
    const spec = gen.validate(validParams);
    const info = gen.info(spec);
    expect(info.dimensions).toEqual({ width: 40, height: 20, depth: 3 });
    expect(typeof gen.previewSvg(spec)).toBe('string');
  });

  it('preview SVG escapes customer text (no stored XSS via label)', () => {
    const spec = gen.validate({ ...validParams, label: '<script>alert(1)</script>' });
    const svg = gen.previewSvg(spec);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('surfaces warnings for risky-but-valid geometry', () => {
    const spec = gen.validate({ ...validParams, thickness: 1 });
    expect(gen.info(spec).warnings.length).toBeGreaterThan(0);
  });
});

// ============ §4 SVG upload sanitisation ============
describe('§4 SVG sanitizer', () => {
  it('strips <script> from an uploaded SVG', () => {
    const res = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>');
    expect(res.ok).toBe(true);
    expect(res.svg).not.toContain('<script');
    expect(res.svg).toContain('<rect');
  });

  it('rejects XXE / DOCTYPE entity declarations', () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&xxe;</svg>`;
    const res = sanitizeSvg(xxe);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/DOCTYPE|entity/i);
  });

  it('rejects billion-laughs style nested entities', () => {
    const bomb = `<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><svg xmlns="http://www.w3.org/2000/svg">&lol2;</svg>`;
    expect(sanitizeSvg(bomb).ok).toBe(false);
  });

  it('strips inline event handlers', () => {
    const res = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><rect onload="alert(1)" onclick='x()'/></svg>`);
    expect(res.ok).toBe(true);
    expect(res.svg).not.toMatch(/onload|onclick/i);
  });

  it('strips javascript: and data: hrefs', () => {
    const res = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>`);
    expect(res.ok).toBe(true);
    expect(res.svg).not.toMatch(/javascript:/i);
  });

  it('rejects oversized uploads', () => {
    const huge = '<svg xmlns="http://www.w3.org/2000/svg">' + 'a'.repeat(600 * 1024) + '</svg>';
    const res = sanitizeSvg(huge);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/limit/i);
  });

  // --- external-reference vectors found by adversarial verification of the
  // shirt-generator port (SVG signature upload surface) ---
  it('rejects <image> pulling a remote URL', () => {
    const res = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><image href="http://evil.test/x.png"/></svg>');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/external/i);
  });

  it('rejects <image> pulling a local file:// path', () => {
    const res = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/external/i);
  });

  it('rejects protocol-relative references', () => {
    const res = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><image href="//evil.test/x.png"/></svg>');
    expect(res.ok).toBe(false);
  });

  it('rejects xi:include', () => {
    const res = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="/etc/passwd"/></svg>');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/xinclude|external/i);
  });

  it('rejects external url() in a style attribute', () => {
    const res = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(http://evil.test/x)"/></svg>');
    expect(res.ok).toBe(false);
  });

  it('strips animation elements', () => {
    const res = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect><animate attributeName="x" to="9"/></rect></svg>');
    expect(res.ok).toBe(true);
    expect(res.svg).not.toMatch(/<animate/i);
  });

  it('still accepts a clean local SVG', () => {
    const res = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 10 Z" fill="#333"/></svg>');
    expect(res.ok).toBe(true);
    expect(res.svg).toContain('<path');
  });

  it('rejects non-SVG input', () => {
    expect(sanitizeSvg('not an svg at all').ok).toBe(false);
  });
});

// ============ §8 Concurrency cap ============
describe('§8 generation concurrency cap', () => {
  it('never runs more than `max` tasks at once', async () => {
    const sem = new Semaphore(3);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 25 }, () =>
        sem.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(active).toBe(0);
  });

  it('sheds load with a 503 when the queue is saturated', async () => {
    const sem = new Semaphore(1, 2); // 1 active + 2 queued
    const slow = () => sem.run(() => new Promise((r) => setTimeout(r, 50)));
    const running = [slow(), slow(), slow()]; // fills active + queue
    await expect(slow()).rejects.toMatchObject({ status: 503 });
    await Promise.all(running);
  });

  it('releases its slot even when the task throws', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });
});

// ============ Registry ============
describe('generator registry', () => {
  it('exposes the nameplate generator', () => {
    expect(listGenerators().map((g) => g.key)).toContain('nameplate');
    expect(getGenerator('nameplate').name).toBe('Nameplate / Tag');
  });

  it('throws NotFound for an unknown generator key', () => {
    expect(() => getGenerator('../../etc/passwd')).toThrow();
    expect(() => getGenerator('nope')).toThrow();
  });
});
