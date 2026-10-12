'use client';

import { useId } from 'react';
import { ChevronRight, Package } from 'lucide-react';
import { filamentInStock, filamentLabel, plateLinkLabel } from '@printforge/types';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatGrams, formatMinutes, plural } from '@/lib/product-format';
import type { ComponentDetail, FilamentStockRow, MaterialLite, ProductDetail } from '@/lib/types/api';
import { LinkButton, Swatch } from './options-ui';
import { componentGrams, slotViews, type LinkState } from './bom-model';
import { plateRowPrinter } from './product-layout';
import { partSliceChip, type PartSliceState } from './slice-ui';
import { ComponentStockCell } from './ComponentStockCell';
import { PlateList } from './PlateList';
import type { ColourLinksFocus } from './ColourLinksDialog';

interface Props {
  product: ProductDetail;
  component: ComponentDetail;
  materials: Map<string, MaterialLite>;
  canEdit: boolean;
  isAdmin: boolean;
  isFirst: boolean;
  isLast: boolean;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  /** Printer id → name; null until loaded. */
  printers: ReadonlyMap<string, string> | null;
  /** Changing it refetches the part's slice runs. */
  runsKey: unknown;
  /** A run of the part is queued or slicing, or its latest run failed (shown as a chip while the row is closed). */
  sliceState: PartSliceState | null;
  showCosts: boolean;
  onShowCosts: (show: boolean) => void;
  onMove: (dir: -1 | 1) => void;
  onEdit: () => void;
  onRemove: () => void;
  onLayouts: () => void;
  onEditLinks: (focus: ColourLinksFocus) => void;
  onReload: () => void;
  /** A slice run of the part was cancelled or dismissed: its chip is settled again. */
  onRunRemoved: () => void;
  /** Grams in stock per filament id (GET /materials/stock); null hides the note. */
  stock: ReadonlyMap<string, FilamentStockRow> | null;
  /** Opens the filament picker for one colour slot. */
  onPickFilament: (colorIndex: number) => void;
  /** Opens "Slice a plate" for this part. */
  onSlice: () => void;
}

function LinkTag({ link, canEdit, onClick, part }: { link: LinkState; canEdit: boolean; onClick: () => void; part: string }) {
  const text = link.kind === 'slot' ? link.name : link.kind === 'fixed' ? 'Fixed' : 'Not linked';
  const tone = link.kind === 'unlinked'
    ? 'border-red-300 text-red-700 dark:border-red-700 dark:text-red-400'
    : 'border-gray-300 text-gray-600 dark:border-gray-600 dark:text-gray-300';
  const cls = cn('rounded border px-1.5 py-0.5 text-[11px] font-medium', tone);
  if (!canEdit) return <span className={cls}>{text}</span>;
  return (
    <button type="button" onClick={onClick} title={`Edit colour links: ${part}`} aria-label={`Colour link of ${part}: ${text}. Edit links`}
      className={cn(cls, 'hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-gray-800')}>
      {text}
    </button>
  );
}

/**
 * One part of the bill of materials (spec §5.2 D). Closed, it is one line:
 * name, filament colours, grams and minutes per unit ("not sliced yet" for a
 * part made from its model whose first slice has not come back), a chip while
 * it is slicing or when its last slice failed, the plates that have a file
 * and the printed stock. Opened in place, it shows each filament with
 * Change, the source model and Slice a plate, the slice runs, the plate table,
 * the printed stock and the part's actions.
 */
