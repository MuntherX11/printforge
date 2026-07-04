import type { ShapeResult } from './shaping'
import type { Pt } from './path'

export interface Params {
  mode: 'm1' | 'm2' | 'm3'
  placement: 'front' | 'overlay' | 'inline'
  size: number
  baseDepth: number
  accentDepth: number
  overlayThickness: number
  pocketDepth: number
  englishScale: number
  nudgeX: number
  nudgeY: number
  plinth: boolean
  plinthHeight: number
  keel: number
  baseColor: string
  accentColor: string
}

export interface MeshData {
  vertProperties: Float32Array
  triVerts: Uint32Array
}

export interface BuiltPart {
  name: string
  color: string
  mesh: MeshData
}

export interface BuildResult {
  parts: BuiltPart[]
  warnings: string[]
  stats: { widthMm: number; heightMm: number; bridges: number }
}

export interface ShapedSets {
  arabic?: ShapeResult
  english?: ShapeResult
  letter?: ShapeResult
}

const KEEL = 2 // mm shaved flat off the bottom so the piece has real contact area
const BRIDGE_W = 2 // mm width of auto-bridges welding floating dots
const BED = 235 // usable bed dimension (240 minus margin)

let wasm: any = null

export async function initManifold(): Promise<void> {
  if (!wasm) {
    const Module = (await import('manifold-3d')).default
    wasm = await Module()
    wasm.setup()
  }
}

/** Tracks wasm-backed objects so a whole build can be freed at once. */
class Ctx {
  private objs: any[] = []
  t<T>(o: T): T {
    this.objs.push(o)
    return o
  }
  dispose(): void {
    for (const o of this.objs) {
      try {
        o?.delete?.()
      } catch {
        /* already deleted */
      }
    }
    this.objs = []
  }
}

interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function bboxOfPolys(polys: Pt[][]): BBox {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const ring of polys)
    for (const [x, y] of ring) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  return { minX, minY, maxX, maxY }
}

const bboxOf = (cs: any): BBox => bboxOfPolys(cs.toPolygons())

function csFromShaped(ctx: Ctx, shaped: ShapeResult): any {
  return ctx.t(new wasm.CrossSection(shaped.contours, 'NonZero'))
}

function simplified(ctx: Ctx, cs: any): any {
  try {
    return ctx.t(cs.simplify(0.03))
  } catch {
    return cs
  }
}

/** Scale a cross-section so its bbox width/height/largest-dimension equals target mm, centered on x=0. */
function normalize(ctx: Ctx, cs: any, target: number, by: 'width' | 'height' | 'max'): any {
  const bb = bboxOf(cs)
  const w = bb.maxX - bb.minX
  const h = bb.maxY - bb.minY
  const span = by === 'width' ? w : by === 'height' ? h : Math.max(w, h)
  if (span <= 0) throw new Error('Empty outline — check the text input')
  const s = target / span
  const scaled = ctx.t(cs.scale([s, s]))
  const sb = bboxOf(scaled)
  return simplified(ctx, ctx.t(scaled.translate([-(sb.minX + sb.maxX) / 2, 0])))
}

/** Cut away everything below y=0. */
function clipGround(ctx: Ctx, cs: any): any {
  const upper = ctx.t(ctx.t(wasm.CrossSection.square([100000, 100000], true)).translate([0, 50000]))
  return ctx.t(cs.intersect(upper))
}

/** Drop the shape so its lowest point is `keel` below ground, then cut everything below y=0. */
function ground(ctx: Ctx, cs: any, keel = KEEL): any {
  const bb = bboxOf(cs)
  const dropped = ctx.t(cs.translate([0, -bb.minY - keel]))
  return clipGround(ctx, dropped)
}

