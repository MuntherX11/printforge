'use client';

import { ArrowDown, ArrowUp, Download, Package } from 'lucide-react';
import { TableCell, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { formatGrams, formatMinutes, plural } from '@/lib/product-format';
import type { ComponentDetail, MaterialLite, ProductDetail } from '@/lib/types/api';
import { LinkButton, Swatch } from './options-ui';
import { slotViews, type LinkState } from './bom-model';
import { ComponentStockCell } from './ComponentStockCell';
import type { ColourLinksFocus } from './ColourLinksDialog';

interface Props {
  product: ProductDetail;
  component: ComponentDetail;
  materials: Map<string, MaterialLite>;
  canEdit: boolean;
  isFirst: boolean;
  isLast: boolean;
  busy: boolean;
  onMove: (dir: -1 | 1) => void;
  onEdit: () => void;
  onRemove: () => void;
  onLayouts: () => void;
  onEditLinks: (focus: ColourLinksFocus) => void;
  onReload: () => void;
}

function LinkTag({ link, canEdit, onClick, part }: { link: LinkState; canEdit: boolean; onClick: () => void; part: string }) {
  const text = link.kind === 'slot' ? link.name : link.kind === 'fixed' ? 'Fixed' : 'Not linked';
  const tone = link.kind === 'unlinked'
    ? 'border-red-300 text-red-700 dark:border-red-700 dark:text-red-400'
    : 'border-gray-300 text-gray-600 dark:border-gray-600 dark:text-gray-300';
  const cls = cn('rounded border px-1.5 py-0.5 text-[11px] font-medium', tone);
  if (!canEdit) return <span className={cls}>{text}</span>;
  return (
    <button type="button" onClick={onClick} title={`Edit colour links — ${part}`} aria-label={`Colour link of ${part}: ${text}. Edit links`} className={cn(cls, 'hover:bg-gray-50 dark:hover:bg-gray-800')}>
      {text}
    </button>
  );
}

/** One bill-of-materials row (spec §5.2 D, columns 1–10). */
export function ComponentRow(props: Props) {
  const { product, component: c, materials, canEdit, busy } = props;
  const slots = slotViews(product, c);
  const hasSlots = product.colourSlots.length > 0;
  const multi = slots.length > 1;
  const activeLayouts = c.plateLayouts;

  return (
    <TableRow>
      {canEdit && (
        <TableCell className="w-14 whitespace-nowrap">
          <LinkButton title={`Move ${c.description} up`} disabled={busy || props.isFirst} onClick={() => props.onMove(-1)}><ArrowUp className="h-3.5 w-3.5" /></LinkButton>
          <LinkButton title={`Move ${c.description} down`} disabled={busy || props.isLast} onClick={() => props.onMove(1)}><ArrowDown className="h-3.5 w-3.5" /></LinkButton>
        </TableCell>
      )}
      <TableCell>
        <div className="flex items-start gap-2">
          <div className="h-8 w-8 flex-shrink-0 overflow-hidden rounded border border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-800">
            {c.thumbnailUrl ? (
              // Staff-only thumbnail route (P15) needs the session cookie.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={c.thumbnailUrl} alt="" className="h-full w-full object-contain" />
            ) : (
              <Package className="m-2 h-4 w-4 text-gray-400" aria-hidden="true" />
            )}
          </div>
          <div className="min-w-0">
            <p className="font-medium text-gray-900 dark:text-gray-100">{c.description}</p>
            {c.problems[0] && <p className="text-xs text-red-600 dark:text-red-400">{c.problems[0].message}</p>}
          </div>
        </div>
      </TableCell>
      <TableCell>
        <div className="space-y-1">
          {slots.map(s => {
            const part = multi ? `${c.description} colour ${s.colorIndex + 1}` : c.description;
            return (
              <div key={s.colorIndex} className="flex flex-wrap items-center gap-1.5 text-sm">
                <Swatch hex={s.material?.colorHex} title={s.material?.name ?? 'No filament'} />
                <span className="text-gray-800 dark:text-gray-200">{s.material?.name ?? 'No filament'}</span>
                <span className="text-xs text-gray-500 dark:text-gray-400">{formatGrams(s.grams)}</span>
                {hasSlots && (
                  <LinkTag
                    link={s.link}
                    part={part}
                    canEdit={canEdit}
                    onClick={() => props.onEditLinks({ componentId: c.id, colorIndex: s.colorIndex })}
                  />
                )}
              </div>
            );
          })}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <span className="tabular-nums">{formatGrams(c.gramsUsed)} · {formatMinutes(c.printMinutes)}</span>
        {c.perUnitEstimatedFrom && (
          <p className="text-xs text-gray-500 dark:text-gray-400">est. from ×{c.perUnitEstimatedFrom.unitsPerPlate} plate</p>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">{c.quantity}</TableCell>
      <TableCell className="whitespace-nowrap tabular-nums">
        {formatGrams(c.gramsUsed * c.quantity)} · {formatMinutes(c.printMinutes * c.quantity)}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1">
          {activeLayouts.map(l => (
            <span
              key={l.id}
              title={l.isActive ? l.name : `${l.name} (inactive)`}
              className={cn(
                'rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300',
                !l.isActive && 'line-through opacity-60',
              )}
            >
              ×{l.unitsPerPlate} · {formatMinutes(l.minutesPerUnit)}/unit
            </span>
          ))}
          {canEdit || activeLayouts.length > 0
            ? <LinkButton onClick={props.onLayouts}>{canEdit ? 'Manage' : 'View'}</LinkButton>
            : <span className="text-xs text-gray-400">Single units only</span>}
        </div>
      </TableCell>
      <TableCell>
        <ComponentStockCell productId={product.id} component={c} materials={materials} canEdit={canEdit} onReload={props.onReload} />
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {c.file ? (
          <div>
            <a href={c.file.downloadUrl} className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400" download>
              <Download className="h-3.5 w-3.5" aria-hidden="true" /> Download
            </a>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {c.colorChanges > 0 ? plural(c.colorChanges, 'colour change') : 'no colour changes'}
            </p>
          </div>
        ) : (
          <span className="text-gray-400" title="Imported without a file — re-import from a sliced 3MF or G-code">—</span>
        )}
      </TableCell>
      {canEdit && (
        <TableCell className="whitespace-nowrap text-right">
          <LinkButton onClick={props.onEdit}>Edit</LinkButton>
          <LinkButton tone="danger" onClick={props.onRemove}>Remove</LinkButton>
        </TableCell>
      )}
    </TableRow>
  );
}
