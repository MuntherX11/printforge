/**
 * Minimal analytic mesh core for server-side artifact generation.
 *
 * Everything here is deterministic and bounded: triangle counts are a function
 * of a capped `segments` value, and every shape is closed (watertight) — each
 * edge is shared by exactly two triangles. This is what makes server-generated
 * artifacts safe to hand to an employee's slicer (spec §1/§5): the geometry is
 * well-formed because *our* code produces it.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Triangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
}

export class Mesh {
  readonly triangles: Triangle[] = [];

  tri(a: Vec3, b: Vec3, c: Vec3): void {
    this.triangles.push({ a, b, c });
  }

  /** A quad a-b-c-d (CCW) split into two triangles. */
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  get triangleCount(): number {
    return this.triangles.length;
  }
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/**
 * Intersection of a ray from the origin at angle `theta` with an axis-aligned
 * rectangle centred at the origin (half-extents hx, hy). Used to sample the
 * outer rectangle boundary at the same angular positions as the inner hole so
 * the band between them triangulates into clean, watertight quads.
 */
function rayToRect(theta: number, hx: number, hy: number): { x: number; y: number } {
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  // Distance to vertical edges (|x| = hx) and horizontal edges (|y| = hy)
  const tx = Math.abs(cos) < 1e-9 ? Infinity : hx / Math.abs(cos);
  const ty = Math.abs(sin) < 1e-9 ? Infinity : hy / Math.abs(sin);
  const t = Math.min(tx, ty);
  return { x: cos * t, y: sin * t };
}

/**
 * A rectangular slab (width × depth × thickness) sitting on z=0, optionally
 * with a centred cylindrical through-hole. Watertight in both cases.
 *
 * With a hole, the top and bottom faces are the annular band between the hole
 * ring (n points on the circle) and the rectangle ring (n points where each
 * hole-angle ray meets the rectangle) — n quads each. Plus outer walls, inner
 * walls, giving ~8n triangles. Bounded by n.
 */
export function slab(opts: {
  width: number;
  depth: number;
  thickness: number;
  holeDiameter?: number;
  segments?: number;
}): Mesh {
  const { width, depth, thickness } = opts;
  const hx = width / 2;
  const hy = depth / 2;
  const mesh = new Mesh();

  const hole = opts.holeDiameter && opts.holeDiameter > 0 ? opts.holeDiameter / 2 : 0;
  // Hole must fit strictly inside the plate
  const maxHole = Math.min(hx, hy) * 0.9;
  const r = hole > 0 ? Math.min(hole, maxHole) : 0;

  if (r <= 0) {
    // ---- Plain box: 12 triangles, trivially watertight ----
    const z0 = 0;
    const z1 = thickness;
    const c000 = v(-hx, -hy, z0), c100 = v(hx, -hy, z0), c110 = v(hx, hy, z0), c010 = v(-hx, hy, z0);
    const c001 = v(-hx, -hy, z1), c101 = v(hx, -hy, z1), c111 = v(hx, hy, z1), c011 = v(-hx, hy, z1);
    // bottom (facing -z, wind CW so normal points down)
    mesh.quad(c000, c010, c110, c100);
    // top (+z)
    mesh.quad(c001, c101, c111, c011);
    // sides
    mesh.quad(c000, c100, c101, c001); // -y
    mesh.quad(c100, c110, c111, c101); // +x
    mesh.quad(c110, c010, c011, c111); // +y
    mesh.quad(c010, c000, c001, c011); // -x
    return mesh;
  }

  // ---- Slab with a central hole ----
  const n = Math.max(12, Math.min(256, Math.floor(opts.segments ?? 48)));
  const z0 = 0;
  const z1 = thickness;

  const circleBot: Vec3[] = [];
  const circleTop: Vec3[] = [];
  const rectBot: Vec3[] = [];
  const rectTop: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const theta = (i / n) * Math.PI * 2;
    const cx = Math.cos(theta) * r;
    const cy = Math.sin(theta) * r;
    const rp = rayToRect(theta, hx, hy);
    circleBot.push(v(cx, cy, z0));
    circleTop.push(v(cx, cy, z1));
    rectBot.push(v(rp.x, rp.y, z0));
    rectTop.push(v(rp.x, rp.y, z1));
  }

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // Bottom face (normal -z): band between rect and circle, wound so normal points down
    mesh.quad(rectBot[i], rectBot[j], circleBot[j], circleBot[i]);
    // Top face (normal +z)
    mesh.quad(circleTop[i], circleTop[j], rectTop[j], rectTop[i]);
    // Outer wall (rectangle), normal outward
    mesh.quad(rectBot[i], rectTop[i], rectTop[j], rectBot[j]);
    // Inner wall (hole), normal points inward toward the axis
    mesh.quad(circleBot[j], circleTop[j], circleTop[i], circleBot[i]);
  }

  return mesh;
}