/** Add a rectangular plinth bar under the shape, sinking the shape 1mm into it. */
function addPlinth(ctx: Ctx, cs: any, plinthHeight: number): any {
  const bb = bboxOf(cs)
  const pw = (bb.maxX - bb.minX) * 1.06
  const plinth = ctx.t(
    ctx.t(wasm.CrossSection.square([pw, plinthHeight], true)).translate([(bb.minX + bb.maxX) / 2, plinthHeight / 2]),
  )
  return ctx.t(ctx.t(cs.translate([0, plinthHeight - 1])).add(plinth))
}

/** Area centroid of a cross-section (holes handled via signed areas). */
function centroidOf(cs: any): [number, number] {
  let a6 = 0
  let cx = 0
  let cy = 0
  for (const ring of cs.toPolygons() as Pt[][]) {
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i]
      const [x1, y1] = ring[(i + 1) % ring.length]
      const cross = x0 * y1 - x1 * y0
      a6 += cross
      cx += (x0 + x1) * cross
      cy += (y0 + y1) * cross
    }
  }
  if (Math.abs(a6) < 1e-9) return [0, 0]
  return [cx / (3 * a6), cy / (3 * a6)]
}

function dist2(a: Pt, b: Pt): number {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  return dx * dx + dy * dy
}

function allPts(polys: Pt[][]): Pt[] {
  const out: Pt[] = []
  for (const ring of polys) for (const p of ring) out.push(p)
  return out
}

function bridgeQuad(a: Pt, b: Pt, w: number): Pt[] {
  let dx = b[0] - a[0]
  let dy = b[1] - a[1]
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) {
    dx = 1
    dy = 0
  } else {
    dx /= len
    dy /= len
  }
  const ext = w * 0.9 // extend past both endpoints to guarantee overlap
  const ax = a[0] - dx * ext
  const ay = a[1] - dy * ext
  const bx = b[0] + dx * ext
  const by = b[1] + dy * ext
  const nx = -dy * (w / 2)
  const ny = dx * (w / 2)
  return [
    [ax + nx, ay + ny],
    [bx + nx, by + ny],
    [bx - nx, by - ny],
    [ax - nx, ay - ny],
  ]
}

/**
 * Make the cross-section a single connected piece: keep the largest component,
 * bridge every other component (Arabic dots, hamzas, i-dots…) to it with a
 * small rectangular strut. Tiny debris is discarded.
 */
function weld(ctx: Ctx, cs: any, bridgeW = BRIDGE_W): { cs: any; bridges: number } {
  let comps: any[]
  try {
    comps = cs.decompose()
  } catch {
    return { cs, bridges: 0 }
  }
  comps.forEach((c) => ctx.t(c))
  if (comps.length <= 1) return { cs, bridges: 0 }
  comps.sort((p, q) => q.area() - p.area())

  let acc = comps[0]
  let accPts = allPts(acc.toPolygons())
  let bridges = 0
  for (let i = 1; i < comps.length; i++) {
    const comp = comps[i]
    if (comp.area() < 0.5) continue // debris
    const pts = allPts(comp.toPolygons())
    let best = Infinity
    let pa: Pt = accPts[0]
    let pb: Pt = pts[0]
    for (const p of pts)
      for (const q of accPts) {
        const d = dist2(p, q)
        if (d < best) {
          best = d
          pa = q
          pb = p
        }
      }
    const strut = ctx.t(new wasm.CrossSection([bridgeQuad(pa, pb, bridgeW)], 'EvenOdd'))
    acc = ctx.t(ctx.t(acc.add(comp)).add(strut))
    accPts = accPts.concat(pts)
    bridges++
  }
  return { cs: acc, bridges }
}

/** Width of ground contact and number of contact patches, measured in a thin slice above y=0. */
function contact(ctx: Ctx, cs: any): { span: number; patches: number } {
  const strip = ctx.t(ctx.t(wasm.CrossSection.square([100000, 0.8], true)).translate([0, 0.4]))
  const slice = ctx.t(cs.intersect(strip))
  if (slice.area() < 1e-6) return { span: 0, patches: 0 }
  let patches = 1
  try {
    const segs = slice.decompose()
    segs.forEach((s: any) => ctx.t(s))
    patches = segs.length
  } catch {
    /* keep 1 */
  }
  const bb = bboxOf(slice)
  return { span: bb.maxX - bb.minX, patches }
}

