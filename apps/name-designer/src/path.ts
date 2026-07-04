export type Pt = [number, number]
export type Contour = Pt[]

const QUAD_SEGS = 10
const CUBIC_SEGS = 16

/**
 * Parse an SVG path string (as emitted by harfbuzz glyphToPath) into flattened
 * polygon contours. Curves are subdivided into line segments.
 */
export function parsePath(d: string): Contour[] {
  const contours: Contour[] = []
  let cur: Contour | null = null
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0

  const push = (px: number, py: number) => {
    if (cur) cur.push([px, py])
    x = px
    y = py
  }

  const re = /([MLQCZHVmlqczhv])([^MLQCZHVmlqczhv]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(d))) {
    const cmd = m[1]
    const raw = m[2].trim()
    const n = raw.length ? raw.split(/[\s,]+/).map(Number) : []
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()

    if (C === 'M') {
      if (cur && cur.length >= 3) contours.push(cur)
      cur = []
      for (let i = 0; i + 1 < n.length; i += 2) {
        const px = rel ? x + n[i] : n[i]
        const py = rel ? y + n[i + 1] : n[i + 1]
        if (i === 0) {
          cur.push([px, py])
          x = px
          y = py
          startX = px
          startY = py
        } else {
          push(px, py)
        }
      }
    } else if (C === 'L') {
      for (let i = 0; i + 1 < n.length; i += 2) {
        push(rel ? x + n[i] : n[i], rel ? y + n[i + 1] : n[i + 1])
      }
    } else if (C === 'H') {
      for (let i = 0; i < n.length; i++) push(rel ? x + n[i] : n[i], y)
    } else if (C === 'V') {
      for (let i = 0; i < n.length; i++) push(x, rel ? y + n[i] : n[i])
    } else if (C === 'Q') {
      for (let i = 0; i + 3 < n.length; i += 4) {
        const cx = rel ? x + n[i] : n[i]
        const cy = rel ? y + n[i + 1] : n[i + 1]
        const ex = rel ? x + n[i + 2] : n[i + 2]
        const ey = rel ? y + n[i + 3] : n[i + 3]
        const x0 = x
        const y0 = y
        for (let s = 1; s <= QUAD_SEGS; s++) {
          const t = s / QUAD_SEGS
          const u = 1 - t
          push(u * u * x0 + 2 * u * t * cx + t * t * ex, u * u * y0 + 2 * u * t * cy + t * t * ey)
        }
      }
    } else if (C === 'C') {
      for (let i = 0; i + 5 < n.length; i += 6) {
        const c1x = rel ? x + n[i] : n[i]
        const c1y = rel ? y + n[i + 1] : n[i + 1]
        const c2x = rel ? x + n[i + 2] : n[i + 2]
        const c2y = rel ? y + n[i + 3] : n[i + 3]
        const ex = rel ? x + n[i + 4] : n[i + 4]
        const ey = rel ? y + n[i + 5] : n[i + 5]
        const x0 = x
        const y0 = y
        for (let s = 1; s <= CUBIC_SEGS; s++) {
          const t = s / CUBIC_SEGS
          const u = 1 - t
          push(
            u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex,
            u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey,
          )
        }
      }
    } else if (C === 'Z') {
      if (cur && cur.length >= 3) contours.push(cur)
      cur = null
      x = startX
      y = startY
    }
  }
  if (cur && cur.length >= 3) contours.push(cur)

  // Drop consecutive duplicate points
  return contours
    .map((c) => c.filter((p, i) => i === 0 || Math.abs(p[0] - c[i - 1][0]) > 1e-7 || Math.abs(p[1] - c[i - 1][1]) > 1e-7))
    .filter((c) => c.length >= 3)
}
