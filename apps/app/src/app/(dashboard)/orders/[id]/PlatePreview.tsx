'use client';

import type { OrderPlatePreviewDto } from '@printforge/types';
import { cn } from '@/lib/utils';
import { OTHER_FILL, drawableBed, gridLines, outlinePoints, type LegendEntry } from './print-plan-model';

interface Props {
  /** Null: no footprint is known for any part on the plate. */
  preview: OrderPlatePreviewDto | null;
  /** One entry per part on the plate, with its colour. */
  legend: LegendEntry[];
  /** The plate's name, for screen readers. */
  label: string;
  /** Shown under the legend (the plate's numbers and controls). */
  children?: React.ReactNode;
}

const BOX = 'w-full max-w-[220px]';

/**
 * A top-down drawing of one plate: the bed with a light 50 mm grid, every
 * object in the colour of its part, the front of the bed at the bottom. Before
 * slicing it is a sketch (dashed outlines, said so underneath); units that did
 * not fit the sketch are counted in a note. The legend names each part and
 * its units; on a wide screen it sits beside the drawing.
 */
export function PlatePreview({ preview, legend, label, children }: Props) {
  const bed = preview && drawableBed(preview.bed) ? preview.bed : null;
  const fillOf = (rowKey: string | null) => legend.find(l => l.rowKey === rowKey) ?? null;
  const others = !!preview && preview.objects.some(o => !fillOf(o.rowKey));

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:gap-5">
      <div className="space-y-2 sm:w-[220px] sm:flex-shrink-0">
      {preview && bed ? (
        <figure className={BOX}>
          <svg
            viewBox={`0 0 ${bed.x} ${bed.y}`}
            role="img"
            aria-label={`Top-down drawing of ${label}${preview.exact ? '' : ' (approximate)'}`}
            className="block h-auto w-full rounded border border-gray-300 bg-gray-50 dark:border-gray-600 dark:bg-gray-800"
          >
            <g className="stroke-gray-200 dark:stroke-gray-700" strokeWidth={1}>
              {gridLines(bed.x).map(x => <line key={`x${x}`} x1={x} y1={0} x2={x} y2={bed.y} vectorEffect="non-scaling-stroke" />)}
              {gridLines(bed.y).map(y => <line key={`y${y}`} x1={0} y1={bed.y - y} x2={bed.x} y2={bed.y - y} vectorEffect="non-scaling-stroke" />)}
            </g>
            {preview.objects.map((o, i) => {
              const points = outlinePoints(o.polygon, bed.y);
              if (!points) return null;
              const entry = fillOf(o.rowKey);
              return (
                <polygon
                  key={i}
                  points={points}
                  className={(entry?.fill ?? OTHER_FILL).shape}
                  strokeWidth={1.25}
                  strokeLinejoin="round"
                  strokeDasharray={preview.exact ? undefined : '4 3'}
                  vectorEffect="non-scaling-stroke"
                >
                  <title>{entry?.title ?? 'Other object'}</title>
                </polygon>
              );
            })}
          </svg>
          <figcaption className="mt-0.5 text-center text-[11px] leading-tight text-gray-500 dark:text-gray-400">front</figcaption>
        </figure>
      ) : (
        <div className={cn(BOX, 'flex aspect-square items-center justify-center rounded border border-dashed border-gray-300 text-xs text-gray-500 dark:border-gray-600 dark:text-gray-400')}>
          No drawing yet
        </div>
      )}

      {preview && bed && !preview.exact && (
        <p className="text-xs text-gray-500 dark:text-gray-400">Approximate layout — sliced plate may differ</p>
      )}
      {preview && preview.overflow > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          {preview.overflow} more {preview.overflow === 1 ? 'unit does' : 'units do'} not fit this drawing — the plate is probably too full.
        </p>
      )}

      </div>

      <div className="min-w-0 flex-1 space-y-3">
      <ul className="space-y-1 text-sm">
        {legend.map(l => (
          <li key={l.rowKey} className="flex items-start gap-2">
            <span aria-hidden="true" className={cn('mt-1 h-3 w-3 flex-shrink-0 rounded-sm border', l.fill.swatch)} />
            <span className="min-w-0 flex-1 break-words">
              <span className="font-medium text-gray-800 dark:text-gray-200">{l.title}</span>
              {l.sub && <span className="text-xs text-gray-500 dark:text-gray-400"> · {l.sub}</span>}
            </span>
            <span className="flex-shrink-0 whitespace-nowrap font-mono text-sm tabular-nums text-gray-700 dark:text-gray-300">{l.units}</span>
          </li>
        ))}
        {others && (
          <li className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <span aria-hidden="true" className={cn('h-3 w-3 flex-shrink-0 rounded-sm border', OTHER_FILL.swatch)} /> Other objects on the plate
          </li>
        )}
      </ul>
      {children}
      </div>
    </div>
  );
}