function extrudeAt(ctx: Ctx, cs: any, depth: number, z0: number): any {
  const m = ctx.t(wasm.Manifold.extrude(cs, depth))
  return z0 === 0 ? m : ctx.t(m.translate([0, 0, z0]))
}

function meshOf(m: any): MeshData {
  const g = m.getMesh()
  return {
    vertProperties: new Float32Array(g.vertProperties),
    triVerts: new Uint32Array(g.triVerts),
  }
}

function checkFit(bb: BBox, label: string, warnings: string[]): void {
  const w = bb.maxX - bb.minX
  const h = bb.maxY - bb.minY
  if (w > BED || h > BED)
    warnings.push(`${label} is ${w.toFixed(0)}×${h.toFixed(0)} mm — exceeds the ${BED} mm printable area. Reduce the size.`)
}

function stabilityCheck(heightMm: number, footprintDepth: number, span: number, widthMm: number, warnings: string[]): void {
  if (heightMm / footprintDepth > 8)
    warnings.push(
      `Tippy: ${heightMm.toFixed(0)} mm tall on only ${footprintDepth.toFixed(0)} mm of depth. Increase depth or add a plinth.`,
    )
  if (span < widthMm * 0.3)
    warnings.push(
      `Narrow footing: ground contact spans only ${span.toFixed(0)} mm (${((span / widthMm) * 100).toFixed(0)}% of width). Consider a plinth or nudging the composition.`,
    )
}

export function buildDesign(shaped: ShapedSets, p: Params): BuildResult {
  if (!wasm) throw new Error('Geometry engine not initialised')
  const ctx = new Ctx()
  try {
    return buildInner(ctx, shaped, p)
  } finally {
    ctx.dispose()
  }
}

