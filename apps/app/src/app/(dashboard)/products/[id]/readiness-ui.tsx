'use client';

/**
 * Pieces shared by Production readiness (§5.2 F) and New job (§5.2 G): the
 * filament tables, the parts table and the problem lists.
 */
import { formatGrams } from '@/lib/product-format';
import type { Readiness } from '@/lib/types/api';
import { Swatch } from './options-ui';
import { materialGrams, shortBy, spoolNote, wholeGrams, type SpoolNote } from './readiness-model';

type Filament = Readiness['filament'][number];
type Part = Readiness['parts'][number];

const AMBER = 'text-amber-700 dark:text-amber-300';
const GREEN = 'text-green-700 dark:text-green-400';
const TH = 'border-b text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400';

function FilamentName({ f }: { f: Filament }) {
  return <span className="inline-flex items-center gap-1.5"><Swatch hex={f.colorHex} name={f.color || f.label} title={f.label} /> {f.label}</span>;
}

const rowKey = (f: Filament) => `${f.materialId}-${f.slicedMaterialId ?? ''}`;

/** Readiness's spool cell; a substitute spool says "different colour". */
function SpoolText({ note }: { note: SpoolNote }) {
  if (note.kind === 'none') return <span className={AMBER}>No spool</span>;
  if (note.kind === 'other') return <span className={AMBER}>{note.text}</span>;
  return (
    <>
      <span className="tabular-nums">{note.text}</span>
      {note.kind === 'low' && <span className={AMBER}> — {note.left}</span>}
    </>
  );
}

/** New job's spool cell, as before, except a substitute spool never says "✓ enough". */
function JobSpoolText({ f }: { f: Filament }) {
  const s = f.suggestedSpool;
  if (!s) return <span className={AMBER}>No spool</span>;
  const note = spoolNote(f);
  return (
    <>
      <span className="tabular-nums">
        {s.pfid ?? 'Spool'} · {formatGrams(s.effectiveRemaining)} left after other jobs{s.location ? ` · ${s.location}` : ''}
      </span>{' '}
      {note.kind === 'other'
        ? <span className={AMBER}>{s.materialName ?? 'another filament'} — different colour</span>
        : f.spoolHasEnough
          ? <span className={GREEN}>✓ enough</span>
          : <span className={AMBER}>short {formatGrams(Math.max(0, f.gramsNeeded - s.effectiveRemaining))}</span>}
    </>
  );
}

/** Production readiness: Filament | Needed | Free | Spool. */
export function ReadinessFilamentTable({ filament }: { filament: Filament[] }) {
  if (filament.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className={TH}>
            <th className="py-2 pr-3">Filament</th>
            <th className="pr-3 text-right">Needed</th>
            <th className="pr-3 text-right">Free</th>
            <th className="pr-3">Spool</th>
          </tr>
        </thead>
        <tbody>
          {filament.map(f => (
            <tr key={rowKey(f)} className="border-b last:border-0 dark:border-gray-800">
              <td className="py-2 pr-3"><FilamentName f={f} /></td>
              <td className="pr-3 text-right tabular-nums">{formatGrams(f.gramsNeeded)}</td>
              <td className={`pr-3 text-right tabular-nums ${f.hasEnough ? '' : AMBER}`}
                title={`${wholeGrams(f.totalStock)} in stock − ${wholeGrams(f.reserved)} reserved${f.hasEnough ? '' : ` · short ${formatGrams(shortBy(f))}`}`}>
                {wholeGrams(f.free)}
              </td>
              <td className="pr-3"><SpoolText note={spoolNote(f)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** New job: "after open orders" vs "spool to use", never merged. */
export function FilamentTable({ filament }: { filament: Filament[] }) {
  if (filament.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className={TH}>
            <th className="py-2 pr-3">Filament</th>
            <th className="pr-3 text-right">Needed</th>
            <th className="pr-3">After open orders</th>
            <th className="pr-3">Spool to use</th>
          </tr>
        </thead>
        <tbody>
          {filament.map(f => (
            <tr key={rowKey(f)} className="border-b last:border-0 dark:border-gray-800">
              <td className="py-2 pr-3"><FilamentName f={f} /></td>
              <td className="pr-3 text-right tabular-nums">{formatGrams(f.gramsNeeded)}</td>
              <td className="pr-3">
                <span className="tabular-nums text-gray-600 dark:text-gray-400">
                  {formatGrams(f.totalStock)} in stock − {formatGrams(f.reserved)} reserved = {formatGrams(f.free)} free
                </span>{' '}
                {f.hasEnough
                  ? <span className={GREEN}>✓</span>
                  : (
                    <span className={AMBER}>
                      Short {formatGrams(shortBy(f))}
                      {materialGrams(f) > f.gramsNeeded ? ` for all ${formatGrams(materialGrams(f))} of ${f.label}` : ''}
                    </span>
                  )}
              </td>
              <td className="pr-3"><JobSpoolText f={f} /></td>
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
        <tr className={TH}>
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
                ? <span className={GREEN}>✓</span>
                : <span className={AMBER}>Short {Math.max(0, p.needed - p.free)} pcs</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ProblemList({ problems, tone }: { problems: Readiness['problems']; tone: 'error' | 'warning' }) {
  if (problems.length === 0) return null;
  const cls = tone === 'error' ? 'text-red-600 dark:text-red-400' : AMBER;
  return (
    <ul className={`space-y-0.5 text-sm ${cls}`}>
      {problems.map((p, i) => <li key={`${p.code}-${i}`}>{p.message}</li>)}
    </ul>
  );
}
