import { Blob as HBBlob, Face as HBFace, Font as HBFont, Buffer as HBBuffer, shape } from 'harfbuzzjs'
import { parsePath, type Contour } from './path'

export interface ShapeResult {
  /** All outline contours of the shaped word, in font units, pen at origin. */
  contours: Contour[]
  upem: number
}

interface LoadedFont {
  font: HBFont
  upem: number
  glyphCache: Map<number, Contour[]>
}

const loaded = new Map<string, Promise<LoadedFont>>()

export function loadFont(key: string, url: string): Promise<LoadedFont> {
  let p = loaded.get(key)
  if (!p) {
    p = (async () => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Font download failed: ${url}`)
      const data = await res.arrayBuffer()
      const blob = new HBBlob(data)
      const face = new HBFace(blob, 0)
      const font = new HBFont(face)
      const upem = face.upem
      // Scale so glyph paths and advances come out in font units
      font.setScale(upem, upem)
      return { font, upem, glyphCache: new Map() }
    })()
    loaded.set(key, p)
  }
  return p
}

/**
 * Shape a string with proper contextual joining (Arabic) / kerning and return
 * every outline contour positioned along the baseline, in font units.
 */
export async function shapeText(fontKey: string, url: string, text: string): Promise<ShapeResult> {
  const f = await loadFont(fontKey, url)
  const buf = new HBBuffer()
  buf.addText(text)
  buf.guessSegmentProperties()
  shape(f.font, buf)
  const glyphs = buf.getGlyphInfosAndPositions()

  const contours: Contour[] = []
  let penX = 0
  let penY = 0
  for (const g of glyphs) {
    const glyphId = g.codepoint // after shaping this is the glyph index
    let outlines = f.glyphCache.get(glyphId)
    if (!outlines) {
      outlines = parsePath(f.font.glyphToPath(glyphId))
      f.glyphCache.set(glyphId, outlines)
    }
    const ox = penX + (g.xOffset ?? 0)
    const oy = penY + (g.yOffset ?? 0)
    for (const c of outlines) {
      contours.push(c.map(([px, py]) => [px + ox, py + oy] as [number, number]))
    }
    penX += g.xAdvance ?? 0
    penY += g.yAdvance ?? 0
  }
  ;(buf as any).destroy?.()
  return { contours, upem: f.upem }
}
