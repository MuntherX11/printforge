'use client';

/**
 * Pieces shared by Production readiness (§5.2 F) and New job (§5.2 G): the
 * two-column filament table ("after open orders" vs "spool to use"), the
 * parts table, plan lines and the summary lines.
 */
import { formatGrams } from '@/lib/product-format';
import type { Readiness } from '@/lib/types/api';
import { Swatch } from './options-ui';

type Filament = Readiness['filament'][number];
type Part = Readiness['parts'][number];
type Plate = Readiness['components'][number]['plates'][number];

/** "12 + 12 + 8", or "5 × 12 + 8" when there are many plates. */
export function platesText(plates: Plate[]): string {
  const total = plates.reduce((n, p) => n + p.plateCount, 0);
  if (total <= 6) return plates.flatMap(p => Array.from({ length: p.plateCount }, () => String(p.unitsPerPlate))).join(' + ');
  return plates.map(p => (p.plateCount > 1 ? `${p.plateCount} × ${p.unitsPerPlate}` : String(p.unitsPerPlate))).join(' + ');
}

export function ComponentPlanLines({ components }: { components: Readiness['components'] }) {
  return (
    <ul className="space-y-1 text-sm text-gray-800 dark:text-gray-200">
      {components.map(c => (
        <li key={c.componentId}>
          <span className="font-medium">{c.description}</span>
          {c.colourLabel && <span className="text-gray-500 dark:text-gray-400"> ({c.colourLabel})</span>}: {c.unitsRequired} needed
          {c.plates.length > 0
            ? <> → plates {platesText(c.plates)} ({c.unitsPrinted} printed, {c.surplus} extra)</>
            : c.unitsRequired === 0 ? ' — covered by printed stock' : null}
        </li>
      ))}
    </ul>
  );
}

const shortBy = (f: Filament) => Math.max(0, f.gramsNeeded - f.free);
const spoolShortBy = (f: Filament) => Math.max(0, f.gramsNeeded - (f.suggestedSpool?.effectiveRemaining ?? 0));

export function FilamentTable({ filament }: { filament: Filament[] }) {
  if (filament.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
            <th className="py-2 pr-3">Filament</th>
            <th className="pr-3 text-right">Needed</th>
            <th className="pr-3">After open orders</th>
            <th className="pr-3">Spool to use</th>
          </tr>
        </thead>
        <tbody>
          {filament.map(f => (
            <tr key={`${f.materialId}-${f.slicedMaterialId ?? ''}`} className="border-b last:border-0 dark:border-gray-800">
              <td className="py-2 pr-3">
                <span className="inline-flex items-center gap-1.5"><Swatch hex={f.colorHex} title={f.label} /> {f.label}</span>
              </td>
              <td className="pr-3 text-right tabular-nums">{formatGrams(f.gramsNeeded)}</td>
              <td className="pr-3">
                <span className="tabular-nums text-gray-600 dark:text-gray-400">
                  {formatGrams(f.totalStock)} in stock − {formatGrams(f.reserved)} reserved = {formatGrams(f.free)} free
                </span>{' '}
                {f.hasEnough
                  ? <span className="text-green-700 dark:text-green-400">✓</span>
                  : <span className="text-amber-700 dark:text-amber-300">Short {formatGrams(shortBy(f))}</span>}
              </td>
              <td className="pr-3">
                {f.suggestedSpool ? (
                  <>
                    <span className="tabular-nums">
                      {f.suggestedSpool.pfid ?? 'Spool'} · {formatGrams(f.suggestedSpool.effectiveRemaining)} left after other jobs
                      {f.suggestedSpool.location ? ` · ${f.suggestedSpool.location}` : ''}
                    </span>{' '}
                    {f.spoolHasEnough
                      ? <span className="text-green-700 dark:text-green-400">✓ enough</span>
                      : <span className="text-amber-700 dark:text-amber-300">short {formatGrams(spoolShortBy(f))}</span>}
                  </>
                ) : <span className="text-amber-700 dark:text-amber-300">No spool</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PartsTable({ parts }: { parts: Part[] }) {
  if (parts.length === 0) return null;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
          <th className="py-2 pr-3">Part</th><th className="pr-3 text-right">Needed</th><th className="pr-3 text-right">Free</th><th className="pr-3">Status</th>
        </tr>
      </thead>
      <tbody>
        {parts.map(p => (
          <tr key={p.partId} className="border-b last:border-0 dark:border-gray-800">
            <td className="py-2 pr-3">{p.name}</td>
            <td className="pr-3 text-right tabular-nums">{p.needed} pcs</td>
            <td className="pr-3 text-right tabular-nums">{p.free} pcs</td>
            <td className="pr-3">
              {p.hasEnough
                ? <span className="text-green-700 dark:text-green-400">✓</span>
                : <span className="text-amber-700 dark:text-amber-300">Short {Math.max(0, p.needed - p.free)} pcs</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The two summary lines, never merged (§5.2 F). */
export function ReadinessSummary({ readiness }: { readiness: Readiness }) {
  const shortF = readiness.filament.filter(f => !f.hasEnough);
  const shortP = readiness.parts.filter(p => !p.hasEnough);
  return (
    <div className="space-y-0.5 text-sm">
      <p>
        <span className="font-medium">After open orders: </span>
        {shortF.length === 0
          ? <span className="text-green-700 dark:text-green-400">enough filament for {readiness.qty}</span>
          : <span className="text-amber-700 dark:text-amber-300">short: {shortF.map(f => `${f.label} ${formatGrams(shortBy(f))}`).join(', ')}</span>}
      </p>
      {readiness.parts.length > 0 && (
        <p>
          <span className="font-medium">Parts: </span>
          {shortP.length === 0
            ? <span className="text-green-700 dark:text-green-400">enough</span>
            : <span className="text-amber-700 dark:text-amber-300">short: {shortP.map(p => `${p.name} ${Math.max(0, p.needed - p.free)} pcs`).join(', ')}</span>}
        </p>
      )}
    </div>
  );
}

export function ProblemList({ problems, tone }: { problems: Readiness['problems']; tone: 'error' | 'warning' }) {
  if (problems.length === 0) return null;
  const cls = tone === 'error' ? 'text-red-600 dark:text-red-400' : 'text-amber-700 dark:text-amber-300';
  return (
    <ul className={`space-y-0.5 text-sm ${cls}`}>
      {problems.map((p, i) => <li key={`${p.code}-${i}`}>{p.message}</li>)}
    </ul>
  );
}
