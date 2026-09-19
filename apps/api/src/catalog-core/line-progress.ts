import type { ResolvedBom } from './bom-resolve';

/**
 * How much of an order line is already taken care of, per component (spec
 * §4.4.1 PlanRow definitions). Pure; the planner (freeFilament) and J4 both use
 * it, so "remaining" means the same thing everywhere.
 */

export interface ProgressJob {
  id: string;
  status: string;
  componentId: string | null;
  productId: string | null;
  quantityToProduce: number;
  reprintOfId: string | null;
  plates: Array<{ componentId: string | null; unitsRequired: number }>;
}

export interface ProgressMovement {
  componentId: string;
  colourKey: string;
  delta: number;
  reason: string;
}

export interface ComponentProgress {
  componentId: string;
  needed: number;
  alreadyPlanned: number;
  /** net: −Σ delta of PLAN_ALLOCATE and PLAN_RELEASE */
  allocatedFromStock: number;
  remaining: number;
}

export interface LineProgress {
  components: Map<string, ComponentProgress>;
  /** descriptions/ids of components of non-cancelled jobs that are not in the current BOM */
  jobsOnOldComponents: { jobCount: number; componentIds: string[] };
  placeholderJobs: number;
  /** any non-cancelled job, or any net allocation (the line is partly planned) */
  partlyPlanned: boolean;
}

const INACTIVE = new Set(['FAILED', 'CANCELLED']);

function unitsFor(job: ProgressJob, componentId: string): number | null {
  const g = job.plates.find((p) => p.componentId === componentId);
  return g ? g.unitsRequired : null;
}

export function computeLineProgress(
  line: { quantity: number },
  bom: Pick<ResolvedBom, 'components'>,
  jobs: ReadonlyArray<ProgressJob>,
  movements: ReadonlyArray<ProgressMovement>,
): LineProgress {
  const current = new Set(bom.components.map((c) => c.componentId));
  const components = new Map<string, ComponentProgress>();
  let placeholderJobs = 0;

  for (const job of jobs) {
    if (INACTIVE.has(job.status)) continue;
    if (!job.plates.length && !job.componentId && !job.productId) placeholderJobs++;
  }

  for (const c of bom.components) {
    let planned = 0;
    for (const job of jobs) {
      if (!INACTIVE.has(job.status)) {
        if (job.plates.length) planned += unitsFor(job, c.componentId) ?? 0;
        else if (job.componentId) planned += job.componentId === c.componentId ? job.quantityToProduce : 0;
        else planned += job.quantityToProduce * c.quantity; // whole-product legacy job or placeholder
      } else if (job.status === 'FAILED' && job.plates.length) {
        const reprints = jobs.filter((r) => r.reprintOfId === job.id);
        if (reprints.length) {
          const req = unitsFor(job, c.componentId) ?? 0;
          const again = reprints.reduce((s, r) => s + (unitsFor(r, c.componentId) ?? 0), 0);
          planned += Math.max(0, req - again);
        }
      }
    }
    const allocated = -movements
      .filter((m) => m.componentId === c.componentId && (m.reason === 'PLAN_ALLOCATE' || m.reason === 'PLAN_RELEASE'))
      .reduce((s, m) => s + m.delta, 0);
    const needed = c.quantity * line.quantity;
    components.set(c.componentId, {
      componentId: c.componentId,
      needed,
      alreadyPlanned: planned,
      allocatedFromStock: allocated,
      remaining: Math.max(0, needed - planned - allocated),
    });
  }

  const old = new Set<string>();
  let oldJobs = 0;
  for (const job of jobs) {
    if (job.status === 'CANCELLED') continue;
    const ids = job.plates.length ? job.plates.map((p) => p.componentId) : [job.componentId];
    const stale = ids.filter((id): id is string => !!id && !current.has(id));
    if (stale.length) {
      oldJobs++;
      stale.forEach((id) => old.add(id));
    }
  }

  const netAllocated = [...components.values()].some((p) => p.allocatedFromStock > 0);
  return {
    components,
    jobsOnOldComponents: { jobCount: oldJobs, componentIds: [...old] },
    placeholderJobs,
    partlyPlanned: jobs.some((j) => j.status !== 'CANCELLED') || netAllocated,
  };
}
