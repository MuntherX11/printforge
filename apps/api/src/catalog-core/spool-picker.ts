import { filamentColourDistance } from '../common/utils/colour';

/**
 * Which spool to pull for each filament a job needs (spec §3.7). This is today's
 * `JobsService.pickSpoolsForNeeds` behaviour, extracted unchanged, plus netting:
 * a spool's effective remaining weight is its currentWeight minus what active
 * jobs have already reserved on it, minus grams picked earlier in this request.
 *
 * - exact material first; among those the smallest spool that covers the need,
 *   else the largest one that doesn't;
 * - otherwise the same type, ranked by colour distance (a hex-measured pool is
 *   preferred over name-only matches, never mixed), then by weight;
 * - one spool per line; `substituted` when the spool isn't the exact material.
 */

export interface SpoolMaterial {
  id: string;
  type: string;
  color?: string | null;
  colorHex?: string | null;
  costPerGram?: number;
  name?: string;
}

export interface SpoolRow {
  id: string;
  materialId: string;
  currentWeight: number;
  printforgeId?: string | null;
  material?: SpoolMaterial | null;
  location?: { id: string; name: string } | null;
}

export interface SpoolNeed<M extends SpoolMaterial = SpoolMaterial> {
  material: M;
  grams: number;
}

export interface SpoolPick<M extends SpoolMaterial = SpoolMaterial, S extends SpoolRow = SpoolRow> {
  material: M;
  grams: number;
  spool: S | null;
  substituted: boolean;
  /** currentWeight - reserved (before this pick) */
  effectiveRemaining: number;
  hasEnough: boolean;
}

export function pickSpools<M extends SpoolMaterial, S extends SpoolRow>(
  needs: ReadonlyArray<SpoolNeed<M>>,
  spools: ReadonlyArray<S>,
  opts: { reservedBySpool?: Map<string, number> } = {},
): Array<SpoolPick<M, S>> {
  const reserved = opts.reservedBySpool ?? new Map<string, number>();
  const eff = (s: S) => s.currentWeight - (reserved.get(s.id) ?? 0);
  // Today's query orders by currentWeight asc; the ranking below uses effective weight.
  const pool = [...spools].sort((a, b) => eff(a) - eff(b));
  const taken = new Set<string>();

  const smallestThatCovers = (list: S[], grams: number): S | null =>
    list.find((s) => !taken.has(s.id) && eff(s) >= grams) ?? [...list].reverse().find((s) => !taken.has(s.id)) ?? null;

  return needs.map(({ material, grams }) => {
    const exact = pool.filter((s) => s.materialId === material.id);
    let spool = smallestThatCovers(exact, grams);
    let substituted = false;

    if (!spool) {
      const scored = pool
        .filter((s) => !taken.has(s.id) && s.material?.type === material.type)
        .map((s) => ({
          s,
          d: filamentColourDistance(
            { colour: material.color, hex: material.colorHex },
            { colour: s.material?.color, hex: s.material?.colorHex },
          ),
        }))
        .filter((x) => x.d !== null);
      const byHex = scored.filter((x) => x.d!.basis === 'hex');
      const ranked = (byHex.length > 0 ? byHex : scored)
        .sort((a, b) => a.d!.distance - b.d!.distance || eff(a.s) - eff(b.s))
        .map((x) => x.s);
      spool = smallestThatCovers(ranked, grams);
      substituted = !!spool;
    }

    const effectiveRemaining = spool ? eff(spool) : 0;
    if (spool) {
      taken.add(spool.id);
      reserved.set(spool.id, (reserved.get(spool.id) ?? 0) + grams);
    }
    return { material, grams, spool, substituted, effectiveRemaining, hasEnough: !!spool && effectiveRemaining >= grams };
  });
}
