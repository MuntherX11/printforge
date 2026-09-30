import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PlanSummary, Problem, SurplusPolicy } from '@printforge/types';
import { gramsForPlan, minutesForPlan, PlanCache, PlanError, suggestPlan, unitsOf, type PlannerLayout } from '../catalog-core/plate-planner';
import { requiredNumber } from '../common/utils/validate-number';
import { STALE_GRAMS_RATIO } from './plate-layout-backfill.service';
import { asBody } from './product-input';
import { COLOR_CHANGES_BOUNDS, GRAMS_BOUNDS, MINUTES_BOUNDS, UNITS_BOUNDS } from './slicer-import-input';

/**
 * Rules of Convert to plate (O8a/O8): the input parsers, the "converted"
 * marker, the plate's sanity checks and its planning table. Pure except
 * `liveConversion`, which reads one layout row.
 */

export interface LayoutConversionInput {
  componentId: string;
  unitsPerPlate: number;
  plateMinutes: number;
  plateGrams: number;
  colorChanges?: number;
  assembledUploadId?: string;
}

function id(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 64) throw new BadRequestException(`"${field}" must be an id`);
  return raw.trim();
}

function required(raw: unknown, field: string, bounds: { min: number; max: number; integer?: boolean }): number {
  if (raw === undefined || raw === null || raw === '') throw new BadRequestException(`"${field}" is required`);
  return requiredNumber(raw, field, bounds);
}

/** O8a query / O8 body (unknown keys ignored). Numbers may be numeric strings, as a query sends them. */
export function parseLayoutConversion(raw: unknown): LayoutConversionInput {
  const b = asBody(raw);
  const out: LayoutConversionInput = {
    componentId: id(b.componentId, 'componentId'),
    unitsPerPlate: required(b.unitsPerPlate, 'unitsPerPlate', UNITS_BOUNDS),
    plateMinutes: required(b.plateMinutes, 'plateMinutes', MINUTES_BOUNDS),
    plateGrams: required(b.plateGrams, 'plateGrams', GRAMS_BOUNDS),
  };
  if (b.colorChanges !== undefined && b.colorChanges !== null && b.colorChanges !== '') {
    out.colorChanges = requiredNumber(b.colorChanges, 'colorChanges', COLOR_CHANGES_BOUNDS);
  }
  if (b.assembledUploadId !== undefined && b.assembledUploadId !== null && b.assembledUploadId !== '') {
    out.assembledUploadId = id(b.assembledUploadId, 'assembledUploadId');
  }
  return out;
}

/** O8 `isActive`: omitted → undefined (the recommendation decides). */
export function parseConversionActive(raw: unknown): boolean | undefined {
  const b = asBody(raw);
  if (b.isActive === undefined) return undefined;
  if (typeof b.isActive !== 'boolean') throw new BadRequestException('"isActive" must be true or false');
  return b.isActive;
}

export const CONVERTED_TAIL = {
  components: 'activate it before adding components',
  import: 'activate it before importing files for it',
  tiers: 'activate it before setting its bulk tiers',
  kind: 'activate it to change its kind.',
} as const;

export function CONVERTED_BLOCKER(name: string, tail: string): string {
  return `"${name}" was converted to a plate layout — ${tail}`;
}

export interface LiveConversion {
  id: string;
  componentId: string;
  unitsPerPlate: number;
  isActive: boolean;
  component: { description: string };
}

/**
 * The layout an option was converted into, while it still exists. null when
 * never converted, or when that layout was deleted since (the option is then
 * an ordinary one again).
 */
export async function liveConversion(
  db: Pick<Prisma.TransactionClient, 'plateLayout'>,
  row: { convertedLayoutId?: string | null },
): Promise<LiveConversion | null> {
  if (!row.convertedLayoutId) return null;
  return db.plateLayout.findUnique({
    where: { id: row.convertedLayoutId },
    select: { id: true, componentId: true, unitsPerPlate: true, isActive: true, component: { select: { description: true } } },
  });
}

// ------------------------------------------------------------ plate checks

/** Per-unit minutes this much over printing one at a time make the plate "slower". */
export const SLOWER_RATIO = 0.1;

const r2 = (x: number) => Math.round(x * 100) / 100;
const pct = (x: number) => `${x < 0 ? '−' : '+'}${Math.abs(Math.round(x * 100))} %`;

/**
 * The plate against one unit of the part. Any warning here means "create it
 * switched off" (BF-1's rule for grams, plus time and missing figures).
 */
export function plateChecks(
  desc: string,
  units: number,
  plateMinutes: number,
  plateGrams: number,
  single: { gramsPerUnit: number; minutesPerUnit: number },
): { warnings: Problem[]; recommendActive: boolean } {
  const warnings: Problem[] = [];
  const g1 = single.gramsPerUnit;
  const m1 = single.minutesPerUnit;
  if (!(g1 > 0) || !(m1 > 0)) {
    warnings.push({ code: 'PLATE_NO_SINGLE', message: `"${desc}" has no per-unit grams or time to check this plate against` });
  } else {
    const g = plateGrams / units;
    const m = plateMinutes / units;
    const dg = (g - g1) / g1;
    if (Math.abs(dg) > STALE_GRAMS_RATIO) {
      warnings.push({
        code: 'PLATE_GRAMS_DIFFER',
        message: `"${desc} ×${units}": ${r2(g)} g per unit on this plate vs ${r2(g1)} g for one (${pct(dg)}) — check the part and the units`,
      });
    }
    if (m > m1 * (1 + SLOWER_RATIO)) {
      warnings.push({
        code: 'PLATE_SLOWER_PER_UNIT',
        message: `"${desc} ×${units}": ${r2(m)} min per unit on this plate vs ${r2(m1)} min printing one at a time (${pct((m - m1) / m1)}) — every job of 2 or more would use this slower plate`,
      });
    }
  }
  return { warnings, recommendActive: warnings.length === 0 };
}

// ---------------------------------------------------------------- planning

const r3 = (x: number) => Math.round(x * 1000) / 1000;

function summary(N: number, layouts: PlannerLayout[], policy: SurplusPolicy, slotIndexes: number[]): PlanSummary {
  const plan = suggestPlan(N, layouts, new PlanCache());
  return {
    plates: plan.map((p) => ({ unitsPerPlate: p.layout.unitsPerPlate, plateCount: p.plateCount })),
    minutes: r3(minutesForPlan(plan, N, policy)),
    grams: r3(slotIndexes.reduce((s, i) => s + gramsForPlan(plan, i, N, policy), 0)),
    extra: unitsOf(plan) - N,
  };
}

/**
 * What job suggestions do for N of the part, today and with the new plate,
 * for N in {2, ⌈U/2⌉, U, U+1} (2 or more, ascending). The planner puts N on
 * the fewest plates, so a small N can take a whole plate.
 */
export function planningRows(
  now: PlannerLayout[],
  plate: PlannerLayout,
  units: number,
  policy: SurplusPolicy,
  slotIndexes: number[],
): Array<{ units: number; now: PlanSummary | null; withPlate: PlanSummary }> {
  const ns = [...new Set([2, Math.ceil(units / 2), units, units + 1])].filter((n) => n >= 2).sort((a, b) => a - b);
  return ns.map((N) => {
    let current: PlanSummary | null = null;
    try {
      current = now.length ? summary(N, now, policy, slotIndexes) : null;
    } catch (e) {
      if (!(e instanceof PlanError)) throw e;
    }
    return { units: N, now: current, withPlate: summary(N, [plate, ...now], policy, slotIndexes) };
  });
}
