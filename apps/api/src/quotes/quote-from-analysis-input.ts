import { BadRequestException } from '@nestjs/common';
import { round3 } from '../catalog-core/cost-engine';
import { allowedBody, optionalNumber, optionalText, requiredNumber } from '../common/utils/validate-number';

/**
 * Allowlist parser for POST /quotes/from-analysis (the staff Quick Quote's
 * "Save as quote" for one STL or G-code file).
 *
 * SaveQuoteFromAnalysisDto is an interface the global ValidationPipe can't
 * whitelist. costEstimate.suggestedPrice became the quote and line price with
 * no bound (a negative price was accepted), `source` came from the body, and
 * `analysis` and `costEstimate` were stored as arbitrary JSON, gcodeMetadata
 * being returned to the customer by CUSTOMER_QUOTE_SELECT.
 *
 * Top-level keys other than the six below → 400. Inside `analysis` and
 * `costEstimate` only the fields the file parser and the cost estimate produce
 * are kept (others are dropped, as the customer request does), each bounded;
 * a bad value is a 400 naming it. `source` is a staff source: CUSTOMER is for
 * the customer's own request only.
 */
export const FROM_ANALYSIS_KEYS = ['customerId', 'description', 'analysis', 'costEstimate', 'source', 'notes'] as const;
export const STAFF_QUOTE_SOURCES = ['QUICK_QUOTE', 'MANUAL', 'LINK', 'DESIGN'] as const;

const MONEY = { min: 0, max: 1_000_000 };
const GRAMS = { min: 0, max: 100_000 };
/** About 115 days of printing, as the customer request allows. */
const SECONDS = { min: 0, max: 10_000_000 };
const MINUTES = { min: 0, max: SECONDS.max / 60 };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** The numeric fields kept from each analysis type, with their bounds. */
const GCODE_NUMBERS: Record<string, { min: number; max: number; integer?: boolean }> = {
  estimatedTimeSeconds: SECONDS,
  filamentUsedMm: { min: 0, max: 1e9 },
  filamentUsedGrams: GRAMS,
  layerHeight: { min: 0, max: 10 },
  layerCount: { min: 0, max: 1_000_000, integer: true },
  nozzleTemp: { min: 0, max: 1000 },
  bedTemp: { min: 0, max: 1000 },
  totalFilamentChanges: { min: 0, max: 1_000_000, integer: true },
  toolCount: { min: 0, max: 64, integer: true },
  objectCount: { min: 0, max: 100_000, integer: true },
  purgeVolumeGrams: GRAMS,
};
const STL_NUMBERS: Record<string, { min: number; max: number; integer?: boolean }> = {
  triangleCount: { min: 0, max: 100_000_000, integer: true },
  volumeCm3: { min: 0, max: 10_000_000 },
  surfaceAreaCm2: { min: 0, max: 100_000_000 },
  estimatedGrams: GRAMS,
  estimatedMinutes: MINUTES,
};
const COST_NUMBERS = ['materialCost', 'machineCost', 'electricityCost', 'wasteCost', 'overheadCost', 'totalCost'] as const;

export interface QuoteFromAnalysisInput {
  customerId: string;
  description: string;
  source: (typeof STAFF_QUOTE_SOURCES)[number];
  notes: string | null;
  price: number;
  isGcode: boolean;
  /** Kept on the quote as gcodeMetadata or stlMetadata; null when none was sent. */
  metadata: Json | null;
  costBreakdown: Json;
  line: { estimatedGrams: number | null; estimatedMinutes: number | null; estimatedColors: number | null; estimatedCost: number | null };
}

function pickNumbers(src: Json, spec: Record<string, { min: number; max: number; integer?: boolean }>, prefix: string, out: Json) {
  for (const [key, range] of Object.entries(spec)) {
    const n = optionalNumber(src[key], `${prefix}.${key}`, range);
    if (n !== undefined) out[key] = n;
  }
}

