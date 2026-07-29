import JSZip from 'jszip';
import { Mesh, Triangle, Vec3 } from './mesh';

function normal(t: Triangle): Vec3 {
  const ux = t.b.x - t.a.x, uy = t.b.y - t.a.y, uz = t.b.z - t.a.z;
  const vx = t.c.x - t.a.x, vy = t.c.y - t.a.y, vz = t.c.z - t.a.z;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / len, y: ny / len, z: nz / len };
}

/** Binary STL — 80-byte header, uint32 count, then 50 bytes per triangle. */
export function toBinarySTL(mesh: Mesh): Buffer {
  const count = mesh.triangleCount;
  const buf = Buffer.alloc(84 + count * 50);
  buf.write('PrintForge configurator', 0); // header (ignored by slicers)
  buf.writeUInt32LE(count, 80);
  let off = 84;
  for (const t of mesh.triangles) {
    const nrm = normal(t);
    buf.writeFloatLE(nrm.x, off); buf.writeFloatLE(nrm.y, off + 4); buf.writeFloatLE(nrm.z, off + 8);
    const pts = [t.a, t.b, t.c];
    let p = off + 12;
    for (const pt of pts) {
      buf.writeFloatLE(pt.x, p); buf.writeFloatLE(pt.y, p + 4); buf.writeFloatLE(pt.z, p + 8);
      p += 12;
    }
    buf.writeUInt16LE(0, off + 48); // attribute byte count
    off += 50;
  }
  return buf;
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&"']/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] as string
  ));
}

/**
 * Minimal valid 3MF (a zip: [Content_Types].xml, _rels/.rels, 3D/3dmodel.model).
 * Deduplicates vertices so the model references indexed triangles like a real
 * slicer expects. Millimetres.
 */
export async function to3MF(mesh: Mesh, name = 'model'): Promise<Buffer> {
  const index = new Map<string, number>();
  const vertices: Vec3[] = [];
  const vidx = (pt: Vec3): number => {
    const key = `${pt.x.toFixed(4)},${pt.y.toFixed(4)},${pt.z.toFixed(4)}`;
    let i = index.get(key);
    if (i === undefined) {
      i = vertices.length;
      vertices.push(pt);
      index.set(key, i);
    }
    return i;
  };

  const triLines: string[] = [];
  for (const t of mesh.triangles) {
    triLines.push(`<triangle v1="${vidx(t.a)}" v2="${vidx(t.b)}" v3="${vidx(t.c)}"/>`);
  }
  const vertLines = vertices.map(
    (p) => `<vertex x="${p.x.toFixed(4)}" y="${p.y.toFixed(4)}" z="${p.z.toFixed(4)}"/>`,
  );

  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" ` +
    `xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<metadata name="Title">${xmlEscape(name)}</metadata>` +
    `<resources><object id="1" type="model"><mesh>` +
    `<vertices>${vertLines.join('')}</vertices>` +
    `<triangles>${triLines.join('')}</triangles>` +
    `</mesh></object></resources>` +
    `<build><item objectid="1"/></build></model>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>` +
    `</Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" ` +
    `Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>` +
    `</Relationships>`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rels);
  zip.file('3D/3dmodel.model', model);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