function buildInner(ctx: Ctx, shaped: ShapedSets, p: Params): BuildResult {
  const warnings: string[] = []
  const parts: BuiltPart[] = []
  let bridges = 0

  const prepare = (sr: ShapeResult, target: number, by: 'width' | 'height' | 'max'): any => {
    const cs = normalize(ctx, csFromShaped(ctx, sr), target, by)
    return ground(ctx, cs, p.keel)
  }

  let overallBB: BBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 }

  if (p.mode === 'm2') {
    if (!shaped.arabic || !shaped.english) throw new Error('Both names are required')

    if (p.placement === 'overlay') {
      // Arabic stands on its own; English is a thin plate glued onto its face
      const arW = weld(ctx, prepare(shaped.arabic, p.size, 'max'))
      bridges += arW.bridges
      let ar = arW.cs
      if (p.plinth) ar = addPlinth(ctx, ar, p.plinthHeight)
      const arBB = bboxOf(ar)
      const enRaw = normalize(ctx, csFromShaped(ctx, shaped.english), p.size * p.englishScale, 'width')
      const enBB = bboxOf(enRaw)
      const cx = (arBB.minX + arBB.maxX) / 2 + p.nudgeX
      const cy = (arBB.minY + arBB.maxY) / 2 + p.nudgeY
      const enMoved = ctx.t(enRaw.translate([cx - (enBB.minX + enBB.maxX) / 2, cy - (enBB.minY + enBB.maxY) / 2]))
      const enWelded = weld(ctx, enMoved)
      bridges += enWelded.bridges
      const en = enWelded.cs

      const pocket = ctx.t(en.intersect(ar))
      if (pocket.area() < en.area() * 0.45)
        warnings.push('Most of the English name hangs off the Arabic face — glue area is small. Nudge it or scale it down.')

      let base = extrudeAt(ctx, ar, p.baseDepth, 0)
      if (pocket.area() > 1e-6) {
        const pocketSolid = extrudeAt(ctx, pocket, p.pocketDepth + 0.01, p.baseDepth - p.pocketDepth)
        base = ctx.t(base.subtract(pocketSolid))
      }
      const plate = extrudeAt(ctx, en, p.overlayThickness + p.pocketDepth, p.baseDepth - p.pocketDepth)
      parts.push({ name: 'arabic-base', color: p.baseColor, mesh: meshOf(base) })
      parts.push({ name: 'english-overlay', color: p.accentColor, mesh: meshOf(plate) })

      const c = contact(ctx, ar)
      const arBB2 = bboxOf(ar)
      overallBB = arBB2
      stabilityCheck(arBB2.maxY, p.baseDepth, c.span, arBB2.maxX - arBB2.minX, warnings)
      checkFit(arBB2, 'Arabic base', warnings)
    } else {
      // Arabic stands grounded; English stands in front, centered under the
      // Arabic's lower mass so their silhouettes bond (Sulaiman/Tamim style)
      const arW = weld(ctx, prepare(shaped.arabic, p.size, 'max'))
      bridges += arW.bridges
      let ar = arW.cs
      if (p.nudgeY !== 0) {
        ar = clipGround(ctx, ctx.t(ar.translate([0, p.nudgeY])))
      }

      const enPrep = prepare(shaped.english, p.size * p.englishScale, 'width')
      const enWelded = weld(ctx, enPrep)
      bridges += enWelded.bridges
      const enBB0 = bboxOf(enWelded.cs)
      const bandH = Math.max(20, enBB0.maxY - enBB0.minY)
      const band = ctx.t(ctx.t(wasm.CrossSection.square([100000, bandH], true)).translate([0, bandH / 2]))
      const lowSlice = ctx.t(ar.intersect(band))
      const cx = lowSlice.area() > 1 ? centroidOf(lowSlice)[0] : 0
      const en = ctx.t(enWelded.cs.translate([cx + p.nudgeX, 0]))

      const overlap = ctx.t(ar.intersect(en))
      if (overlap.area() < 40)
        warnings.push(
          `Arabic and English overlap by only ${overlap.area().toFixed(0)} mm² — the glue joint will be weak. Nudge or enlarge the English name.`,
        )
      const arSeatedBB = bboxOf(ar)
      if (p.placement === 'front' && arSeatedBB.minY > 1)
        warnings.push('The Arabic piece does not reach the ground — it will be carried entirely by the glue joint to the English name.')

      if (p.placement === 'inline') {
        const merged = weld(ctx, ctx.t(ar.add(en)))
        bridges += merged.bridges
        let mergedCS = merged.cs
        if (p.plinth) mergedCS = addPlinth(ctx, mergedCS, p.plinthHeight)
        const solid = extrudeAt(ctx, mergedCS, p.baseDepth, 0)
        parts.push({ name: 'sculpture', color: p.baseColor, mesh: meshOf(solid) })
        const bb = bboxOf(mergedCS)
        overallBB = bb
        const c = contact(ctx, mergedCS)
        stabilityCheck(bb.maxY, p.baseDepth, c.span, bb.maxX - bb.minX, warnings)
        checkFit(bb, 'Sculpture', warnings)
      } else {
        const arSolid = extrudeAt(ctx, ar, p.baseDepth, 0)
        const enSolid = extrudeAt(ctx, en, p.accentDepth, p.baseDepth)
        parts.push({ name: 'arabic', color: p.baseColor, mesh: meshOf(arSolid) })
        parts.push({ name: 'english', color: p.accentColor, mesh: meshOf(enSolid) })
        const bbA = bboxOf(ar)
        const bbE = bboxOf(en)
        overallBB = {
          minX: Math.min(bbA.minX, bbE.minX),
          minY: 0,
          maxX: Math.max(bbA.maxX, bbE.maxX),
          maxY: Math.max(bbA.maxY, bbE.maxY),
        }
        const cA = contact(ctx, ar)
        const cE = contact(ctx, en)
        stabilityCheck(
          overallBB.maxY,
          p.baseDepth + p.accentDepth,
          Math.max(cA.span, cE.span),
          overallBB.maxX - overallBB.minX,
          warnings,
        )
        checkFit(bbA, 'Arabic part', warnings)
        checkFit(bbE, 'English part', warnings)
      }
    }
  } else if (p.mode === 'm1') {
    if (!shaped.letter || !shaped.arabic) throw new Error('Letter and Arabic name are required')
    const letterW = weld(ctx, prepare(shaped.letter, p.size, 'height'))
    bridges += letterW.bridges
    const letter = letterW.cs
    const lBB = bboxOf(letter)

    const arRaw = normalize(ctx, csFromShaped(ctx, shaped.arabic), (lBB.maxX - lBB.minX) * 1.2, 'max')
    const aBB = bboxOf(arRaw)
    const cx = (lBB.minX + lBB.maxX) / 2 + p.nudgeX
    const cy = (lBB.minY + lBB.maxY) / 2 + p.nudgeY
    const arMoved = ctx.t(arRaw.translate([cx - (aBB.minX + aBB.maxX) / 2, cy - (aBB.minY + aBB.maxY) / 2]))
    const arWelded = weld(ctx, arMoved)
    bridges += arWelded.bridges
    const ar = arWelded.cs

    const pocket = ctx.t(ar.intersect(letter))
    if (pocket.area() < ar.area() * 0.35)
      warnings.push('The Arabic name barely lands on the letter — glue area is small. Nudge it toward the letter.')

    let base = extrudeAt(ctx, letter, p.baseDepth, 0)
    if (pocket.area() > 1e-6) {
      const pocketSolid = extrudeAt(ctx, pocket, p.pocketDepth + 0.01, p.baseDepth - p.pocketDepth)
      base = ctx.t(base.subtract(pocketSolid))
    }
    const plate = extrudeAt(ctx, ar, p.overlayThickness + p.pocketDepth, p.baseDepth - p.pocketDepth)
    parts.push({ name: 'letter', color: p.baseColor, mesh: meshOf(base) })
    parts.push({ name: 'arabic-overlay', color: p.accentColor, mesh: meshOf(plate) })

    const arBB2 = bboxOf(ar)
    overallBB = {
      minX: Math.min(lBB.minX, arBB2.minX),
      minY: 0,
      maxX: Math.max(lBB.maxX, arBB2.maxX),
      maxY: Math.max(lBB.maxY, arBB2.maxY),
    }
    const c = contact(ctx, letter)
    stabilityCheck(lBB.maxY, p.baseDepth, c.span, lBB.maxX - lBB.minX, warnings)
    checkFit(lBB, 'Letter', warnings)
    checkFit(arBB2, 'Arabic overlay', warnings)
  } else {
    // m3: Arabic only
    if (!shaped.arabic) throw new Error('Arabic name is required')
    const arW = weld(ctx, prepare(shaped.arabic, p.size, 'max'))
    bridges += arW.bridges
    let cs = arW.cs
    if (p.plinth) cs = addPlinth(ctx, cs, p.plinthHeight)

    const solid = extrudeAt(ctx, cs, p.baseDepth, 0)
    parts.push({ name: 'name', color: p.baseColor, mesh: meshOf(solid) })
    const bb = bboxOf(cs)
    overallBB = bb
    const c = contact(ctx, cs)
    stabilityCheck(bb.maxY, p.baseDepth, c.span, bb.maxX - bb.minX, warnings)
    checkFit(bb, 'Name', warnings)
  }

  return {
    parts,
    warnings,
    stats: {
      widthMm: overallBB.maxX - overallBB.minX,
      heightMm: overallBB.maxY - overallBB.minY,
      bridges,
    },
  }
}
