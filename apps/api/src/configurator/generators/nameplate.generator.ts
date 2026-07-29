import { BadRequestException } from '@nestjs/common';
import { Generator, GeneratedFile, GeneratorInfo } from './generator.interface';
import { slab } from '../geometry/mesh';
import { toBinarySTL, to3MF } from '../geometry/serialize';

export interface NameplateSpec {
  width: number;      // mm
  height: number;     // mm (plate depth in XY)
  thickness: number;  // mm
  holeDiameter: number; // mm, 0 = no hole
  segments: number;   // hole facet count
  label: string;      // metadata only — engraved offline, not in geometry
}

// Explicit server-side bounds (spec §6: every dimensional input bounded).
const BOUNDS = {
  width: { min: 10, max: 300 },
  height: { min: 10, max: 300 },
  thickness: { min: 1, max: 20 },
  hole: { min: 2, max: 60 },
  segments: { min: 12, max: 256 },
  labelMax: 60,
};

function num(raw: any, field: string): number {
  const n = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!Number.isFinite(n)) throw new BadRequestException(`"${field}" must be a finite number`);
  return n;
}

function bounded(raw: any, field: string, min: number, max: number): number {
  const n = num(raw, field);
  if (n < min || n > max) {
    throw new BadRequestException(`"${field}" must be between ${min} and ${max}`);
  }
  return n;
}

/** Strip control characters (keep printable), then cap length. Metadata only. */
function cleanLabel(raw: unknown, max: number): string {
  return String(raw ?? '')
    .split('')
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .slice(0, max)
    .trim();
}

const DENSITY_G_PER_MM3 = 1.24 / 1000; // PLA ~1.24 g/cc

export class NameplateGenerator implements Generator<NameplateSpec> {
  readonly key = 'nameplate';
  readonly name = 'Nameplate / Tag';
  readonly description = 'A parametric rectangular plate or tag with an optional mounting hole.';

  choices() {
    return {
      fields: [
        { key: 'width', label: 'Width (mm)', type: 'number', ...BOUNDS.width, default: 40 },
        { key: 'height', label: 'Height (mm)', type: 'number', ...BOUNDS.height, default: 20 },
        { key: 'thickness', label: 'Thickness (mm)', type: 'number', ...BOUNDS.thickness, default: 3 },
        { key: 'holeDiameter', label: 'Mounting hole diameter (mm, 0 = none)', type: 'number', min: 0, max: BOUNDS.hole.max, default: 4 },
        { key: 'label', label: 'Label (engraved offline)', type: 'text', maxLength: BOUNDS.labelMax, default: '' },
      ],
    };
  }

  validate(raw: unknown): NameplateSpec {
    if (!raw || typeof raw !== 'object') throw new BadRequestException('Missing parameters');
    const o = raw as Record<string, any>;

    const width = bounded(o.width, 'width', BOUNDS.width.min, BOUNDS.width.max);
    const height = bounded(o.height, 'height', BOUNDS.height.min, BOUNDS.height.max);
    const thickness = bounded(o.thickness, 'thickness', BOUNDS.thickness.min, BOUNDS.thickness.max);

    let holeDiameter = 0;
    if (o.holeDiameter !== undefined && o.holeDiameter !== null && o.holeDiameter !== '' && Number(o.holeDiameter) !== 0) {
      holeDiameter = bounded(o.holeDiameter, 'holeDiameter', BOUNDS.hole.min, BOUNDS.hole.max);
      // Must physically fit with a wall around it
      if (holeDiameter >= Math.min(width, height) * 0.9) {
        throw new BadRequestException('Mounting hole is too large for the plate size');
      }
    }

    const segments = o.segments === undefined
      ? 48
      : Math.round(bounded(o.segments, 'segments', BOUNDS.segments.min, BOUNDS.segments.max));

    const label = cleanLabel(o.label, BOUNDS.labelMax);

    return { width, height, thickness, holeDiameter, segments, label };
  }

  info(spec: NameplateSpec): GeneratorInfo {
    const volume = spec.width * spec.height * spec.thickness
      - (spec.holeDiameter > 0 ? Math.PI * (spec.holeDiameter / 2) ** 2 * spec.thickness : 0);
    const warnings: string[] = [];
    if (spec.thickness < 2) warnings.push('Thin plates under 2 mm can warp or snap.');
    if (spec.holeDiameter > 0 && spec.holeDiameter < 3) warnings.push('Very small holes may not print cleanly.');
    return {
      dimensions: { width: spec.width, height: spec.height, depth: spec.thickness },
      warnings,
      label: spec.label ? `Tag "${spec.label}" ${spec.width}x${spec.height}` : `Tag ${spec.width}x${spec.height}`,
      estimatedGrams: Math.round(volume * DENSITY_G_PER_MM3 * 10) / 10,
    };
  }

  previewSvg(spec: NameplateSpec): string {
    const pad = 8;
    const w = spec.width;
    const h = spec.height;
    const vbW = w + pad * 2;
    const vbH = h + pad * 2;
    const holeCx = pad + w / 2;
    const holeCy = pad + h / 2;
    const holeR = spec.holeDiameter > 0 ? spec.holeDiameter / 2 : 0;
    const label = spec.label
      ? `<text x="${pad + w / 2}" y="${pad + h / 2}" font-size="${Math.max(4, h / 6)}" ` +
        `text-anchor="middle" dominant-baseline="middle" fill="#64748b">${escapeSvgText(spec.label)}</text>`
      : '';
    // Static, server-built SVG — no customer markup is echoed, only escaped text.
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vbW} ${vbH}" width="100%">` +
      `<rect x="${pad}" y="${pad}" width="${w}" height="${h}" rx="2" ` +
      `fill="#e2e8f0" stroke="#475569" stroke-width="0.6"/>` +
      (holeR > 0 ? `<circle cx="${holeCx}" cy="${holeCy}" r="${holeR}" fill="#f8fafc" stroke="#475569" stroke-width="0.6"/>` : '') +
      label +
      `</svg>`
    );
  }

  async generate(spec: NameplateSpec): Promise<GeneratedFile[]> {
    const mesh = slab({
      width: spec.width,
      depth: spec.height,
      thickness: spec.thickness,
      holeDiameter: spec.holeDiameter,
      segments: spec.segments,
    });

    // Filename from validated fields only (spec §3a) — sanitised label, numeric dims.
    const safeLabel = spec.label ? spec.label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) : 'tag';
    const base = `${safeLabel}-${spec.width}x${spec.height}x${spec.thickness}`;

    const [stl, threemf] = await Promise.all([
      Promise.resolve(toBinarySTL(mesh)),
      to3MF(mesh, base),
    ]);

    return [
      { filename: `${base}.3mf`, mime: 'model/3mf', body: threemf },
      { filename: `${base}.stl`, mime: 'model/stl', body: stl },
    ];
  }
}

function escapeSvgText(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
}
