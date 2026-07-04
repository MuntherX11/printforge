import { zipSync, strToU8 } from 'fflate'
import type { BuiltPart, MeshData } from './design'

interface BBox3 {
  min: [number, number, number]
  max: [number, number, number]
}

function meshBBox(mesh: MeshData): BBox3 {
  const v = mesh.vertProperties
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < v.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const c = v[i + a]
      if (c < min[a]) min[a] = c
      if (c > max[a]) max[a] = c
    }
  }
  return { min, max }
}

function shifted(mesh: MeshData, dx: number, dy: number, dz: number): Float32Array {
  const v = new Float32Array(mesh.vertProperties)
  for (let i = 0; i < v.length; i += 3) {
    v[i] += dx
    v[i + 1] += dy
    v[i + 2] += dz
  }
  return v
}

/** Binary STL. Parts are exported lying flat (extrusion axis = Z = print vertical). */
function stlBytes(verts: Float32Array, tris: Uint32Array): Uint8Array {
  const n = tris.length / 3
  const buf = new ArrayBuffer(84 + n * 50)
  const dv = new DataView(buf)
  dv.setUint32(80, n, true)
  let off = 84
  for (let t = 0; t < n; t++) {
    const i0 = tris[t * 3] * 3
    const i1 = tris[t * 3 + 1] * 3
    const i2 = tris[t * 3 + 2] * 3
    const ax = verts[i1] - verts[i0]
    const ay = verts[i1 + 1] - verts[i0 + 1]
    const az = verts[i1 + 2] - verts[i0 + 2]
    const bx = verts[i2] - verts[i0]
    const by = verts[i2 + 1] - verts[i0 + 1]
    const bz = verts[i2 + 2] - verts[i0 + 2]
    let nx = ay * bz - az * by
    let ny = az * bx - ax * bz
    let nz = ax * by - ay * bx
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len
    ny /= len
    nz /= len
    dv.setFloat32(off, nx, true)
    dv.setFloat32(off + 4, ny, true)
    dv.setFloat32(off + 8, nz, true)
    for (const idx of [i0, i1, i2]) {
      off += 12
      dv.setFloat32(off, verts[idx], true)
      dv.setFloat32(off + 4, verts[idx + 1], true)
      dv.setFloat32(off + 8, verts[idx + 2], true)
    }
    off += 14
  }
  return new Uint8Array(buf)
}

function download(name: string, data: Uint8Array, mime: string): void {
  const blob = new Blob([data as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export function sanitizeName(s: string): string {
  const clean = s.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
  return clean || 'design'
}

export function exportSTLZip(parts: BuiltPart[], baseName: string): void {
  const files: Record<string, Uint8Array> = {}
  for (const part of parts) {
    const bb = meshBBox(part.mesh)
    const verts = shifted(part.mesh, -bb.min[0], -bb.min[1], -bb.min[2])
    files[`${baseName}-${part.name}.stl`] = stlBytes(verts, part.mesh.triVerts)
  }
  download(`${baseName}-stl.zip`, zipSync(files, { level: 4 }), 'application/zip')
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n'

const CONTENT_TYPES =
  XML_HEADER +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
  '</Types>'

const RELS =
  XML_HEADER +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
  '</Relationships>'

/**
 * Multi-part 3MF with per-part display colors, parts laid out flat side by
 * side on the plate (Z = extrusion depth = print vertical).
 */
export function export3MF(parts: BuiltPart[], baseName: string): void {
  const GAP = 10
  let cursorX = 0
  const materials: string[] = []
  const objects: string[] = []
  const items: string[] = []

  parts.forEach((part, pi) => {
    const bb = meshBBox(part.mesh)
    const verts = shifted(part.mesh, cursorX - bb.min[0], -bb.min[1], -bb.min[2])
    cursorX += bb.max[0] - bb.min[0] + GAP
    materials.push(`<base name="${part.name}" displaycolor="${part.color}" />`)

    let vxml = ''
    for (let i = 0; i < verts.length; i += 3) {
      vxml += `<vertex x="${verts[i].toFixed(3)}" y="${verts[i + 1].toFixed(3)}" z="${verts[i + 2].toFixed(3)}"/>`
    }
    let txml = ''
    const tv = part.mesh.triVerts
    for (let i = 0; i < tv.length; i += 3) {
      txml += `<triangle v1="${tv[i]}" v2="${tv[i + 1]}" v3="${tv[i + 2]}"/>`
    }
    const oid = pi + 2
    objects.push(
      `<object id="${oid}" name="${part.name}" type="model" pid="1" pindex="${pi}"><mesh><vertices>${vxml}</vertices><triangles>${txml}</triangles></mesh></object>`,
    )
    items.push(`<item objectid="${oid}"/>`)
  })

  const model =
    XML_HEADER +
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">' +
    `<resources><basematerials id="1">${materials.join('')}</basematerials>${objects.join('')}</resources>` +
    `<build>${items.join('')}</build></model>`

  const zip = zipSync(
    {
      '[Content_Types].xml': strToU8(CONTENT_TYPES),
      '_rels/.rels': strToU8(RELS),
      '3D/3dmodel.model': strToU8(model),
    },
    { level: 4 },
  )
  download(`${baseName}.3mf`, zip, 'model/3mf')
}
