'use client';

import { useFormatCurrency } from '@/lib/locale-context';
import { formatGrams, formatMinutes } from '@/lib/product-format';
import type { LayoutConversionPreview, LayoutConversionSlot, ProductDetail, SizeOptionDetail } from '@/lib/types/api';
import { Swatch, Toggle } from './options-ui';
import { vsSingle } from './bom-model';
import { planningSentence, planText, whatHappens } from './convert-layout-model';

interface Props {
  product: ProductDetail;
  option: SizeOptionDetail;
  preview: LayoutConversionPreview;
  /** "Plan jobs with this plate now" */
  active: boolean;
  disabled: boolean;
  onActive: (next: boolean) => void;
}

function colourNote(s: LayoutConversionSlot): string | null {
  if (s.colour.source === 'CATALOGUE') return `colour from catalogue swatch ${s.colour.swatch ?? ''}`.trim();
  if (s.colour.source === 'NAME') return 'matched by colour name';
  return null;
}

/** Convert to plate, step 2: what will be created and what changes (the O8a preview). */
export function ConvertLayoutReview({ product, option, preview: p, active, disabled, onActive }: Props) {
  const formatCurrency = useFormatCurrency();
  const l = p.layout;
  const desc = p.component.description;
  const single = l.slots.length === 1;
  const vs = vsSingle(l.minutesPerUnit, p.component.minutesPerUnit);
  const policy = p.planning.surplusPolicy;
  const happens = whatHappens(product, option, p, formatCurrency);

  return (
    <div className="space-y-4 text-sm">
      <section className="space-y-1">
        <h3 className="font-semibold text-gray-900 dark:text-gray-100">The plate that will be created</h3>
        <p className="text-gray-800 dark:text-gray-200">
          <span className="font-medium">{desc} ×{l.unitsPerPlate}</span>
          {' · '}{formatMinutes(l.plateMinutes)} · {formatGrams(l.plateGrams)} per plate
        </p>
        <p className="text-gray-600 dark:text-gray-400">
          Per unit: {formatMinutes(l.minutesPerUnit)}, {formatGrams(l.gramsPerUnit)}{vs ? ` (${vs})` : ''}
        </p>
        <p className="break-words text-gray-600 dark:text-gray-400">
          {l.gcodeFilename
            ? `File: ${l.gcodeFilename}`
            : "No file — jobs show 'No file' for this plate; add one later under the part's Manage plate layouts"}
        </p>
      </section>

      <section className="space-y-1">
        <h4 className="font-medium text-gray-800 dark:text-gray-200">Filament per plate</h4>
        <ul className="space-y-1.5">
          {l.slots.map(s => {
            const note = colourNote(s);
            const matName = s.material?.name ?? 'No filament set';
            return (
              <li key={s.colorIndex} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-gray-700 dark:text-gray-300">
                {!single && <span className="text-gray-500 dark:text-gray-400">Colour {s.colorIndex + 1}</span>}
                <Swatch hex={s.colour.hex ?? s.material?.colorHex ?? null} title={matName} decorative />
                <span>{matName}</span>
                <span className="tabular-nums text-gray-600 dark:text-gray-400">{formatGrams(s.gramsUsed)}</span>
                {note && <span className="text-xs text-gray-500 dark:text-gray-400">({note})</span>}
                {s.tools.length > 0 && (
                  <span className="inline-flex flex-wrap items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                    from
                    {s.tools.map(t => (
                      <span key={t.index} className="inline-flex items-center gap-0.5">
                        <Swatch hex={t.colorHex} title={`T${t.index + 1}`} decorative />T{t.index + 1}
                      </span>
                    ))}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {p.warnings.length > 0 && (
        <ul className="list-disc space-y-1 rounded-md border border-amber-300 bg-amber-50 py-2 pl-7 pr-3 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
          {p.warnings.map(w => <li key={`${w.code}-${w.message}`}>{w.message}</li>)}
        </ul>
      )}

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Toggle checked={active} label="Plan jobs with this plate now" disabled={disabled} onChange={onActive} />
          <span className="font-medium text-gray-800 dark:text-gray-200">Plan jobs with this plate now</span>
        </div>
        {!active && (
          <p className="text-xs text-gray-600 dark:text-gray-400">
            It&apos;s created switched off: planning and bulk pricing ignore it until you switch it on under {desc} → Manage plate layouts.
          </p>
        )}
      </div>

      <section className="space-y-2">
        <h4 className="font-medium text-gray-800 dark:text-gray-200">Planning{active ? '' : ' (once switched on)'}</h4>
        <p className="text-gray-600 dark:text-gray-400">{planningSentence(p)}</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-xs">
            <thead>
              <tr className="border-b text-left font-medium text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <th className="py-1.5 pr-3">{desc} needed</th>
                <th className="pr-3">Now</th>
                <th className="pr-3">With ×{l.unitsPerPlate}</th>
              </tr>
            </thead>
            <tbody>
              {p.planning.rows.map(r => (
                <tr key={r.units} className="border-b last:border-0 dark:border-gray-800">
                  <td className="py-1.5 pr-3 tabular-nums">{r.units}</td>
                  <td className="pr-3 text-gray-700 dark:text-gray-300">{r.now ? planText(r.now, policy) : '—'}</td>
                  <td className="pr-3 text-gray-900 dark:text-gray-100">{planText(r.withPlate, policy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-1">
        <h4 className="font-medium text-gray-800 dark:text-gray-200">What happens</h4>
        <ul className="list-disc space-y-1 pl-5 text-gray-700 dark:text-gray-300">
          {happens.map(h => (
            <li key={h.text}>
              {h.text}
              {h.list && (
                <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto text-xs text-gray-600 dark:text-gray-400">
                  {h.list.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