function parseAnalysis(raw: unknown): { isGcode: boolean; metadata: Json | null } {
  if (raw === undefined || raw === null) return { isGcode: false, metadata: null };
  if (!isObject(raw)) throw new BadRequestException('"analysis" must be an object');
  const slicer = optionalText(raw.slicer, 'analysis.slicer', 100) ?? null;
  const isGcode = raw.type === 'gcode' || !!slicer;
  const out: Json = { type: isGcode ? 'gcode' : 'stl' };
  if (isGcode) {
    out.slicer = slicer;
    pickNumbers(raw, GCODE_NUMBERS, 'analysis', out);
    const filamentType = optionalText(raw.filamentType, 'analysis.filamentType', 50);
    if (filamentType) out.filamentType = filamentType;
  } else {
    pickNumbers(raw, STL_NUMBERS, 'analysis', out);
    if (raw.boundingBox !== undefined && raw.boundingBox !== null) {
      if (!isObject(raw.boundingBox)) throw new BadRequestException('"analysis.boundingBox" must be an object');
      const box = raw.boundingBox;
      out.boundingBox = Object.fromEntries(['x', 'y', 'z'].map((k) => [k, requiredNumber(box[k], `analysis.boundingBox.${k}`, { min: 0, max: 100_000 })]));
    }
  }
  return { isGcode, metadata: out };
}

export function parseQuoteFromAnalysis(raw: unknown): QuoteFromAnalysisInput {
  const b = allowedBody(raw, FROM_ANALYSIS_KEYS);

  const customerId = typeof b.customerId === 'string' ? b.customerId.trim() : '';
  if (!customerId || customerId.length > 64) throw new BadRequestException('customerId is required');

  const description = optionalText(b.description, 'description', 255);
  if (!description) throw new BadRequestException('description is required');

  let source: QuoteFromAnalysisInput['source'] = 'QUICK_QUOTE';
  if (b.source !== undefined && b.source !== null && b.source !== '') {
    if (typeof b.source !== 'string' || !(STAFF_QUOTE_SOURCES as readonly string[]).includes(b.source)) {
      throw new BadRequestException(`"source" must be one of: ${STAFF_QUOTE_SOURCES.join(', ')}`);
    }
    source = b.source as QuoteFromAnalysisInput['source'];
  }

  if (!isObject(b.costEstimate)) throw new BadRequestException('"costEstimate" is required');
  const cost = b.costEstimate;
  const price = round3(requiredNumber(cost.suggestedPrice, 'costEstimate.suggestedPrice', MONEY));
  const costBreakdown: Json = { suggestedPrice: price };
  for (const key of COST_NUMBERS) {
    const n = optionalNumber(cost[key], `costEstimate.${key}`, MONEY);
    if (n !== undefined) costBreakdown[key] = round3(n);
  }
  const markup = optionalNumber(cost.markupMultiplier, 'costEstimate.markupMultiplier', { min: 0, max: 1000 });
  if (markup !== undefined) costBreakdown.markupMultiplier = markup;

  const { isGcode, metadata } = parseAnalysis(b.analysis);
  const m = metadata ?? {};
  const grams = (m.filamentUsedGrams ?? m.estimatedGrams ?? null) as number | null;
  const seconds = (m.estimatedTimeSeconds ?? null) as number | null;
  const minutes = seconds ? Math.round(seconds / 60) : ((m.estimatedMinutes ?? null) as number | null);

  return {
    customerId,
    description,
    source,
    notes: optionalText(b.notes, 'notes', 5000) ?? null,
    price,
    isGcode,
    metadata,
    costBreakdown,
    line: {
      estimatedGrams: grams || null,
      estimatedMinutes: minutes || null,
      estimatedColors: ((m.toolCount ?? null) as number | null) || null,
      estimatedCost: ((costBreakdown.totalCost ?? null) as number | null) || null,
    },
  };
}
