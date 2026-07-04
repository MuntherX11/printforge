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
  arNudgeX: number
  arNudgeY: number
  enNudgeX: number
  enNudgeY: number
  plinth: boolean
  plinthHeight: number
  keel: number
  joinArea: number
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
  stats: { widthMm: number; heightMm: number; bridges: number; joins: number }
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

function nearestBetween(aPts: Pt[], bPts: Pt[]): { pa: Pt; pb: Pt; d: number } {
  let best = Infinity
  let pa: Pt = aPts[0]
  let pb: Pt = bPts[0]
  for (const p of bPts)
    for (const q of aPts) {
      const d = dist2(p, q)
      if (d < best) {
        best = d
        pa = q
        pb = p
      }
    }
  return { pa, pb, d: Math.sqrt(best) }
}

/**
 * Slide `moving` toward `fixed` along the nearest-gap vector until their
 * silhouettes overlap by at least `joinArea` mm².
 */
function slideToJoin(
  ctx: Ctx,
  fixed: any,
  moving: any,
  joinArea: number,
  maxExtra: number,
): { cs: any; shift: Pt; ok: boolean } {
  if (ctx.t(moving.intersect(fixed)).area() >= joinArea * 0.6) return { cs: moving, shift: [0, 0], ok: true }
  const { pa, pb, d } = nearestBetween(allPts(fixed.toPolygons()), allPts(moving.toPolygons()))
  let dx = pa[0] - pb[0]
  let dy = pa[1] - pb[1]
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) {
    dx = -1
    dy = 0
  } else {
    dx /= len
    dy /= len
  }
  const step = 0.5
  for (let extra = step; extra <= maxExtra; extra += step) {
    const t = d + extra
    const cand = ctx.t(moving.translate([dx * t, dy * t]))
    if (ctx.t(cand.intersect(fixed)).area() >= joinArea) return { cs: cand, shift: [dx * t, dy * t], ok: true }
  }
  return { cs: moving, shift: [0, 0], ok: false }
}

/** Last-resort strut welding for components whose position must not change. */
function strutFix(ctx: Ctx, cs: any, bridgeW = BRIDGE_W): { cs: any; bridges: number } {
  let comps: any[]
  try {
    comps = cs.decompose()
  } catch {
    return { cs, bridges: 0 }
  }
  comps.forEach((c) => ctx.t(c))
  if (comps.length <= 1) return { cs, bridges: 0 }
  comps.sort((a, b) => b.area() - a.area())
  let acc = comps[0]
  let accPts = allPts(acc.toPolygons())
  let bridges = 0
  for (let i = 1; i < comps.length; i++) {
    const comp = comps[i]
    if (comp.area() < 0.5) continue // debris
    const pts = allPts(comp.toPolygons())
    const { pa, pb } = nearestBetween(accPts, pts)
    const strut = ctx.t(new wasm.CrossSection([bridgeQuad(pa, pb, bridgeW)], 'EvenOdd'))
    acc = ctx.t(ctx.t(acc.add(comp)).add(strut))
    accPts = accPts.concat(pts)
    bridges++
  }
  return { cs: acc, bridges }
}

/**
 * Join a word into one connected piece by pulling separated letter groups
 * closer and nestling floating dots into the strokes — no visible connector
 * struts. A strut is added only when sliding cannot reach.
 */
