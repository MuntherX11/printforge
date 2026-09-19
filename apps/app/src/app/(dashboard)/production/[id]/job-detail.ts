/**
 * GET /jobs/:id (J3), the fields the job page reads (spec §4.4 J3).
 */
import { api } from '@/lib/api';
import type {
  ApiMaterial, ApiPrinter, JobPlateDetail, JobStatus, JobSurplusRow, NamedOption, SurplusPolicy,
} from '@/lib/types/api';

export interface FilamentPlanLine {
  materialId: string | null;
  colour: string | null;
  type: string | null;
  brand: string | null;
  label: string;
  gramsNeeded: number;
  spoolId: string | null;
  spoolRef: string | null;
  location: string | null;
  spoolRemaining: number | null;
  assigned: boolean;
  hasEnough: boolean;
  lineId?: string;
  substituted?: boolean;
  overridden?: boolean;
  /** The job's colour gave this slot another filament than the file's. */
  optionColour?: boolean;
  /** Recoloured after planning. */
  swapped?: boolean;
  slicedColour?: string | null;
  plannedColour?: string | null;
}

export interface JobDetail {
  id: string;
  name: string;
  status: JobStatus;
  printer: Pick<ApiPrinter, 'id' | 'name' | 'moonrakerUrl' | 'cameraUrl'> | null;
  assignedTo: { id: string; name: string } | null;
  order: { id: string; orderNumber: string } | null;
  gcodeFilename: string | null;
  printDuration: number | null;
  colorChanges: number;
  failureReason: string | null;
  failedAt: string | null;
  wasteGrams: number;
  reprintOfId: string | null;
  reprints?: Array<{ id: string; name: string; status: JobStatus }>;
  materialCost: number | null;
  machineCost: number | null;
  wasteCost: number | null;
  overheadCost: number | null;
  totalCost: number | null;
  startedAt: string | null;
  completedAt: string | null;
  size: NamedOption | null;
  colour: NamedOption | null;
  optionLabel: string | null;
  surplusPolicy: SurplusPolicy | null;
  plates: JobPlateDetail[];
  surplusByComponent: JobSurplusRow[];
  filamentPlan: FilamentPlanLine[];
}

const TERMINAL: JobStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];
export const isTerminal = (s: JobStatus) => TERMINAL.includes(s);

/**
 * The note after a picking-list line (spec §5.3): the job's colour, a swap
 * after planning, or (as before) a customer change / closest colour.
 */
export function filamentNote(f: FilamentPlanLine, jobColour: string | null): { text: string; tone: 'blue' | 'amber' } | null {
  const sliced = f.slicedColour ? ` — file sliced for ${f.slicedColour}` : '';
  if (f.swapped) {
    const now = [f.colour, f.type].filter(Boolean).join(' ') || f.label;
    return { text: `changed to ${now}${f.plannedColour ? ` (planned ${f.plannedColour})` : ''}${sliced}`, tone: 'blue' };
  }
  if (f.optionColour) return { text: `${jobColour ?? 'Option'} colour${sliced}`, tone: 'blue' };
  if (f.overridden) return { text: `customer change${sliced}`, tone: 'blue' };
  if (f.substituted) return { text: 'closest colour — file asked for another', tone: 'amber' };
  return null;
}

/** All materials (the list endpoint may or may not paginate). */
export async function loadMaterials(): Promise<ApiMaterial[]> {
  const res = await api.get<ApiMaterial[] | { data: ApiMaterial[] }>('/materials?limit=500');
  return Array.isArray(res) ? res : res?.data ?? [];
}