export function PartRow(props: Props) {
  const { product, component: c, materials, canEdit, isAdmin, busy, open } = props;
  const bodyId = useId();
  const costsId = useId();
  const slots = slotViews(product, c);
  const hasSlots = product.colourSlots.length > 0;
  const multi = slots.length > 1;
  const grams = componentGrams(c);
  const filePlates = (c.plates ?? []).filter(r => r.file);
  const unlinked = hasSlots && slots.some(s => s.link.kind === 'unlinked');
  const names = slots.map(s => filamentLabel(s.material).primary);
  // Made from its model and not sliced yet: its grams and minutes are placeholders, never shown as figures.
  const pending = c.pendingFirstSlice === true;
  const chip = !open && props.sliceState ? partSliceChip(props.sliceState) : null;

  return (
    <li className="border-b border-gray-200 last:border-0 dark:border-gray-700">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={props.onToggle}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left text-sm hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 dark:hover:bg-gray-800/50"
      >
        <ChevronRight className={cn('h-4 w-4 flex-shrink-0 text-gray-400 motion-safe:transition-transform', open && 'rotate-90')} aria-hidden="true" />
        <span className="h-8 w-8 flex-shrink-0 overflow-hidden rounded border border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-800">
          {c.thumbnailUrl ? (
            // Staff-only thumbnail route (P15) needs the session cookie.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={c.thumbnailUrl} alt="" className="h-full w-full object-contain" />
          ) : (
            <Package className="m-2 h-4 w-4 text-gray-400" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-[1_1_9rem]">
          <span className="block break-words font-medium text-gray-900 dark:text-gray-100">
            {c.description}
            {c.quantity !== 1 && <span className="font-normal text-gray-500 dark:text-gray-400"> × {c.quantity} per product</span>}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
            {slots.map(s => (
              <Swatch key={s.colorIndex} hex={s.material?.colorHex} name={s.material ? s.material.color || s.material.name : null} title={filamentLabel(s.material).primary} />
            ))}
            <span>{names.join(', ')}</span>
          </span>
          {c.problems[0] && <span className="block text-xs text-red-600 dark:text-red-400">{c.problems[0].message}</span>}
          {unlinked && <span className="block text-xs text-red-600 dark:text-red-400">A colour is not linked</span>}
        </span>
        {pending
          ? <span className="whitespace-nowrap text-gray-600 dark:text-gray-400">not sliced yet</span>
          : <span className="whitespace-nowrap font-mono tabular-nums text-gray-900 dark:text-gray-100">{formatGrams(grams)} · {formatMinutes(c.printMinutes)}</span>}
        {chip && <Badge variant={chip.variant}>{chip.text}</Badge>}
        {filePlates.length > 0 && (
          <span className="flex flex-wrap gap-1">
            {filePlates.map(r => (
              <span key={r.layoutId ?? 'own'} className="whitespace-nowrap rounded-full border border-gray-200 px-2 py-0.5 text-xs text-gray-700 dark:border-gray-700 dark:text-gray-300">
                ×{r.unitsPerPlate}{plateRowPrinter(r, c, props.printers) ? ` ${plateRowPrinter(r, c, props.printers)}` : ''}
              </span>
            ))}
          </span>
        )}
        <span className="whitespace-nowrap font-mono tabular-nums text-gray-600 dark:text-gray-400">
          {c.stockOnHand} in stock{!c.stockConfirmed && ' (check)'}
        </span>
      </button>

      {open && (
        <div id={bodyId} className="space-y-4 px-3 pb-4 sm:pl-11">
          <ul className="space-y-1">
            {slots.map(s => {
              const part = multi ? `${c.description} colour ${s.colorIndex + 1}` : c.description;
              // Colour first, the name only when it differs (as the Filaments list and the picker).
              const label = filamentLabel(s.material);
              const stockRow = s.material ? props.stock?.get(s.material.id) : undefined;
              return (
                <li key={s.colorIndex} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <Swatch hex={s.material?.colorHex} name={s.material ? s.material.color || s.material.name : null} title={label.primary} />
                  <span className="text-gray-800 dark:text-gray-200">{label.primary}</span>
                  {label.secondary && <span className="text-xs text-gray-500 dark:text-gray-400">{label.secondary}</span>}
                  {!pending && <span className="font-mono tabular-nums text-gray-900 dark:text-gray-100">{formatGrams(s.grams)}</span>}
                  {canEdit && stockRow && (filamentInStock(stockRow)
                    ? <span className="text-xs text-gray-500 dark:text-gray-400">{formatGrams(stockRow.totalStock)} in stock</span>
                    : <span className="text-xs font-medium text-amber-700 dark:text-amber-300">Out of stock</span>)}
                  {hasSlots && (
                    <LinkTag link={s.link} part={part} canEdit={canEdit}
                      onClick={() => props.onEditLinks({ componentId: c.id, colorIndex: s.colorIndex })} />
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => props.onPickFilament(s.colorIndex)}
                      aria-label={`Filament of ${part}: ${label.text}${pending ? '' : `, ${formatGrams(s.grams)} per unit`}. Change filament`}
                      aria-haspopup="dialog"
                      className="rounded px-1.5 py-1 text-xs font-medium text-brand-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-brand-400"
                    >
                      Change
                    </button>
                  )}
                </li>
              );
            })}
          </ul>

          <PlateList productId={product.id} component={c} canEdit={canEdit} isAdmin={isAdmin} printers={props.printers}
            runsKey={props.runsKey} showCosts={props.showCosts} onChanged={props.onReload} onRunRemoved={props.onRunRemoved} onSlice={props.onSlice} />

          <div className="flex flex-wrap items-start gap-x-6 gap-y-2 text-sm">
            <div className="flex flex-wrap items-start gap-2">
              <span className="pt-1.5 text-gray-500 dark:text-gray-400">Printed stock</span>
              <ComponentStockCell productId={product.id} component={c} materials={materials} canEdit={canEdit} onReload={props.onReload} />
            </div>
            <p className="flex flex-wrap gap-x-4 gap-y-1 pt-1.5 text-xs text-gray-500 dark:text-gray-400">
              {c.perUnitEstimatedFrom && <span>Per unit estimated from the ×{c.perUnitEstimatedFrom.unitsPerPlate} plate</span>}
              {pending && <span>Weight and print time come from the first slice</span>}
              {c.quantity !== 1 && !pending && (
                <span>
                  Per product: <span className="font-mono tabular-nums">{formatGrams(grams * c.quantity)} · {formatMinutes(c.printMinutes * c.quantity)}</span>
                </span>
              )}
              {c.file ? (
                <span>{c.colorChanges > 0 ? plural(c.colorChanges, 'colour change') : 'No colour changes'}</span>
              ) : (
                <span title="Imported without a file. Re-import from a sliced 3MF or G-code">No ×1 file</span>
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {(c.plates ?? []).length > 0 && (
              <label htmlFor={costsId} className="inline-flex cursor-pointer items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                <input id={costsId} type="checkbox" checked={props.showCosts} onChange={e => props.onShowCosts(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" />
                Show costs per plate
              </label>
            )}
            <span className="ml-auto flex flex-wrap items-center gap-x-1">
              {canEdit && (
                <LinkButton title={`${plateLinkLabel(c.plateLayouts)}: ${c.description}`} onClick={props.onLayouts}>{plateLinkLabel(c.plateLayouts)}</LinkButton>
              )}
              {canEdit || c.plateLayouts.length > 0
                ? <LinkButton title={`${canEdit ? 'Manage' : 'View'} the plates of ${c.description}`} onClick={props.onLayouts}>{canEdit ? 'Manage' : 'View plates'}</LinkButton>
                : <span className="px-1.5 text-xs text-gray-500 dark:text-gray-400">Single units only</span>}
              {canEdit && (
                <>
                  <LinkButton title={`Move ${c.description} up`} disabled={busy || props.isFirst} onClick={() => props.onMove(-1)}>Move up</LinkButton>
                  <LinkButton title={`Move ${c.description} down`} disabled={busy || props.isLast} onClick={() => props.onMove(1)}>Move down</LinkButton>
                  <LinkButton title={`Edit ${c.description}`} onClick={props.onEdit}>Edit</LinkButton>
                  <LinkButton tone="danger" title={`Remove ${c.description}`} onClick={props.onRemove}>Remove</LinkButton>
                </>
              )}
            </span>
          </div>
        </div>
      )}
    </li>
  );
}