function weld(ctx: Ctx, cs: any, joinArea = 12): { cs: any; joins: number; bridges: number } {
  let comps: any[]
  try {
    comps = cs.decompose()
  } catch {
    return { cs, joins: 0, bridges: 0 }
  }
  comps.forEach((c) => ctx.t(c))
  comps = comps.filter((c) => c.area() >= 0.5)
  if (comps.length <= 1) return { cs: comps[0] ?? cs, joins: 0, bridges: 0 }

  const maxA = Math.max(...comps.map((c) => c.area()))
  const chunks = comps.filter((c) => c.area() >= maxA * 0.1)
  const marks = comps.filter((c) => c.area() < maxA * 0.1)
  chunks.sort((a, b) => bboxOf(a).minX - bboxOf(b).minX)

  // Remember which letter group each mark (dot/hamza) belongs to, pre-shift
  const chunkPts = chunks.map((c) => allPts(c.toPolygons()))
  const markBase = marks.map((m) => {
    const mPts = allPts(m.toPolygons())
    let best = Infinity
    let bi = 0
    for (let i = 0; i < chunks.length; i++) {
      const { d } = nearestBetween(chunkPts[i], mPts)
      if (d < best) {
        best = d
        bi = i
      }
    }
    return bi
  })

  let joins = 0
  let bridges = 0
  const shifts: Pt[] = [[0, 0]]
  let acc = chunks[0]
  for (let i = 1; i < chunks.length; i++) {
    const r = slideToJoin(ctx, acc, chunks[i], joinArea, 18)
    shifts.push(r.shift)
    if (r.ok) {
      if (r.shift[0] !== 0 || r.shift[1] !== 0) joins++
    } else {
      const { pa, pb } = nearestBetween(allPts(acc.toPolygons()), allPts(r.cs.toPolygons()))
      acc = ctx.t(acc.add(ctx.t(new wasm.CrossSection([bridgeQuad(pa, pb, BRIDGE_W)], 'EvenOdd'))))
      bridges++
    }
    acc = ctx.t(acc.add(r.cs))
  }
  for (let j = 0; j < marks.length; j++) {
    const s = shifts[markBase[j]] ?? [0, 0]
    const m0 = ctx.t(marks[j].translate(s))
    const r = slideToJoin(ctx, acc, m0, Math.min(5, joinArea), 24)
    if (r.ok) {
      if (r.shift[0] !== 0 || r.shift[1] !== 0) joins++
    } else {
      const { pa, pb } = nearestBetween(allPts(acc.toPolygons()), allPts(r.cs.toPolygons()))
      acc = ctx.t(acc.add(ctx.t(new wasm.CrossSection([bridgeQuad(pa, pb, BRIDGE_W)], 'EvenOdd'))))
      bridges++
    }
    acc = ctx.t(acc.add(r.cs))
  }
  return { cs: acc, joins, bridges }
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
  let joins = 0

  /** normalize → pull letter groups/dots together → re-fit to size. */
  const prepareFloating = (sr: ShapeResult, target: number, by: 'width' | 'height' | 'max'): any => {
    const n1 = normalize(ctx, csFromShaped(ctx, sr), target, by)
    const j = weld(ctx, n1, p.joinArea)
    joins += j.joins
    bridges += j.bridges
    return normalize(ctx, j.cs, target, by)
  }

  /** prepareFloating + keel-grounding (+ strut fixup if the keel cut orphaned a tail). */
  const prepareStanding = (sr: ShapeResult, target: number, by: 'width' | 'height' | 'max'): any => {
    const g = ground(ctx, prepareFloating(sr, target, by), p.keel)
    const fix = strutFix(ctx, g)
    bridges += fix.bridges
    return fix.cs
  }

  let overallBB: BBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 }

  if (p.mode === 'm2') {
    if (!shaped.arabic || !shaped.english) throw new Error('Both names are required')

    if (p.placement === 'overlay') {
      // Arabic stands on its own; English is a thin plate glued onto its face
      let ar = prepareStanding(shaped.arabic, p.size, 'max')
      if (p.plinth) ar = addPlinth(ctx, ar, p.plinthHeight)
      const arBB = bboxOf(ar)
      const enRaw = prepareFloating(shaped.english, p.size * p.englishScale, 'width')
      const enBB = bboxOf(enRaw)
      const cx = (arBB.minX + arBB.maxX) / 2 + p.enNudgeX
      const cy = (arBB.minY + arBB.maxY) / 2 + p.enNudgeY
      const en = ctx.t(enRaw.translate([cx - (enBB.minX + enBB.maxX) / 2, cy - (enBB.minY + enBB.maxY) / 2]))

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
      let ar = prepareStanding(shaped.arabic, p.size, 'max')
      if (p.arNudgeX !== 0 || p.arNudgeY !== 0) {
        ar = clipGround(ctx, ctx.t(ar.translate([p.arNudgeX, p.arNudgeY])))
      }

      const en0 = prepareStanding(shaped.english, p.size * p.englishScale, 'width')
      const enBB0 = bboxOf(en0)
      const bandH = Math.max(20, enBB0.maxY - enBB0.minY)
      const band = ctx.t(ctx.t(wasm.CrossSection.square([100000, bandH], true)).translate([0, bandH / 2]))
      const lowSlice = ctx.t(ar.intersect(band))
      const cx = lowSlice.area() > 1 ? centroidOf(lowSlice)[0] : 0
      let en = ctx.t(en0.translate([cx + p.enNudgeX, p.enNudgeY]))
      if (p.enNudgeY < 0) en = clipGround(ctx, en)
      if (p.enNudgeY > 1)
        warnings.push('The English name is lifted off the ground — it will hang on the glue joint instead of standing.')

      const overlap = ctx.t(ar.intersect(en))
      if (overlap.area() < 40)
        warnings.push(
          `Arabic and English overlap by only ${overlap.area().toFixed(0)} mm² — the glue joint will be weak. Nudge or enlarge the English name.`,
        )
      const arSeatedBB = bboxOf(ar)
      if (p.placement === 'front' && arSeatedBB.minY > 1)
        warnings.push('The Arabic piece does not reach the ground — it will be carried entirely by the glue joint to the English name.')

      if (p.placement === 'inline') {
        const merged = strutFix(ctx, ctx.t(ar.add(en)))
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
    const letter = prepareStanding(shaped.letter, p.size, 'height')
    const lBB = bboxOf(letter)

    const arRaw = prepareFloating(shaped.arabic, (lBB.maxX - lBB.minX) * 1.2, 'max')
    const aBB = bboxOf(arRaw)
    const cx = (lBB.minX + lBB.maxX) / 2 + p.arNudgeX
    const cy = (lBB.minY + lBB.maxY) / 2 + p.arNudgeY
    const ar = ctx.t(arRaw.translate([cx - (aBB.minX + aBB.maxX) / 2, cy - (aBB.minY + aBB.maxY) / 2]))

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
    let cs = prepareStanding(shaped.arabic, p.size, 'max')
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
      joins,
    },
  }
}
