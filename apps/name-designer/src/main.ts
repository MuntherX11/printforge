import { ARABIC_FONTS, ENGLISH_FONTS, LETTER_FONTS, findFont, fontUrl, type FontDef } from './fonts'
import { shapeText, type ShapeResult } from './shaping'
import { initManifold, buildDesign, type Params, type BuildResult, type ShapedSets } from './design'
import { exportSTLZip, export3MF, sanitizeName } from './export'
import { Preview } from './preview'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const val = (id: string) => ($(id) as HTMLInputElement | HTMLSelectElement).value
const num = (id: string) => Number(val(id))

function fillFontSelect(id: string, fonts: FontDef[]): void {
  const sel = $(id) as HTMLSelectElement
  sel.innerHTML = ''
  for (const f of fonts) {
    const o = document.createElement('option')
    o.value = f.key
    o.textContent = f.label
    sel.appendChild(o)
  }
}

function readParams(): Params {
  return {
    mode: val('mode') as Params['mode'],
    placement: val('placement') as Params['placement'],
    size: num('size'),
    baseDepth: num('baseDepth'),
    accentDepth: num('accentDepth'),
    overlayThickness: num('overlayThickness'),
    pocketDepth: num('pocketDepth'),
    englishScale: num('englishScale'),
    nudgeX: num('nudgeX'),
    nudgeY: num('nudgeY'),
    plinth: ($('plinth') as HTMLInputElement).checked,
    plinthHeight: num('plinthHeight'),
    keel: num('keel'),
    joinArea: num('joinArea'),
    baseColor: val('baseColor'),
    accentColor: val('accentColor'),
  }
}

function updateModeVisibility(): void {
  const mode = val('mode')
  document.querySelectorAll<HTMLElement>('[data-modes]').forEach((el) => {
    el.style.display = el.dataset.modes!.includes(mode) ? '' : 'none'
  })
}

const statusEl = $('status')
function status(msg: string | null): void {
  if (msg === null) {
    statusEl.classList.add('hidden')
  } else {
    statusEl.classList.remove('hidden')
    statusEl.textContent = msg
  }
}

let preview: Preview
let lastResult: BuildResult | null = null
let building = false
let dirty = false

async function collectShapes(p: Params): Promise<ShapedSets> {
  const shaped: ShapedSets = {}
  const arFont = findFont(ARABIC_FONTS, val('arabicFont'))
  const arabicText = val('arabicText').trim()
  if (!arabicText) throw new Error('Enter an Arabic name')
  shaped.arabic = await shapeText(`ar:${arFont.key}`, fontUrl(arFont), arabicText)
  if (!shaped.arabic.contours.length) throw new Error('The Arabic font produced no outlines for this text')

  if (p.mode === 'm2') {
    const enFont = findFont(ENGLISH_FONTS, val('englishFont'))
    const englishText = val('englishText').trim()
    if (!englishText) throw new Error('Enter an English name')
    shaped.english = await shapeText(`en:${enFont.key}`, fontUrl(enFont), englishText)
    if (!shaped.english.contours.length) throw new Error('The English font produced no outlines for this text')
  }
  if (p.mode === 'm1') {
    const ltFont = findFont(LETTER_FONTS, val('letterFont'))
    const letter = val('letter').trim()
    if (!letter) throw new Error('Enter a letter')
    shaped.letter = await shapeText(`lt:${ltFont.key}`, fontUrl(ltFont), letter)
    if (!shaped.letter.contours.length) throw new Error('The letter font produced no outlines')
  }
  return shaped
}

function renderResult(res: BuildResult): void {
  preview.setParts(res.parts)
  const warnEl = $('warnings')
  warnEl.innerHTML = ''
  for (const w of res.warnings) {
    const div = document.createElement('div')
    div.className = w.includes('exceeds') ? 'err' : 'warn'
    div.textContent = w
    warnEl.appendChild(div)
  }
  const partList = res.parts.map((p) => p.name).join(', ')
  $('stats').innerHTML =
    `Footprint: <b>${res.stats.widthMm.toFixed(0)} × ${res.stats.heightMm.toFixed(0)} mm</b> (bed limit 235)<br>` +
    `Parts: ${res.parts.length} (${partList})` +
    (res.stats.joins ? `<br>Letter groups &amp; dots pulled together: ${res.stats.joins}` : '') +
    (res.stats.bridges ? `<br>Fallback connectors (could not join by sliding): ${res.stats.bridges}` : '')
  ;($('exportStl') as HTMLButtonElement).disabled = false
  ;($('export3mf') as HTMLButtonElement).disabled = false
}

async function rebuild(): Promise<void> {
  if (building) {
    dirty = true
    return
  }
  building = true
  try {
    status('Building…')
    const p = readParams()
    const shaped = await collectShapes(p)
    const res = buildDesign(shaped, p)
    lastResult = res
    ;(window as any).__last = res
    renderResult(res)
    status(null)
  } catch (e) {
    status(`⚠ ${(e as Error).message}`)
  } finally {
    building = false
    if (dirty) {
      dirty = false
      void rebuild()
    }
  }
}

let timer: number | undefined
function scheduleRebuild(): void {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => void rebuild(), 300)
}

function designName(): string {
  const p = readParams()
  const en = val('englishText').trim()
  const ar = val('arabicText').trim()
  return sanitizeName(p.mode === 'm2' && en ? en : ar)
}

async function init(): Promise<void> {
  fillFontSelect('arabicFont', ARABIC_FONTS)
  fillFontSelect('englishFont', ENGLISH_FONTS)
  fillFontSelect('letterFont', LETTER_FONTS)
  updateModeVisibility()
  preview = new Preview($('viewport'))

  // live slider outputs
  document.querySelectorAll<HTMLInputElement>('input[type=range]').forEach((r) => {
    const out = $(r.id + 'Out')
    r.addEventListener('input', () => {
      if (out) out.textContent = r.value
    })
  })

  document.querySelectorAll<HTMLElement>('input, select').forEach((el) => {
    el.addEventListener('input', scheduleRebuild)
    el.addEventListener('change', scheduleRebuild)
  })
  $('mode').addEventListener('change', updateModeVisibility)

  $('exportStl').addEventListener('click', () => {
    if (lastResult) exportSTLZip(lastResult.parts, designName())
  })
  $('export3mf').addEventListener('click', () => {
    if (lastResult) export3MF(lastResult.parts, designName())
  })

  status('Loading geometry engine…')
  await initManifold()
  await rebuild()
}

void init()
